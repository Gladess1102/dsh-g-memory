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
 * A memory-shaped sentence, over the 60-character content floor.
 *
 * The floor is not cosmetic here: `selectForInjection`/`selectByPolicy` drop anything
 * shorter as a fragment before the score is even read, so a fixture like `unit 0`
 * measures the content filter instead of the rule the check is about — it made
 * seven of these checks fail with "nothing was injectable content (too-short×4)".
 */
const LONG = '重排服务空闲 300 秒就释放模型，所以冷启动要三到六秒；机器重启后的第一次调用实测出现过五十六秒，最坏的一次等了一百八十秒才加载完成。';

/**
 * A card candidate on the degraded path (no reranker).
 *
 * The text is long for the same reason as `LONG`. The similarity defaults to a value
 * that clears the *relative* card rule: a card must reach 0.68 and lead the next card
 * by 0.02 — see `pickDegradedCards` in lib/quality.mjs and the sweep in
 * scripts/eval-card-gate.mjs.
 */
const CARD_TEXT = '重排服务的常驻卡：空闲三百秒释放模型，冷启动要三到六秒，机器重启后的第一次调用实测到过五十六秒，这是一张已经定稿的策展卡片。';
const cardFixture = (overrides = {}) => ({
  text: CARD_TEXT, score: 0, similarity: 0.74, source: 'card', time: Date.now() - 86_400_000, seq: null, ...overrides,
});

/**
 * Entries as the reranker hands them over: score on the cross-encoder scale.
 *
 * Aged deliberately. The default policy's recent tier (age ≤ 0 days) is ungated
 * by design — `recentGate` is -Infinity — so entries stamped "now" bypass the
 * floor entirely and a test written that way measures nothing. 30 days puts them
 * in the long-term tier, where the floor is `gate` and the arithmetic is plain.
 */
const entries = (scores, ageDays = 30) => scores.map((score, i) => ({
  text: `${LONG}（第 ${i} 条）`, score, time: Date.now() - ageDays * 86_400_000, seq: i,
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

await check('an empty recall names the gate that emptied it', () => {
  // Two empty pools, two different repairs. The reason used to blame the age floor
  // unconditionally, so a pool the content filter had emptied was logged as "no
  // entry cleared its age tier's floor" — 23 recorded turns sent an operator (and
  // this suite's author) to a threshold that had never been consulted. The value
  // stays in the string because existing greps read it.
  const floors = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor(), marginGate: 0 };
  const aged = () => ({ text: `${LONG}（第 0 条）`, score: 0, time: Date.now() - 30 * 86_400_000 });

  const content = selectByPolicy([
    { text: '一段短文本', score: 4.2 },
    { text: '另一段短文本', score: 4.1 },
    aged(),
  ], { policy: floors });
  assert.equal(content.selected.length, 0);
  assert.deepEqual(content.droppedReasons, { 'too-short': 2 });
  assert.match(content.reason, /^content filter dropped 2 candidate\(s\) \(too-short×2\): nothing left cleared the floor/,
    'the content filter is the cause, so it is named first');
  assert.match(content.reason, /long-term floor/, 'the floor value stays in the text for existing greps');

  const floor = selectByPolicy([aged()], { policy: floors });
  assert.equal(floor.selected.length, 0);
  assert.deepEqual(floor.droppedReasons, {}, 'nothing here was dropped for its content');
  assert.match(floor.reason, /^no entry cleared its age tier's floor \(long-term floor/, 'an empty pool with no content drops keeps the floor wording');
  assert.doesNotMatch(floor.reason, /content filter/);

  assert.deepEqual(Object.keys(floor).sort(), ['dropped', 'droppedReasons', 'reason', 'selected', 'tier'],
    'the return shape is unchanged: auto-recall reads these fields');
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
  //
  // The rule is relative now: at most ONE card, above 0.68, and leading the next by
  // 0.02. The old absolute 0.35 floor was re-measured on 2026-10-24 and is nearly
  // always true in the current embedding space (8 of 8 random tokens cleared it).
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  const degraded = selectByPolicy(
    [cardFixture({ similarity: 0.74 }), cardFixture({ similarity: 0.70 })],
    { policy: degradedPolicy, reranked: false },
  );
  assert.equal(degraded.selected.length, 1, 'one leading card is admitted');
  assert.equal(degraded.selected[0].similarity, 0.74, 'and it is the leading one');
  assert.equal(degraded.selected[0].unverified, true, 'nothing on this path compared it with the question');
  const dropped = selectByPolicy([cardFixture()], { policy: degradedPolicy, reranked: true });
  assert.equal(dropped.selected.length, 0, 'without the card rule a score of 0 cannot clear the floor');
});

await check('a card below the similarity floor is still rejected', async () => {
  // 0.62 sits in the band measured for unrelated queries on EmbeddingGemma 2 (the
  // cosine lower bound over the corpus is about 0.58), which the old 0.35 floor
  // admitted every time.
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  const out = selectByPolicy([cardFixture({ similarity: 0.62 })], { policy: degradedPolicy, reranked: false });
  assert.equal(out.selected.length, 0);
  assert.equal(out.droppedReasons['card-low-similarity'], 1, 'the reason names the floor, not the margin');
});

await check('an unrelated query\'s top cards are interchangeable and admit none', async () => {
  // The negative sample this rule exists for: both cards look "similar enough", and
  // the query has no card at all. Measured, that is what an unrelated query returns —
  // top cards within noise of each other — and it is what the absolute floor could
  // not express. No reranker involved, so this runs without the 11436 endpoint.
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  const out = selectByPolicy(
    [cardFixture({ similarity: 0.90 }), cardFixture({ similarity: 0.89 })],
    { policy: degradedPolicy, reranked: false },
  );
  assert.equal(out.selected.length, 0, 'a coin-flip between two cards is not a memory');
  assert.equal(out.droppedReasons['card-margin'], 2);
  // And the tool path, which applies the same rule, agrees.
  const tool = selectForInjection(
    [cardFixture({ similarity: 0.90 }), cardFixture({ similarity: 0.89 })],
    { minScore: 1 / 61, reranked: false },
  );
  assert.equal(tool.selected.length, 0);
});

await check('the card rule does not loosen anything else', async () => {
  // The same shape without `source: 'card'` must still be dropped by the floor:
  // a zero score on an index fragment means the arms found nothing.
  const fragment = { text: CARD_TEXT, score: 0, similarity: 0.99, time: Date.now() - 86_400_000, seq: 1 };
  const degradedPolicy = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor() };
  assert.equal(selectByPolicy([fragment], { policy: degradedPolicy, reranked: false }).selected.length, 0);
});

await check('the tool path applies the same card rule', async () => {
  const floor = 1 / 61;
  // With a reranker the card competes like any other entry: its cross-encoder score
  // is what the gate reads, and the marginal similarity is irrelevant.
  assert.equal(selectForInjection([cardFixture({ similarity: 0.99, score: 4.2 })], { minScore: 0, reranked: true }).selected.length, 1);
  const degraded = selectForInjection(
    [cardFixture({ similarity: 0.74 }), cardFixture({ similarity: 0.70 })],
    { minScore: floor, reranked: false },
  );
  assert.equal(degraded.selected.length, 1, 'at most one card without a reranker');
  assert.equal(degraded.selected[0].unverified, true);
  const weak = selectForInjection([cardFixture({ similarity: 0.62 })], { minScore: floor, reranked: false });
  assert.equal(weak.selected.length, 0, 'the floor applies on both paths');
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
