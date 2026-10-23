#!/usr/bin/env node
/**
 * Injection-side acceptance: what may enter the block, and what the log says got in.
 *
 * Two halves, both hermetic — no reranker endpoint (so nothing here needs 11436), no
 * real embedder, no session history:
 *
 *   - the pool: the content shapes and the degraded card rule that decide what is
 *     injectable at all. The tool path (`lib/index.js`) and the automatic path
 *     (`lib/auto-recall.mjs`) call the same two functions, so one suite covers both.
 *   - the pipeline: a unit from the session receiving the injection is filtered out
 *     (`isSameSession`), and the `inject` event carries the identity of what arrived
 *     (`ids` / `top1` / `kept` / `kinds` / `synthesis`) instead of only its length.
 *
 * The negatives are the ones the 2026-10-24 review measured: a `run_code` JSON
 * fragment injected into a live session, 23-27% of entries under 80 characters, and
 * 16.6% of entries recalled from the session that received them.
 *
 *   node scripts/test-inject.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, writeIndex, rrfFloor } from '../lib/store.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';
import { selectForInjection } from '../lib/inject.mjs';
import { resolvePolicy } from '../lib/policy.mjs';

// A temporary DSH_HOME keeps the card store and the decision log out of the real one.
// The plugin is imported after the environment is set: both paths are read at call
// time, but a value captured at import would be the one from before this line.
const home = mkdtempSync(join(tmpdir(), 'gm-inject-'));
process.env.DSH_HOME = home;
process.env.DSH_G_MEMORY_AUTO_STATS = join(home, 'stats.jsonl');
const { AutoRecall, isSameSession } = await import('../lib/auto-recall.mjs');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/**
 * A memory-shaped sentence, over the 60-character content floor.
 *
 * The floor is not cosmetic: `selectForInjection` drops anything shorter as a
 * fragment before the score is read, so a terse fixture would test the content
 * filter instead of the rule the check names.
 */
const LONG = '重排服务空闲 300 秒就释放模型，所以冷启动要三到六秒；机器重启后的第一次调用实测出现过五十六秒，最坏的一次等了一百八十秒。';
/** A tool result as `run_code` returns it — the incident this filter exists to stop. */
const TOOL_JSON = JSON.stringify({
  callId: 'call_9f2c7a41b6e3',
  type: 'tool_call',
  arguments: { command: 'node scripts/test-policy.mjs', timeoutMs: 120000 },
  result: LONG,
});
/** A card candidate on the degraded path (no reranker); long for the same reason. */
const CARD_TEXT = '这是一张已经定稿的策展卡片：重排服务空闲三百秒释放模型，冷启动要三到六秒，机器重启后的第一次调用实测到过五十六秒，这条是策展内容。';
const card = (overrides = {}) => ({ text: CARD_TEXT, score: 0, similarity: 0.74, source: 'card', time: Date.now() - 86_400_000, seq: null, ...overrides });

/** The quality limits the callers pass, read from the policy rather than restated. */
const policyLimits = () => {
  const policy = resolvePolicy();
  return {
    cardMinSimilarity: policy.cardMinSimilarity,
    cardMargin: policy.cardMargin,
    minContentChars: policy.minContentChars,
    maxEntryChars: policy.maxEntryChars,
  };
};

console.log('injection pool');

await check('a pool of fragments injects nothing', () => {
  // The three measured shapes, through the tool path's own call shape: a short
  // fragment, the run_code JSON of 2026-10-24, and an entry over the ceiling (which
  // is dropped whole rather than clipped into a half-sentence).
  const out = selectForInjection([
    { text: '一段短文本', score: 4.2 },
    { text: TOOL_JSON, score: 4.1 },
    { text: LONG.repeat(40), score: 4.0 },
  ], { minScore: 0, ...policyLimits() });
  assert.equal(out.selected.length, 0, 'none of the three is a memory');
  assert.deepEqual(out.droppedReasons, { 'too-short': 1, json: 1, 'too-long': 1 });
  assert.match(out.reason, /too-short/, 'the reason must name what was dropped');
});

await check('an unrelated query admits no card without a reranker', () => {
  // The negative sample the relative card rule exists for: two cards that both look
  // "similar enough" and are interchangeable — what an unrelated query returns.
  // No reranker involved, so this is the assertion that runs without the 11436
  // endpoint (the review's D1: the old 0.35 floor admitted a card every time).
  const out = selectForInjection([
    card({ similarity: 0.90 }),
    card({ similarity: 0.89 }),
  ], { minScore: rrfFloor(), reranked: false, ...policyLimits() });
  assert.equal(out.selected.length, 0, 'a coin-flip between two cards is not a memory');
  assert.equal(out.droppedReasons['card-margin'], 2);
});

await check('a leading card is admitted once and marked unverified', () => {
  const out = selectForInjection([
    card({ similarity: 0.74 }),
    card({ similarity: 0.70 }),
  ], { minScore: rrfFloor(), reranked: false, ...policyLimits() });
  assert.equal(out.selected.length, 1, 'at most one card on the degraded path');
  assert.equal(out.selected[0].similarity, 0.74);
  assert.equal(out.selected[0].unverified, true, 'nothing compared it with the question');
  assert.equal(out.droppedReasons['card-not-top1'], 1);
});

console.log('\nsession identity');

const SELF_SESSION = 'session-3f8a1c20-9b7d-4e55-8a11-0c2d3e4f5a6b';
const OTHER_SESSION = 'session-77c0d1e2-aa33-4f01-9b8c-5d6e7f809112';

await check('the two locator forms of one session are the same session', () => {
  assert.equal(isSameSession(SELF_SESSION, SELF_SESSION), true);
  assert.equal(isSameSession(SELF_SESSION, SELF_SESSION.slice(0, 16)), true,
    'telemetry keeps 16 characters, and that must still match');
  assert.equal(isSameSession(SELF_SESSION, SELF_SESSION.slice(0, 24)), true,
    'an agent id may be a truncation of the session directory name');
  assert.equal(isSameSession(SELF_SESSION, SELF_SESSION.slice('session-'.length)), true,
    'a bare uuid names the same session as session-<uuid>');
  assert.equal(isSameSession('session-abc', 'agent-abc'), true,
    'the namespace prefix is not part of the identity');
});

await check('a different session is not the same session', () => {
  assert.equal(isSameSession(SELF_SESSION, OTHER_SESSION), false);
  assert.equal(isSameSession(SELF_SESSION, 'fixture'), false);
  assert.equal(isSameSession(undefined, SELF_SESSION), false);
  assert.equal(isSameSession('', ''), false);
});

// --------------------------------------------------------------------- pipeline
//
// The real `AutoRecall` on a fixture index, a stub embedder, and the two listener
// calls the host makes. This is the only place the self-recall filter and the
// `inject` identity fields can be observed end to end without a live host.
const sha1 = (text) => createHash('sha1').update(String(text));

/** Deterministic vector: hashed character bigrams, L2-normalised. */
function fixtureVector(text, dim) {
  const v = new Array(dim).fill(0);
  const s = String(text).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    for (const gram of [s.slice(i, i + 1), s.slice(i, i + 2)]) {
      if (!gram) continue;
      const h = sha1(gram);
      v[h[0] % dim] += 1;
      v[h[1] % dim] += 0.5;
    }
  }
  return Array.from(l2Normalize(v));
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep empty */ }
    const list = Array.isArray(payload.input) ? payload.input : [payload.input];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: list.map((text, index) => ({ index, embedding: fixtureVector(text, 64) })) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const embedUrl = 'http://127.0.0.1:' + server.address().port;

/** Both fixtures are over 60 characters: the content filter must not decide these. */
const SELF_TEXT = '当前会话刚说过：重排服务的空闲超时是三百秒，冷启动要三到六秒，这段内容已经在当前窗口里了，不该再被自动注入一遍，否则等于把刚读过的话重复一次。';
const OTHER_TEXT = '上一次会话的结论：重排服务冷启动要三到六秒，空闲三百秒释放模型，所以批量召回之前先温一下进程，省得每次吃满超时；这条是跨会话才该出现的记忆。';

const dir = mkdtempSync(join(tmpdir(), 'gm-inject-index-'));
{
  const unit = (text, seq, session) => {
    const { codes, scale } = quantizeInt8(l2Normalize(fixtureVector(text, 64)));
    return { text, role: 'user', session, seq, time: Date.now(), hash: sha1(text).digest('hex'), vector: packVector(codes, scale) };
  };
  await writeIndex(dir, new MemoryIndex({
    version: 1, dim: 64, model: 'fixture', builtAt: Date.now(),
    units: [unit(SELF_TEXT, 0, SELF_SESSION), unit(OTHER_TEXT, 1, OTHER_SESSION)],
  }));
}

/**
 * One `AutoRecall` instance with captured listeners.
 *
 * The judge, the resident layer and consolidation are all switched off explicitly:
 * the question here is the retrieval-to-injection path, and an environment variable
 * on the machine running the suite must not be able to change that.
 */
function attachedRecall() {
  const listeners = new Map();
  const ctx = {
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    logger: { debug() {}, info() {}, warn() {} },
  };
  const recall = new AutoRecall(ctx, {
    indexDir: dir,
    embed: { url: embedUrl, model: 'fixture' },
    rerank: { url: '' },
    judge: { provider: 'off' },
    resident: { enabled: false },
    consolidate: false,
    auto: { enabled: true },
  });
  recall.attach();
  return { recall, listeners };
}

/**
 * Feed one user turn through the real listeners and return the injected block.
 *
 * The background recall is fire-and-forget, so the step is polled until the result is
 * ready — the same shape as `agent/pre-step` in the host, compressed.
 */
async function runTurn(listeners, agentId, query) {
  const onInsert = listeners.get('agent/inbox/inserted')?.[0];
  const preStep = listeners.get('agent/pre-step')?.[0];
  assert.ok(onInsert && preStep, 'the automatic path registered its listeners');
  onInsert({ agent: { id: agentId }, message: { role: 'user', content: [{ type: 'text', text: query }], source: { kind: 'user' } } });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const decision = await preStep(
      { agent: { id: agentId } },
      async () => ({ kind: 'enter', messages: [{ id: 'u', role: 'user', source: { kind: 'user' } }] }),
    );
    if (decision.messages.length > 1) {
      return decision.messages[0].content.map((part) => part.text || '').join('');
    }
  }
  return '';
}

/** The decision log, after the fire-and-forget append has landed. */
const events = async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  try {
    return readFileSync(process.env.DSH_G_MEMORY_AUTO_STATS, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
};
const lastInject = async (agentId) => (await events())
  .filter((event) => event.event === 'inject' && event.session === String(agentId).slice(0, 16)).pop();

const QUERY = '重排服务的冷启动时间是多少';
const otherId = sha1(OTHER_TEXT).digest('hex').slice(0, 8);
const selfId = sha1(SELF_TEXT).digest('hex').slice(0, 8);

console.log('\nsession pipeline');

await check('a unit from the session receiving the injection never arrives', async () => {
  const run = attachedRecall();
  const block = await runTurn(run.listeners, SELF_SESSION, QUERY);
  assert.ok(block.length > 0, 'the cross-session unit still answers the query');
  assert.ok(block.includes('跨会话才该出现的记忆'), 'so the cross-session unit is there');
  assert.ok(!block.includes('窗口里了'), "the receiving session's own unit is not");
  assert.match(block, /untrusted background information/i, 'and the block is still framed');

  const event = await lastInject(SELF_SESSION);
  assert.ok(event, 'the injection was recorded');
  assert.deepEqual(event.ids, [otherId], 'the log names the unit that arrived, not the one filtered out');
  assert.equal(event.kept, 1);
});

await check('a truncated agent id is still the same session', async () => {
  const run = attachedRecall();
  const block = await runTurn(run.listeners, SELF_SESSION.slice(0, 24), QUERY);
  assert.ok(block.length > 0);
  assert.ok(!block.includes('窗口里了'), 'prefix matching, not exact-string matching');
});

await check('another session still receives that unit: filtering is not a cache bleed', async () => {
  // The block cached while filtering SELF_SESSION must not be served here. It is
  // keyed with the excluded session for this reason — otherwise the cross-session
  // unit would be lost to another session, or the self unit handed back to its own.
  const run = attachedRecall();
  const block = await runTurn(run.listeners, 'agent-other-workspace', QUERY);
  assert.ok(block.includes('窗口里了'), 'a genuinely cross-session unit is delivered');
  assert.ok(block.includes('跨会话才该出现的记忆'));
});

await check('the inject event carries ids, top1, kept, kinds and synthesis', async () => {
  const event = await lastInject('agent-other-workspace');
  assert.ok(event, 'an inject event was written');
  assert.equal(event.kept, 2, 'two entries were injected');
  assert.deepEqual([...event.kinds].sort(), ['excerpt'], 'provenance classes, de-duplicated');
  assert.equal(event.synthesis, false, 'the body is the entries, not a model summary');
  assert.equal(typeof event.top1, 'number', 'the score the gate read is recorded');
  assert.deepEqual([...event.ids].sort(), [otherId, selfId].sort(),
    'ids name the card or unit the block was built from; got ' + JSON.stringify(event.ids));
});

// ---------------------------------------------------------------------- teardown
server.close();
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });

console.log('');
console.log(failures === 0
  ? 'inject: all checks passed'
  : 'inject: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
