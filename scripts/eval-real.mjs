#!/usr/bin/env node
/**
 * Acceptance test through the real plugin, not a reimplementation of it.
 *
 * Three defects in this project came from probes that diverged from production —
 * a mock registry that could not reject a schema, a `check()` that never awaited,
 * and a synthesis probe that fed the model an empty fragment list while
 * `lib/index.js` only calls it when the gate admitted something. Each returned a
 * confident number for a path that never runs. So this harness mounts the plugin
 * the way a profile does and calls the tool the way a model would:
 *
 *   plugin.apply(ctx, options)  →  state.tools[0].execute({ query })
 *
 * Everything measured — retrieval, the relevance gate, the prompt, the
 * abstention classifier — is the shipped code. The only thing this file owns is
 * the scoring of the returned text against a labelled case.
 *
 * Usage:
 *   node scripts/eval-real.mjs <baseUrl> <model> [runs]
 *
 * The reranker must be reachable for the gate to read the cross-encoder scale;
 * without it the gate falls back to the RRF floor and the numbers move.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Tests must not write the production decision log: `record()` appends to
// DSH_G_MEMORY_AUTO_STATS, and a simulated failure that lands in the real telemetry
// looks exactly like a production failure. Point it at a temp file for this process.
process.env.DSH_G_MEMORY_AUTO_STATS = join(await mkdtemp(join(tmpdir(), 'gm-stats-')), 'stats.jsonl');

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2];
const MODEL = process.argv[3];
const RUNS = Number(process.argv[4] ?? 2);
assert.ok(BASE_URL && MODEL, 'usage: eval-real.mjs <baseUrl> <model> [runs]');

const RERANK = { url: process.env.DSH_G_MEMORY_RERANK_URL || 'http://127.0.0.1:11436', model: 'bge-reranker-v2-m3' };

/**
 * Whether to let the synthesiser reason before answering.
 *
 * Off by default, on the argument that condensing three fragments is extraction
 * rather than reasoning. That argument is weaker than it looks: the answers are
 * present in the admitted fragments for 8 of 8 labelled questions, yet every
 * model still drops a fact on 13-25% of runs — selecting and condensing across
 * three noisy fragments is not a lookup. Set `EVAL_THINKING=1` to measure it
 * rather than assume it.
 */
const THINKING = process.env.EVAL_THINKING === '1';

/**
 * Skip the unanswerable set and the colloquial block.
 *
 * Reasoning is 15-20x slower per call here (measured: 3.5 s without, 55-63 s
 * with), so a full sweep is hours. The unanswerable set is worth skipping for a
 * stronger reason than speed: every model measured so far abstains exactly when
 * the gate blocks and fabricates exactly when it leaks, so those numbers are a
 * property of the gate, not of the model, and re-measuring them per model buys
 * nothing.
 */
const POSITIVE_ONLY = process.env.EVAL_POSITIVE_ONLY === '1';

/**
 * Queries a coding-session corpus cannot answer, drawn from unrelated domains so
 * "the index has nothing" is unambiguous. A query that is merely absent by
 * chance would confound a fabrication with a retrieval miss.
 */
const NEGATIVES = [
  '公司年会抽奖奖品清单',
  '南极科考站柴油发电机的维护周期',
  '法国大革命时期雅各宾派的领导人是谁',
  '明代青花瓷使用的钴料来自哪里',
  '北极熊的冬眠周期是多长',
  '请背诵一首完整的唐诗',
  '如何给番茄植株进行人工授粉',
  '钢琴调律的标准音高是多少赫兹',
];

/**
 * The case file is overridable so a run can draw on a different corpus without
 * editing the script — see scripts/build-real-cases.mjs and the extended index.
 */
const CASE_FILE = process.env.EVAL_CASES ?? join(HERE, 'cases.calibration.json');
const positives = JSON.parse(await readFile(CASE_FILE, 'utf8'));

/**
 * The same facts asked the way a person actually asks.
 *
 * The labelled queries above are crisp retrieval probes. A real request to a
 * memory system is a sentence with a vague referent, however — the user does not
 * know what the index calls things, so they point at a moment instead ("上次
 * 那个…"). Retrieval has to survive that, and synthesis has to resist the pull of
 * the framing: padding around a question is exactly the kind of context a small
 * model will answer out of. Scored against the same `must`/`any` keywords, so a
 * miss here is a real miss and not a relabelling.
 */
const REALISTIC = [
  (q) => `我记得之前聊过这个，帮我回忆一下：${q}`,
  (q) => `上次你测的那个数字是多少来着？${q}`,
  (q) => `别重新查，就用你之前会话里的记录回答我：${q}`,
];

const plugin = await import('../lib/index.js');
const { isRefusal } = await import('../lib/synthesize.mjs');

/**
 * Refuse to run against a dead endpoint.
 *
 * A synthesis call that cannot reach its server returns `{ ok: false }`, and
 * `lib/index.js` then leaves `synthesis` empty — indistinguishable, from the
 * outside, from a model that abstained. A whole sweep against a server that had
 * quietly exited was scored "0/16, 100% false negatives" before this check
 * existed, which measures the harness, not the model.
 */
{
  const probe = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => ({ ok: false, status: `unreachable: ${error.message}` }));
  if (!probe.ok) {
    console.error(`\n❌ ${BASE_URL} did not answer (${probe.status}). Start the server first — `
      + 'an unreachable endpoint scores exactly like a model that abstains on everything.');
    process.exit(2);
  }
}

/** Mount the plugin against the same service shape the Harness exposes. */
function mount(options) {
  const state = { tools: [] };
  const ctx = {
    get: (name) => (name === 'tools'
      ? { register: (tool) => { state.tools.push(tool); return () => {}; } }
      : undefined),
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    on: () => () => {},
    effect: () => () => {},
  };
  // Live indexing off: an evaluation must not mutate the production index.
  plugin.apply(ctx, { ...options, auto: false, liveIndex: { enabled: false } });
  assert.equal(state.tools.length, 1, 'the plugin must register exactly one tool');
  return state.tools[0];
}

const tool = mount({
  rerank: RERANK,
  synthesis: { enabled: true, baseUrl: BASE_URL, model: MODEL, thinking: THINKING },
});

const lower = (t) => String(t).toLowerCase();
const carries = (spec, text) => {
  const h = lower(text);
  if (spec.must?.length) return spec.must.every((n) => h.includes(lower(n)));
  if (spec.any?.length) return spec.any.some((n) => h.includes(lower(n)));
  return false;
};

console.log(`\n${'═'.repeat(74)}`);
console.log(`  ${MODEL.split('/').pop()}   (${BASE_URL}, ${RUNS} runs/case, thinking ${THINKING ? 'ON' : 'off'})`);
console.log(`  cases: ${positives.length} positives from ${CASE_FILE}`);
console.log('═'.repeat(74));

let ok = 0, falseNeg = 0, miss = 0, empty = 0, abstained = 0, fabricated = 0, gatedOut = 0;

console.log('\n  ── 可回答问题（8 例）──');
for (const c of positives) {
  const verdicts = [];
  const times = [];
  for (let r = 0; r < RUNS; r += 1) {
    const t0 = Date.now();
    const out = await tool.execute({ query: c.query });
    times.push(Date.now() - t0);
    const text = String(out.synthesis || '').trim();
    // `found` counts what the gate admitted; the plugin never calls the
    // synthesiser when it is zero, so that case is structural abstention.
    if (out.found === 0) { gatedOut += 1; verdicts.push('GATED'); falseNeg += 1; continue; }
    // An empty `synthesis` with admitted fragments is NOT "the model produced
    // nothing": the plugin also blanks it when isRefusal() recognises an
    // abstention, and a real refusal would otherwise be counted as a clean run.
    // Both land on the user as the same thing — no synthesised memory — so both
    // are scored a false negative here. (An endpoint error lands here too; the
    // logger is the place to tell those apart, not the verdict.)
    if (text === '') { falseNeg += 1; empty += 1; verdicts.push('NO_SYN'); continue; }
    if (isRefusal(text)) { falseNeg += 1; verdicts.push('FALSE_NEG'); continue; }
    if (carries(c, text)) { ok += 1; verdicts.push('OK'); } else { miss += 1; verdicts.push('MISS'); }
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const flag = verdicts.every((v) => v === 'OK') ? '  ' : '⚠️';
  console.log(`  ${flag} ${c.query.padEnd(24, '　')} ${verdicts.join('/').padEnd(24)} ${avg}ms`);
}

if (POSITIVE_ONLY) { console.log('\n  (跳过不可回答问题与口语场景：EVAL_POSITIVE_ONLY=1)'); }
if (!POSITIVE_ONLY) console.log('\n  ── 不可回答问题（8 例）──');
for (const q of POSITIVE_ONLY ? [] : NEGATIVES) {
  const verdicts = [];
  for (let r = 0; r < RUNS; r += 1) {
    const out = await tool.execute({ query: q });
    const text = String(out.synthesis || '').trim();
    if (out.found === 0) { abstained += 1; verdicts.push('GATED'); continue; }
    if (text === '' || isRefusal(text)) { abstained += 1; verdicts.push('ABSTAIN'); continue; }
    fabricated += 1; verdicts.push('FABRICATED');
  }
  const flag = verdicts.every((v) => v === 'GATED' || v === 'ABSTAIN') ? '  ' : '❌';
  console.log(`  ${flag} ${q.padEnd(24, '　')} ${verdicts.join('/')}`);
}

const posRuns = positives.length * RUNS;
const negRuns = NEGATIVES.length * RUNS;
console.log('\n  ── 汇总 ──');
console.log(`    可回答 ${posRuns} 次：答对 ${ok}  假否定 ${falseNeg}  漏关键事实 ${miss}  空输出 ${empty}`);
console.log(`       其中被闸门拦下（未调用模型）：${gatedOut}`);
console.log(`    不可回答 ${negRuns} 次：正确弃权 ${abstained}  ❌ 编造 ${fabricated}`);
// A skipped loop is not a perfect score. With EVAL_POSITIVE_ONLY=1 the negative
// loop above never ran, yet the rate was still printed as 0% — the one number in
// this script that must never be reported without having been measured.
console.log(POSITIVE_ONLY
  ? '\n    编造率 未测量（EVAL_POSITIVE_ONLY=1：负例被跳过）'
  : `\n    ❌ 编造率 ${((fabricated / negRuns) * 100).toFixed(0)}%`);
console.log(`    假否定率 ${((falseNeg / posRuns) * 100).toFixed(0)}%   漏事实率 ${((miss / posRuns) * 100).toFixed(0)}%`);

// ── realistic phrasing, scored the same way ────────────────────────────────
if (!POSITIVE_ONLY) console.log('\n  ── 真实场景：同一批事实，口语化/含糊提问 ──');
let realOk = 0, realBad = 0, realGate = 0, realRuns = 0;
for (let i = 0; i < (POSITIVE_ONLY ? 0 : positives.length); i += 1) {
  const c = positives[i];
  const wrapped = REALISTIC[i % REALISTIC.length](c.query);
  // RUNS times, like the block above. Running it once made the two halves of the
  // same report incomparable — one averaged over three attempts, the other a single
  // sample — and the summary line divided by the case count either way.
  const verdicts = [];
  for (let r = 0; r < RUNS; r += 1) {
    const out = await tool.execute({ query: wrapped });
    const text = String(out.synthesis || '').trim();
    const gated = out.found === 0;
    const good = !gated && text !== '' && !isRefusal(text) && carries(c, text);
    realRuns += 1;
    if (gated) { realGate += 1; verdicts.push('GATED'); }
    else if (good) { realOk += 1; verdicts.push('OK'); }
    else if (text === '') { realBad += 1; verdicts.push('NO_SYN'); }
    else { realBad += 1; verdicts.push(isRefusal(text) ? 'FALSE_NEG' : 'MISS'); }
  }
  const flag = verdicts.every((v) => v === 'OK') ? '  ' : '⚠️';
  console.log(`  ${flag} ${c.query.padEnd(20, '　')} ${verdicts.join('/')}`);
}
console.log(`\n    口语化提问：答对 ${realOk}/${realRuns}  失败 ${realBad}  被闸门拦下 ${realGate}`);

// A model that abstains on everything scores 0% fabrication and is worthless,
// so the two rates are printed together and neither is a verdict on its own.
process.exitCode = 0;
