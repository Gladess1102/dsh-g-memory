#!/usr/bin/env node
/**
 * Consolidation integration checks.
 *
 * `consolidateSession` had no test that ran it: the gate was tested, the tracker
 * was tested, and the session that reaches the model was not. Three of the second
 * review's findings live in exactly that gap — the receipt recorded every failure
 * as "model returned nothing", the one early return wrote no receipt at all, and a
 * distilled duplicate looked like a failed write.
 *
 * The model is a stub HTTP server, so this runs with no endpoint and no API key.
 *
 *   node scripts/test-consolidate.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { consolidateSession } from '../lib/consolidate.mjs';
import { readCards } from '../lib/cards.mjs';
import { l2Normalize } from '../lib/vector.mjs';
import { AutoRecall } from '../lib/auto-recall.mjs';
import { MemoryIndex, writeIndex } from '../lib/store.mjs';
import { listSessionLogs } from '../lib/live-index.mjs';
import { extractUnits } from '../lib/session-source.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/** A summary long enough to pass parseCard's 30-character floor. */
const SUMMARY = '这条会话判断的核心结论是：嵌入模型换成 Gemma 之后，索引必须整体重建而不能复用旧向量。';
const mode = { value: 'ok' };

const server = createServer((req, res) => {
  // The loop below runs the real `distill`, which embeds the card it wrote — so the
  // stub answers the embedding route too, and the whole path stays hermetic.
  if (req.url?.includes('/embeddings')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, (_, i) => (i + 1) / 10) }] }));
    return;
  }
  if (mode.value === 'http500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('upstream exploded'); return; }
  if (mode.value === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY } }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const deadUrl = 'http://127.0.0.1:9/v1';

const dir = await mkdtemp(join(tmpdir(), 'gm-consolidate-'));
const cardPath = join(dir, 'cards.ndjson');
const receipts = join(dir, 'receipts.ndjson');
const embed = async () => l2Normalize(Float32Array.from({ length: 8 }, (_, i) => i + 1));
const transcript = (session) => `会话 ${session} 的原文。`.repeat(30);
const options = { path: cardPath, receipts };
const endpoint = { baseUrl, model: 'stub' };

const stored = await consolidateSession({ session: 's1', text: transcript('s1'), embed }, endpoint, options);
await check('a distilled session becomes a card and leaves a receipt', async () => {
  assert.equal(stored.stored, true, stored.reason);
  assert.equal((await readCards(cardPath)).length, 1);
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).decision, 'store');
  assert.equal(lines.at(-1).session, 's1');
});

await check('the same content distilled again is a duplicate, not a failure', async () => {
  // The ids differ (the session differs) but the content does not, so the write is
  // deduplicated — which the read-back could not tell apart from a failed write.
  const again = await consolidateSession({ session: 's2', text: transcript('s2'), embed }, endpoint, options);
  assert.equal(again.stored, true, `expected success, got: ${again.reason}`);
  assert.equal(again.duplicate, true);
  assert.equal((await readCards(cardPath)).length, 1, 'the store still holds one card');
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).decision, 'store');
  assert.equal(lines.at(-1).duplicate, true);
});

await check('an unusable endpoint is reported as unusable, not as an empty answer', async () => {
  const before = (await readFile(receipts, 'utf8')).trim().split('\n').length;
  const out = await consolidateSession({ session: 's3', text: transcript('s3'), embed }, { baseUrl: deadUrl, model: 'stub' }, options);
  assert.equal(out.stored, false);
  assert.match(out.reason, /unreachable/, `got: ${out.reason}`);
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, before + 1, 'a failed attempt still leaves a receipt');
  assert.match(lines.at(-1).reason, /unreachable/);
});

await check('an HTTP failure carries its status into the receipt', async () => {
  mode.value = 'http500';
  const out = await consolidateSession({ session: 's4', text: transcript('s4'), embed }, endpoint, options);
  assert.equal(out.stored, false);
  assert.match(out.reason, /HTTP 500/, `got: ${out.reason}`);
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.match(lines.at(-1).reason, /HTTP 500/);
  assert.match(lines.at(-1).reason, /upstream exploded/);
});

await check('an empty completion is distinguishable from both', async () => {
  mode.value = 'empty';
  const out = await consolidateSession({ session: 's5', text: transcript('s5'), embed }, endpoint, options);
  assert.match(out.reason, /empty completion/, `got: ${out.reason}`);
  mode.value = 'ok';
});

await check('a transcript too short to distil writes a receipt and stops', async () => {
  const before = (await readFile(receipts, 'utf8')).trim().split('\n').length;
  const out = await consolidateSession({ session: 's6', text: '太短了', embed }, endpoint, options);
  assert.equal(out.stored, false);
  assert.match(out.reason, /too short/);
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, before + 1);
});

await check('every early return leaves a receipt', async () => {
  // The rule the module states, checked against the receipts it actually wrote:
  // one line per attempt, no silent exits.
  await writeFile(receipts, '');
  const attempts = [
    { session: 'r1', text: '短', embed },                                  // too short
    { session: 'r2', text: transcript('r2'), embed },                       // stored
    { session: 'r3', text: transcript('r3'), embed },                       // duplicate
  ];
  for (const input of attempts) await consolidateSession(input, endpoint, options);
  mode.value = 'http500';
  await consolidateSession({ session: 'r4', text: transcript('r4'), embed }, endpoint, options);
  mode.value = 'ok';
  const lines = (await readFile(receipts, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, attempts.length + 1, `expected one receipt per attempt, got ${lines.length}`);
  assert.deepEqual(lines.map((l) => l.session), ['r1', 'r2', 'r3', 'r4']);
});

// ------------------------------------------------- the loop, end to end
//
// Everything above exercises `consolidateSession` in isolation. What had no test at
// all is the loop that decides *when* to call it and what happens to the session
// afterwards — `attach()`'s tick, which is `pick → distill → settle → markRun`. A
// mutation that dropped `settle` passed the entire suite while making every tick
// re-distil the same session forever, spending model calls (review M22).
//
// It is also the only way to show, without waiting for a live deployment, that the
// durable-card layer produces a card at all: none of the three defects that kept it
// from ever running lived in `consolidateSession`, so no unit test of that function
// could have caught them.
{
  const loopHome = await mkdtemp(join(tmpdir(), 'gm-loop-'));
  const sessionDir = join(loopHome, 'sessions', '--tmp--', 'loop-session');
  await mkdir(sessionDir, { recursive: true });
  // Material for the gate: a transcript past consolidateSession's 200-character
  // floor, and one user turn for the tracker to count.
  const lines = [JSON.stringify({ type: 'session', id: 'loop-session' })];
  for (let i = 1; i <= 4; i += 1) {
    lines.push(JSON.stringify({
      type: 'user/message',
      seq: i,
      time: Date.now(),
      data: {
        source: { kind: 'user' },
        // Long enough on purpose: `consolidateSession` refuses a transcript under
        // 200 characters, and a fixture that is 166 characters long "tests" the loop
        // while never reaching the model at all — it wrote a `transcript too short`
        // receipt and nothing else.
        content: [{ type: 'text', text: `第 ${i} 轮：这段对话用来验证蒸馏循环本身，正文必须足够长才能越过两百字符的下限，所以每一轮都要写得长一些，四轮加起来要稳稳超过。` }],
      },
    }));
  }
  await writeFile(join(sessionDir, 'session.v4.jsonl'), `${lines.join('\n')}\n`);

  // A second session, for the failure path: a distillation that fails has to be
  // retried, and the retry has to be bounded.
  const failSession = join(loopHome, 'sessions', '--tmp--', 'loop-failing');
  await mkdir(failSession, { recursive: true });
  const failLines = [JSON.stringify({ type: 'session', id: 'loop-failing' })];
  for (let i = 1; i <= 4; i += 1) {
    failLines.push(JSON.stringify({
      type: 'user/message',
      seq: i,
      time: Date.now(),
      data: {
        source: { kind: 'user' },
        // Also past the 200-character floor: a fixture that is 184 characters long
        // takes the "transcript too short" branch and quietly tests nothing.
        content: [{ type: 'text', text: `第 ${i} 轮：这个会话专门用来验证失败的蒸馏会被重试而且重试次数有上限，所以每一轮的正文都必须写得足够长，四轮加起来要明显超过两百字符的下限才行。` }],
      },
    }));
  }
  await writeFile(join(failSession, 'session.v4.jsonl'), `${failLines.join('\n')}\n`);

  const loopIndex = join(loopHome, 'dsh-g-memory', 'index');
  await mkdir(loopIndex, { recursive: true });
  // An empty index, so the recall half of the inbox listener has nothing to do and
  // the test measures the consolidation loop alone.
  await writeIndex(loopIndex, new MemoryIndex({ version: 1, dim: 8, model: 'stub-embed', builtAt: Date.now(), units: [] }));

  const previous = {
    home: process.env.DSH_HOME,
    embed: process.env.DSH_G_MEMORY_EMBED_URL,
    model: process.env.DSH_G_MEMORY_EMBED_MODEL,
    stats: process.env.DSH_G_MEMORY_AUTO_STATS,
  };
  process.env.DSH_HOME = loopHome;
  process.env.DSH_G_MEMORY_EMBED_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DSH_G_MEMORY_EMBED_MODEL = 'stub-embed';
  process.env.DSH_G_MEMORY_AUTO_STATS = join(loopHome, 'stats.jsonl');

  const listeners = new Map();
  const loopCtx = {
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
  };
  const recall = new AutoRecall(loopCtx, {
    indexDir: loopIndex,
    synthesis: { baseUrl, model: 'stub' },
    consolidation: { enabled: true, tickMs: 60, minIntervalHours: 0, minTurns: 1, minSessionTurns: 1, idleMs: 0 },
  });

  const telemetry = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60)); // `record` is fire-and-forget
    try {
      return (await readFile(process.env.DSH_G_MEMORY_AUTO_STATS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };

  recall.attach();
  try {
    // The two observables the loop depends on, asserted from the outside before the
    // loop is allowed to fail on them. This exists because the first CI run of the
    // check below failed on Ubuntu while macOS passed, and all it said was
    // "expected one card, got 0" — naming neither the step nor the reason. Both
    // expressions mirror `transcriptFor` exactly, so a failure here localises the
    // problem to discovery or to the 200-character floor instead of leaving it to
    // the model, the endpoint, or the store.
    await check('the loop can discover the fixture the way transcriptFor does', async () => {
      const logs = await listSessionLogs(join(loopHome, 'sessions'));
      assert.ok(logs.some((file) => file.includes('loop-session')),
        `discoverable logs: ${JSON.stringify(logs)}`);
    });

    await check('the fixture transcript clears the 200-character floor', async () => {
      const jsonl = await readFile(join(sessionDir, 'session.v4.jsonl'), 'utf8');
      const { units } = extractUnits(jsonl, { includeToolResults: false, includeToolCalls: false });
      const text = units.map((u) => u.text).join('\n\n');
      assert.ok(text.length >= 200, `transcript is ${text.length} characters`);
    });
    // One user turn arms the tracker. Injection stays at its default mode, so the
    // listener reaches `note()` — the gate that keeps a session out of `note()` is
    // the reason this has to be a real inbox event rather than a direct call.
    assert.ok(listeners.has('agent/inbox/inserted'), 'the loop is armed from the inbox listener');
    listeners.get('agent/inbox/inserted')({
      agent: { id: 'loop-session' },
      message: { content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 600)); // several ticks

    await check('the loop distils a finished session into a card', async () => {
      const cards = await readCards(join(loopHome, 'dsh-g-memory', 'cards.ndjson'));
      // A failure has to name the reason, not just the count: `distill` records one
      // `consolidate-result` per attempt carrying the reason it did not store.
      const outcomes = JSON.stringify((await telemetry())
        .filter((e) => e.event.startsWith('consolidate')));
      assert.equal(cards.length, 1, `expected one card, got ${cards.length}; attempts: ${outcomes}`);
      assert.match(cards[0].summary, /嵌入模型换成 Gemma/, 'the card carries what the model returned');
      assert.equal(cards[0].session, 'loop-session', 'and it names the session it came from');
      const receipts = (await readFile(join(loopHome, 'dsh-g-memory', 'receipts.ndjson'), 'utf8'))
        .trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(receipts.at(-1).decision, 'store', 'the attempt is auditable');
    });

    await check('a session that distilled successfully is not distilled again', async () => {
      const events = await telemetry();
      assert.equal(events.filter((e) => e.event === 'consolidate').length, 1,
        'one successful run, and the material gate closes behind it');
      assert.equal(events.filter((e) => e.event === 'consolidate-result').length, 1);
      assert.equal(events.filter((e) => e.event === 'consolidate-error').length, 0);
    });

    await check('a failed distillation is retried, and the retrying stops', async () => {
      // This is what `settle` actually protects, and the first version of this check
      // asserted the wrong thing. Dropping `settle` does NOT re-distil every tick:
      // `pick()` skips an entry whose `picked` flag is still set, so the session is
      // silently dropped instead — picked once, never looked at again, its material
      // kept but unreachable until the process restarts. Both halves are asserted
      // here: a failure must come back (>= 2 attempts), and it must stop at
      // `maxAttempts` rather than burn model calls forever (<= 3).
      const before = (await telemetry()).filter((e) => e.event === 'consolidate').length;
      mode.value = 'http500';
      listeners.get('agent/inbox/inserted')({
        agent: { id: 'loop-failing' },
        message: { content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 800)); // many ticks
      mode.value = 'ok';

      const events = await telemetry();
      const attempts = events.filter((e) => e.event === 'consolidate').length - before;
      assert.ok(attempts >= 2, `a failed distillation must be retried, got ${attempts} attempt(s)`);
      assert.ok(attempts <= 3, `and must give up after maxAttempts, got ${attempts}`);
      const failures = events.filter((e) => e.event === 'consolidate-result' && e.stored === false);
      assert.ok(failures.length >= 1, 'each failure says why');
      assert.match(failures.at(-1).reason, /HTTP 500/);
    });

    await check('the run is recorded, so a restart does not immediately repeat it', async () => {
      const state = JSON.parse(await readFile(join(loopHome, 'dsh-g-memory', 'consolidate-state.json'), 'utf8'));
      assert.ok(state.lastRunAt > 0, 'the interval gate is persisted, not held only in memory');
    });
  } finally {
    recall.dispose();
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.embed === undefined) delete process.env.DSH_G_MEMORY_EMBED_URL; else process.env.DSH_G_MEMORY_EMBED_URL = previous.embed;
    if (previous.model === undefined) delete process.env.DSH_G_MEMORY_EMBED_MODEL; else process.env.DSH_G_MEMORY_EMBED_MODEL = previous.model;
    if (previous.stats === undefined) delete process.env.DSH_G_MEMORY_AUTO_STATS; else process.env.DSH_G_MEMORY_AUTO_STATS = previous.stats;
    await rm(loopHome, { recursive: true, force: true });
  }
}

server.close();
await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  consolidation: all checks passed\n'
  : `\n  consolidation: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
