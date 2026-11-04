#!/usr/bin/env node
/**
 * Quality gates: the content filter, the degraded card rule, and local time.
 *
 * Pure predicates, plus one integration pass through `selectForInjection` — no
 * index, no embedder, no reranker, so this runs anywhere. The negatives are the
 * shapes measured in the 2026-10-24 review: a `run_code` JSON fragment injected into
 * a live session, entries under the content floor (23-27% of injected entries), and
 * entries clipped mid-sentence at the preview cap (57-68% of blocks). The length rule
 * was recalibrated on 2026-10-25 — CJK-weighted, and exempt for user turns — which is
 * why the floor cases below are written in both scripts.
 *
 *   node scripts/test-quality.mjs
 */
import assert from 'node:assert/strict';
import { QUALITY_LIMITS, contentRejectReason, pickDegradedCards, formatLocalTime, weightedLength } from '../lib/quality.mjs';
import { selectForInjection, renderRecall, INJECTION_LIMITS } from '../lib/inject.mjs';
import { selectByPolicy } from '../lib/policy.mjs';
import { rrfFloor } from '../lib/store.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/** A memory-shaped sentence, long enough to be content under any threshold here. */
const LONG = '重排服务 11436 是按需守护：空闲 300 秒释放模型，所以冷启动要 3 到 6 秒，机器重启后实测出现过 56 秒甚至 180 秒。';
/** A tool result as `run_code` returns it — the incident this filter exists to stop. */
const TOOL_JSON = JSON.stringify({
  callId: 'call_9f2c7a41b6e3',
  type: 'tool_call',
  arguments: { command: 'node scripts/test-policy.mjs', timeoutMs: 120000 },
  result: LONG,
});
/** The same arguments quoted inside prose, which is why the marker test exists. */
const TOOL_IN_PROSE = `这次工具返回的内容是 ${LONG} 并且带上 \"callId\": \"call_9f2c7a41b6e3\" 和 \"arguments\": {\"timeoutMs\":120000} 两个字段。`;

const ok = (entry) => contentRejectReason(entry) === null;

await check('a memory-shaped entry is accepted', () => {
  assert.equal(contentRejectReason({ text: LONG }), null);
  assert.equal(contentRejectReason({ text: LONG.repeat(3) }), null, 'nothing here rejects a long memory');
});

await check('a fragment is rejected as too-short', () => {
  assert.equal(contentRejectReason({ text: '一段短文本' }), 'too-short');
  assert.equal(contentRejectReason({ text: '   ' }), 'too-short');
  assert.equal(contentRejectReason({ text: 'x'.repeat(QUALITY_LIMITS.minContentChars - 1) }), 'too-short');
  assert.equal(contentRejectReason({ text: 'x'.repeat(QUALITY_LIMITS.minContentChars) }), null,
    'the threshold itself is content, not a fragment');
});

/** A 30-character Chinese sentence: exactly 60 in Latin-character equivalents. */
const CJK_EDGE = '把工作台的前端和后端都完整审查一次，修掉发现的全部缺陷并复核';

await check('length is weighted by what a CJK character carries', () => {
  // The floor was calibrated on Latin text and compared against a raw character
  // count, so its default of 60 meant 60 Chinese characters — roughly twice the
  // information it was chosen for. Measured on 2026-10-25 over 97 real queries
  // (1046 candidates): 137 entries were dropped as too-short, 16 of them their
  // pool's highest-scored candidate, and what they were was whole short Chinese
  // sentences (p50 32 characters), not the paths and log lines the rule was
  // written for — the index layer had already filtered those.
  assert.equal(weightedLength(CJK_EDGE), QUALITY_LIMITS.minContentChars, '30 CJK characters = 60 Latin ones');
  assert.equal(weightedLength(CJK_EDGE.slice(0, -1)), QUALITY_LIMITS.minContentChars - 2);
  assert.equal(contentRejectReason({ text: CJK_EDGE }), null, 'a 30-character Chinese sentence is content');
  assert.equal(contentRejectReason({ text: CJK_EDGE.slice(0, -1) }), 'too-short', 'one character less is not');
  assert.equal(weightedLength('x'.repeat(60)), 60, 'Latin text is unchanged: one character, one unit');
  assert.equal(contentRejectReason({ text: 'x'.repeat(59) }), 'too-short', '59 Latin characters are a fragment');
  assert.equal(weightedLength('一段短文本'), 10, 'the weighting does not make a 5-character fragment content');
  assert.equal(contentRejectReason({ text: '一段短文本' }), 'too-short');
});

await check('a user message is exempt from the length rule, and only from it', () => {
  // A user turn is context or a preference, not an answer: a short one is still the
  // whole turn. "不需要节省时间与token资源，完成这个项目更加重要" is 26 characters
  // and carried a decision that governed a whole session.
  const said = '不需要节省时间与token资源，完成这个项目更加重要。';
  assert.ok(weightedLength(said) < QUALITY_LIMITS.minContentChars, 'the fixture must be short by the weighted rule');
  assert.equal(contentRejectReason({ text: said }), 'too-short', 'without a role it is still a fragment');
  assert.equal(contentRejectReason({ text: said, role: 'user' }), null, 'a user turn is context');
  assert.equal(contentRejectReason({ text: said, role: 'assistant' }), 'too-short', 'an answer must stand alone');
  // The shape rules are not exempt: they say what the text *is*, not how long it is.
  assert.equal(contentRejectReason({ text: '{"callId": "call_9f2c7a41b6e3"}', role: 'user' }), 'json');
  assert.equal(contentRejectReason({ text: '见下 "arguments": {"timeoutMs":120000}', role: 'user' }), 'tool-fragment');
  assert.equal(contentRejectReason({ text: '/Users/someone/.dsh/local-keep/x.mjs', role: 'user' }), 'path-only');
  // A leading `[` would be read as serialised JSON first (the order of the rules), so
  // the fixture starts with prose and puts the level lines below it.
  assert.equal(contentRejectReason({ text: '启动失败\n[ERROR] connect ECONNREFUSED 11436\n[ERROR] retry', role: 'user' }), 'log-dump');
  assert.equal(contentRejectReason({ text: LONG.repeat(40), role: 'user' }), 'too-long');
  assert.equal(contentRejectReason({ text: '   ', role: 'user' }), 'too-short', 'an empty turn is not context');
});

await check('the too-long ceiling is raw characters, not weighted ones', () => {
  // `maxEntryChars` bounds the injected block, and the block is counted in
  // characters: a dense entry does not get to be twice as long because each of its
  // characters carries twice as much. The weighting applies to the floor only.
  const dense = LONG.repeat(13).slice(0, 760);
  assert.equal(dense.length, 760);
  assert.ok(weightedLength(dense) > QUALITY_LIMITS.maxEntryChars,
    `the fixture must be over the ceiling once weighted; got ${weightedLength(dense)}`);
  assert.equal(contentRejectReason({ text: dense }), null, 'under the raw ceiling, so it is content');
  assert.equal(contentRejectReason({ text: dense }, { maxEntryChars: 700 }), 'too-long', 'the raw count is what the ceiling reads');
});

await check('serialised JSON is rejected as json', () => {
  assert.equal(contentRejectReason({ text: TOOL_JSON }), 'json');
  assert.equal(contentRejectReason({ text: `[\n  ${LONG}\n]` }), 'json', 'an array is JSON too');
});

await check('a tool call quoted inside prose is rejected as tool-fragment', () => {
  assert.ok(TOOL_IN_PROSE.length > 60, 'the fixture must be long enough that length is not the reason');
  assert.equal(contentRejectReason({ text: TOOL_IN_PROSE }), 'tool-fragment');
  for (const marker of ['"callId"', '"tool_calls"', '"arguments":', '"type":"tool']) {
    assert.equal(contentRejectReason({ text: `${LONG} ${marker} ${LONG}` }), 'tool-fragment', marker);
  }
});

await check('a bare path is rejected as path-only', () => {
  const path = '/Users/someone/.dsh/local-keep/dsh-g-memory/node_modules/dsh-g-memory/lib/quality.mjs';
  assert.equal(contentRejectReason({ text: path }), 'path-only');
  assert.equal(ok(`这个文件是 ${path} ，改完之后要跑测试。`), true, 'a path inside prose is a memory');
});

await check('a log dump is rejected by rule, level or consecutive timestamps', () => {
  const rule = `${LONG}\n===============\n${LONG}`;
  assert.equal(contentRejectReason({ text: rule }), 'log-dump', '=== separator');
  assert.equal(contentRejectReason({ text: `${LONG}\n[ERROR] connect ECONNREFUSED 11436\n${LONG}` }), 'log-dump', '[ERROR]');
  const stamps = ['2026-10-24 01:00:00 启动', '2026-10-24 01:00:01 重排不可用', '2026-10-24 01:00:02 降级'].join('\n');
  assert.equal(contentRejectReason({ text: stamps }), 'log-dump', 'three consecutive timestamp lines');
});

await check('a single timestamp inside prose is not a log dump', () => {
  const entry = { text: `2026-10-24 02:00 的那次排查结论是：重排超时提不回分数，所以判定层失败一律按不检索处理，随后补了 hint 兜底。` };
  assert.ok(entry.text.length > 60);
  assert.equal(contentRejectReason(entry), null);
});

await check('an oversized entry is rejected as too-long, not clipped', () => {
  const entry = { text: LONG.repeat(40) };
  assert.ok(entry.text.length > QUALITY_LIMITS.maxEntryChars);
  assert.equal(contentRejectReason(entry), 'too-long');
});

await check('the limits are configurable rather than hard-coded at the call site', () => {
  assert.equal(contentRejectReason({ text: '短句，但有十个字以上' }, { minContentChars: 5 }), null);
  assert.equal(contentRejectReason({ text: LONG }, { maxEntryChars: 40 }), 'too-long');
  assert.equal(contentRejectReason({ text: '一段短文本' }, { minContentChars: 2 }), null);
});

await check('the documented defaults are the shipped ones', () => {
  assert.deepEqual(QUALITY_LIMITS, { minContentChars: 60, maxEntryChars: 1200 });
  assert.equal(INJECTION_LIMITS.minContentChars, 60, 'injection must not carry a third copy of the number');
  assert.equal(INJECTION_LIMITS.maxEntryChars, 1200);
  assert.equal(INJECTION_LIMITS.maxPreviewChars, 800, 'selection no longer truncates; the name is a display cap');
  assert.equal(INJECTION_LIMITS.cardMinSimilarity, 0.68);
  assert.equal(INJECTION_LIMITS.cardMargin, 0.02);
});

const card = (overrides) => ({ source: 'card', text: LONG, score: 0, time: Date.now() - 86_400_000, ...overrides });

await check('the degraded path admits one leading card and marks it unverified', () => {
  const out = pickDegradedCards([card({ similarity: 0.91, cardId: 'a' }), card({ similarity: 0.74, cardId: 'b' })]);
  assert.equal(out.entries.length, 1, 'at most one card on a path with no reranker');
  assert.equal(out.entries[0].cardId, 'a', 'the top card is the one admitted');
  assert.equal(out.entries[0].unverified, true, 'nothing confirmed its relevance');
  assert.equal(out.dropped, 1);
  assert.equal(out.reason, undefined);
});

await check('a card below the similarity floor is rejected', () => {
  const out = pickDegradedCards([card({ similarity: 0.61 })]);
  assert.equal(out.entries.length, 0);
  assert.match(out.reason, /below 0\.68/);
});

await check('a card that does not lead the next one is rejected', () => {
  // The case the absolute floor cannot express: both are "similar enough" and the
  // query has no card at all. Measured, an unrelated query's top cards are
  // interchangeable; a real match has a leader.
  const out = pickDegradedCards([card({ similarity: 0.90 }), card({ similarity: 0.89 })]);
  assert.equal(out.entries.length, 0);
  assert.match(out.reason, /margin/);
  const leads = pickDegradedCards([card({ similarity: 0.90 }), card({ similarity: 0.80 })]);
  assert.equal(leads.entries.length, 1);
});

await check('a one-card pool is not vetoed by an undefined margin', () => {
  const out = pickDegradedCards([card({ similarity: 0.88 })]);
  assert.equal(out.entries.length, 1, 'a single candidate already means retrieval narrowed hard');
});

await check('non-card entries are left to the caller', () => {
  const out = pickDegradedCards([{ text: LONG, source: 'transcript', similarity: 0.99 }]);
  assert.equal(out.entries.length, 0);
  assert.equal(out.dropped, 0, 'a transcript entry is not a card and is not counted as one');
});

await check('times render in local time, not UTC', () => {
  const when = new Date(2026, 9, 24, 2, 30, 15);
  assert.equal(formatLocalTime(when.getTime()), '2026-10-24 02:30');
  const utc = new Date(when.getTime()).toISOString().slice(0, 16).replace('T', ' ');
  if (when.getTimezoneOffset() !== 0) {
    assert.notEqual(formatLocalTime(when.getTime()), utc, 'the renderer must not report UTC as local time');
  }
  assert.equal(formatLocalTime(Number.NaN), 'unknown time');
  assert.equal(formatLocalTime(undefined), 'unknown time');
});

// --------------------------------------------------------------- integration
//
// `selectForInjection` is where the filter and the card rule actually meet a recall.
// These are the acceptance negatives: a fragment, a tool call and an oversized entry
// must produce no injection at all.
await check('a pool made only of negatives injects nothing', () => {
  const out = selectForInjection([
    { text: '一段短文本', score: 4.2 },
    { text: TOOL_JSON, score: 4.1 },
    { text: LONG.repeat(40), score: 4.0 },
    { text: '/Users/someone/.dsh/local-keep/dsh-g-memory/node_modules/dsh-g-memory/lib/quality.mjs', score: 3.9 },
  ], { minScore: 0 });
  assert.equal(out.selected.length, 0);
  assert.deepEqual(out.droppedReasons, { 'too-short': 1, json: 1, 'too-long': 1, 'path-only': 1 });
  assert.match(out.reason, /too-short/, 'the reason must name what was dropped');
});

await check('an admitted entry is not clipped to a preview cap', () => {
  // 900 characters is under `maxEntryChars` and over the old 400-character preview
  // cap: it must arrive whole, because half a memory is a wrong memory.
  const text = LONG.repeat(9);
  assert.ok(text.length > 400 && text.length < INJECTION_LIMITS.maxEntryChars);
  const out = selectForInjection([{ text, score: 4.2, time: Date.now() }], { minScore: 0 });
  assert.equal(out.selected.length, 1);
  assert.equal(out.selected[0].text.length, text.length, 'no mid-sentence truncation');
  assert.equal(out.selected[0].truncated, undefined, 'and nothing to declare');
});

await check('an entry that does not fit the budget is skipped whole, not cut', () => {
  const small = LONG;
  const big = LONG.repeat(6);
  const out = selectForInjection([
    { text: big, score: 4.2 },
    { text: small, score: 4.1 },
  ], { minScore: 0, maxTotalChars: small.length + 10 });
  assert.equal(out.selected.length, 1, 'the smaller true memory takes the slot');
  assert.equal(out.selected[0].text, small);
  assert.equal(out.droppedReasons.budget, 1);
});

await check('a card on the reranked path is still read by its score', () => {
  const out = selectForInjection([
    card({ similarity: 0.99, score: 4.2 }),
  ], { minScore: 0, reranked: true });
  assert.equal(out.selected.length, 1, 'with a reranker, the card competes like anything else');
});

await check('renderRecall marks a shortened entry and dates it locally', () => {
  const when = new Date(2026, 9, 24, 2, 30, 0).getTime();
  const rendered = renderRecall([{ text: LONG, time: when, session: 'session-abcdef', seq: 3, truncated: true }]);
  assert.match(rendered, /2026-10-24 02:30/);
  assert.match(rendered, /…\[truncated\]/, 'a cut entry must say it was cut');
  assert.doesNotMatch(renderRecall([{ text: LONG, time: when }]), /truncated/);
});

await check('the automatic path applies the same two rules', () => {
  // `selectByPolicy` is the other half of the same decision: content first, then the
  // degraded card rule. Pinning the age floors to the fused floor isolates them.
  const floors = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor(), marginGate: 0 };
  const short = selectByPolicy([{ text: '一段短文本', score: 4.2 }], { policy: floors });
  assert.equal(short.selected.length, 0);
  assert.equal(short.droppedReasons['too-short'], 1, 'the reason is counted, not inferred from a lower count');
  assert.match(short.reason, /too-short/);
  assert.match(short.reason, /^content filter dropped 1 candidate\(s\) \(too-short×1\): nothing left cleared the floor/,
    'the reason must name the content filter, not the age floor it never consulted');
  assert.match(short.reason, /long-term floor/, 'the floor value stays in the text for existing greps');

  // The same path admits a short user message: the length rule is what changed, so
  // the wiring has to be checked here and not only on the predicate.
  const said = selectByPolicy([
    { text: '不需要节省时间与token资源，完成这个项目更加重要。', role: 'user', score: 4.2, time: Date.now() },
  ], { policy: floors });
  assert.equal(said.selected.length, 1, 'a short user message is context the automatic path may inject');

  const degraded = selectByPolicy([
    card({ similarity: 0.90, cardId: 'a' }),
    card({ similarity: 0.70, cardId: 'b' }),
  ], { policy: floors, reranked: false });
  assert.equal(degraded.selected.length, 1);
  assert.equal(degraded.selected[0].unverified, true);
  assert.match(renderRecall(degraded.selected), /written memory, may be lossy; unverified \(no reranker\)/,
    'the label has to say why the card is a guess');

  const interchangeable = selectByPolicy([
    card({ similarity: 0.90 }),
    card({ similarity: 0.89 }),
  ], { policy: floors, reranked: false });
  assert.equal(interchangeable.selected.length, 0);
  assert.equal(interchangeable.droppedReasons['card-margin'], 2);
});

await check('the policy marks an entry it had to shorten', () => {
  // The two-tier sizing is older than this work and stays: a marginal candidate gets
  // a signal, not a full preview. What is new is that the cut is declared.
  const floors = { gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor(), marginGate: 0, briefScore: 2 };
  const out = selectByPolicy([{ text: LONG.repeat(9), score: 0.5, time: Date.now() - 86_400_000 }], { policy: floors });
  assert.equal(out.selected.length, 1);
  assert.equal(out.selected[0].truncated, true);
  assert.match(renderRecall(out.selected), /…\[truncated\]/);
});

console.log(failures === 0
  ? '\n  quality: all checks passed\n'
  : `\n  quality: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
