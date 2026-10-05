#!/usr/bin/env node
/**
 * Policy unit checks: the head-margin gate, and the overrides that were ignored.
 *
 * These are pure functions, so they are tested as such — no index, no server, no
 * plugin. The end-to-end wiring (composition config → AutoRecall → policy) is
 * covered by `scripts/test-e2e-hermetic.mjs`, which is the split that would have
 * caught the original defect: the rule was fine, the configuration never arrived.
 *
 *   node scripts/test-policy.mjs
 */
import assert from 'node:assert/strict';
import { resolvePolicy, selectByPolicy } from '../lib/policy.mjs';
import { needsSynthesis } from '../lib/policy.mjs';
import { clipForRerank, resolveRerankConfig } from '../lib/rerank.mjs';
import { renderRecall, selectForInjection, INJECTION_MIN_TOTAL_CHARS, INJECTION_FRAME_CHARS } from '../lib/inject.mjs';
import { rrfFloor } from '../lib/store.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/**
 * Entries as the reranker hands them over: score on the cross-encoder scale.
 *
 * Aged deliberately. The default policy's recent tier (age ≤ 0 days) is ungated
 * by design — `recentGate` is -Infinity — so entries stamped "now" bypass the
 * floor entirely and a test written that way measures nothing. 30 days puts them
 * in the long-term tier, where the floor is `gate` and the arithmetic is plain.
 */
const entries = (scores, ageDays = 30) => scores.map((score, i) => ({
  text: `unit ${i}`, score, time: Date.now() - ageDays * 86_400_000, seq: i,
}));
const run = (scores, policy) => selectByPolicy(entries(scores), { policy });

await check('margin is not applied when it is off (the default)', async () => {
  const out = run([0.5, 0.4, 0.3, 0.2], { marginGate: 0 });
  assert.ok(out.selected.length > 0, 'a disabled margin must not filter');
});

await check('a decisive head is admitted when the margin is on', async () => {
  // 5.0 − 3.4 = 1.6 ≥ 1.18
  const out = run([5.0, 4.2, 3.4, 1.0], { marginGate: 1.18 });
  assert.ok(out.selected.length > 0, 'a separated head should be injected');
  assert.equal(out.selected[0].score, 5.0, 'the winner stays at the head');
});

await check('a flat head is rejected when the margin is on', async () => {
  // 5.0 − 4.8 = 0.2 < 1.18
  const out = run([5.0, 4.9, 4.8, 4.7], { marginGate: 1.18 });
  assert.equal(out.selected.length, 0, 'an indistinguishable head must not be injected');
  assert.match(out.reason, /head margin/);
});

await check('a flat head is rejected even though every candidate clears the floor', async () => {
  // The case the score floor cannot express: all four are "relevant" by the
  // cross-encoder's own boundary, and their ordering among themselves is noise.
  const out = run([3.0, 2.9, 2.85, 2.8], { marginGate: 1.18, gate: 0 });
  assert.equal(out.selected.length, 0);
});

await check('the margin is skipped when fewer than three candidates were scored', async () => {
  const out = run([5.0, 4.9], { marginGate: 1.18 });
  assert.equal(out.selected.length, 2, 'an undefined margin must not be read as a small one');
});

await check('the head is measured before the floor, not after it', async () => {
  // Only one candidate clears the floor (gate 0), and the head is far above the
  // rest: the margin has no reason to veto it.
  const out = run([5.0, -1.0, -1.2], { marginGate: 1.18, gate: 0 });
  assert.equal(out.selected.length, 1);
  assert.equal(out.selected[0].score, 5.0);
});

await check('resolvePolicy applies composition overrides', async () => {
  const p = resolvePolicy({ marginGate: 1.18, maxEntries: 5, gate: 2.5, mode: 'tools' });
  assert.equal(p.marginGate, 1.18);
  assert.equal(p.maxEntries, 5);
  assert.equal(p.gate, 2.5);
  assert.equal(p.mode, 'tools');
});

await check('resolvePolicy drops invalid overrides instead of coercing them', async () => {
  const p = resolvePolicy({ marginGate: 'not a number', maxEntries: 99, mode: 'nonsense', gate: Number.NaN });
  const d = resolvePolicy();
  assert.equal(p.marginGate, d.marginGate, 'a malformed threshold must fall back to the default');
  assert.equal(p.maxEntries, d.maxEntries, 'an out-of-range cap must fall back to the default');
  assert.equal(p.mode, d.mode);
  assert.equal(p.gate, d.gate);
});

await check('resolvePolicy ignores unknown keys', async () => {
  const p = resolvePolicy({ notAField: 1 });
  assert.equal(Object.hasOwn(p, 'notAField'), false);
});

await check('the reranker reads a clipped document, the caller keeps the whole one', async () => {
  // Measured: clipping to 300 chars improved top-1 (50/60 vs 49/60) and cut the call
  // from 4.1 s to 1.5 s, which is what keeps a concurrent recall inside its timeout.
  const long = 'x'.repeat(1000);
  const docs = [long, 'short'];
  const clipped = clipForRerank(docs, 300);
  assert.equal(clipped[0].length, 300);
  assert.equal(clipped[1], 'short', 'short documents are untouched');
  assert.equal(docs[0].length, 1000, 'the original must not be mutated');
  assert.deepEqual(clipForRerank(docs, 0), docs, '0 disables clipping');
  assert.equal(resolveRerankConfig().maxChars, 300, 'the default is the measured value');
});

await check('synthesis runs only when the entries must be assembled', async () => {
  // Measured on 134 labelled cases: the answer was already in the top entry alone
  // for 103 of the 111 recalls that contained it at all (92.8%). Synthesising those
  // replaces verbatim, checkable text with a 2B model's prose — so a clear leader
  // means no synthesis, and only a close-packed set triggers it.
  const clear = [{ score: 6.2 }, { score: 4.0 }, { score: 3.9 }];
  const packed = [{ score: 5.1 }, { score: 5.0 }, { score: 4.9 }];
  assert.equal(needsSynthesis(clear), false, 'a clear leader needs no model');
  assert.equal(needsSynthesis(packed), true, 'a close-packed set may need assembly');
  assert.equal(needsSynthesis([{ score: 9 }]), false, 'a single entry has nothing to assemble');
  assert.equal(needsSynthesis([]), false);
  assert.equal(needsSynthesis(clear, { ...resolvePolicy(), synthesisMargin: 0 }), false,
    'margin 0 disables synthesis entirely');
  assert.equal(needsSynthesis(packed, { ...resolvePolicy(), synthesisMargin: 0 }), false);
});

await check('a synthesised answer is not labelled a verbatim excerpt', async () => {
  // The tool path returns the model's prose when synthesis is configured, and that
  // entry used to fall through to the "transcript excerpt" label — whose footer
  // tells the model the text is verbatim and checkable against a source. Generated
  // prose is neither, and the whole point of the label is to say so.
  const entry = { source: 'synthesis', text: '根据记忆片段，答案是 768 维。', time: Date.now(), score: 1 };
  const rendered = renderRecall([entry]);
  assert.match(rendered, /synthesized answer, may be lossy/);
  assert.doesNotMatch(rendered, /\(transcript excerpt, /);
  assert.match(rendered, /"synthesized answer"\s*\n?\s*was written by a model/);
});

await check('an authored change is labelled as history, not as transcript prose', async () => {
  // An `action` unit is a `write`/`edit` tool call kept verbatim. It is verbatim,
  // but it is not the file's current content: the file may have been rewritten or
  // deleted since. Under the generic "transcript excerpt" label a model is free to
  // read `+ const x = 1` as "the file contains x = 1" — a wrong memory, and this
  // plugin treats a wrong memory as worse than a missing one.
  const entry = {
    role: 'action',
    text: '[write] /tmp/a.mjs\n+ export const CHUNK_CHARS = 800;',
    time: Date.now() - 3_600_000,
  };
  const rendered = renderRecall([entry]);
  assert.match(rendered, /authored change, verbatim — the file may have changed since/);
  assert.match(rendered, /"authored change"\s*\n?\s*is a tool call/, 'the footer must define the label it uses');

  // Both facts survive together: an orphaned action unit is still an authored
  // change. The orphan branch used to come first and would have said "transcript
  // excerpt" about a tool call.
  const orphan = renderRecall([{ ...entry, orphaned: true }]);
  assert.match(orphan, /authored change/);
  assert.match(orphan, /unverifiable \(source deleted\)/);

  // And a plain excerpt must not pick up the new label.
  assert.match(renderRecall([{ role: 'user', text: '一段对话' }]), /\(transcript excerpt, /);
});

await check('a card is judged by its own similarity when there is no reranker', async () => {
  // Cards enter the pool with score 0 (they are not RRF hits), so the floor rejects
  // every one — the layer that survives a deleted transcript was unreachable
  // exactly when the reranker was unavailable.
  const card = { text: '一张卡片', score: 0, similarity: 0.44, source: 'card', time: Date.now() - 86_400_000, seq: null };
  // The degraded branch the automatic path builds: every tier pinned to the RRF floor.
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  const degraded = selectByPolicy([card], { policy: degradedPolicy, reranked: false });
  assert.equal(degraded.selected.length, 1, 'the card cleared its own pre-filter and must be admitted');
  const dropped = selectByPolicy([{ ...card }], { policy: degradedPolicy, reranked: true });
  assert.equal(dropped.selected.length, 0, 'without the card rule a score of 0 cannot clear the floor');
});

await check('a card below the similarity floor is still rejected', async () => {
  const card = { text: '一张勉强相关的卡片', score: 0, similarity: 0.2, source: 'card', time: Date.now() - 86_400_000, seq: null };
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  assert.equal(selectByPolicy([card], { policy: degradedPolicy, reranked: false }).selected.length, 0);
});

await check('the card rule does not loosen anything else', async () => {
  // The same shape without `source: 'card'` must still be dropped by the floor:
  // a zero score on an index fragment means the arms found nothing.
  const fragment = { text: '一个片段', score: 0, similarity: 0.99, time: Date.now() - 86_400_000, seq: 1 };
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  assert.equal(selectByPolicy([fragment], { policy: degradedPolicy, reranked: false }).selected.length, 0);
});

await check('the tool path applies the same card rule', async () => {
  const card = { text: '一张卡片', score: 0, similarity: 0.44, source: 'card', time: Date.now() - 86_400_000, seq: null };
  const floor = 1 / 61;
  assert.equal(selectForInjection([card], { minScore: floor, reranked: true }).selected.length, 0);
  assert.equal(selectForInjection([card], { minScore: floor, reranked: false, cardMinSimilarity: 0.35 }).selected.length, 1);
  const weak = { ...card, similarity: 0.1 };
  assert.equal(selectForInjection([weak], { minScore: floor, reranked: false, cardMinSimilarity: 0.35 }).selected.length, 0);
});

await check('a budget at the floor still delivers a memory', async () => {
  // Below the frame size the renderer returns '' — indistinguishable from "there
  // was nothing to say", which is why the configuration layer refuses to go that
  // low. At the floor it must actually produce a block.
  const entry = { text: '一段记忆内容', time: Date.now() - 86_400_000, session: 'session-abcdef', seq: 3 };
  const out = renderRecall([entry], { maxTotalChars: INJECTION_MIN_TOTAL_CHARS });
  assert.ok(out.length > 0, 'the smallest allowed budget must not silently disable injection');
  assert.ok(out.length <= INJECTION_MIN_TOTAL_CHARS);
  assert.ok(out.includes('一段记忆内容'), 'and it must carry the memory, not just the frame');
});

await check('the frame is what the floor was derived from', async () => {
  const entry = { text: 'x', time: Date.now() - 86_400_000, session: 's', seq: 1 };
  assert.equal(renderRecall([entry], { maxTotalChars: INJECTION_FRAME_CHARS + 44 }), '',
    'a budget that cannot hold the frame and a provenance prefix must yield nothing');
  assert.ok(renderRecall([entry], { maxTotalChars: INJECTION_MIN_TOTAL_CHARS }) !== '');
});

await check('the rendered block never exceeds its budget', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({
    text: '内容'.repeat(30), time: Date.now() - 86_400_000, session: 'session-abcdef', seq: i,
  }));
  for (const budget of [INJECTION_MIN_TOTAL_CHARS, 900, 1200, 2000]) {
    const out = renderRecall(entries, { maxTotalChars: budget });
    assert.ok(out.length <= budget, `budget ${budget} produced ${out.length}`);
  }
});

await check('no configuration path can set a budget below the floor', async () => {
  // Environment values are clamped...
  process.env.DSH_G_MEMORY_MAX_TOTAL_CHARS = '300';
  try {
    assert.equal(resolvePolicy().maxTotalChars, INJECTION_MIN_TOTAL_CHARS, 'env below the floor is clamped up');
  } finally { delete process.env.DSH_G_MEMORY_MAX_TOTAL_CHARS; }
  // ...and a composition value that cannot be honoured falls back to the default,
  // which is also above the floor. Either way the result can carry a memory.
  const fromComposition = resolvePolicy({ maxTotalChars: 300 }).maxTotalChars;
  assert.ok(fromComposition >= INJECTION_MIN_TOTAL_CHARS, `composition yielded ${fromComposition}`);
});

await check('the environment default leaves the margin off', async () => {
  assert.equal(resolvePolicy().marginGate, 0, 'enabling this must be a deliberate act');
});

console.log(failures === 0
  ? '\n  policy: all checks passed\n'
  : `\n  policy: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
