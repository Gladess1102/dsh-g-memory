#!/usr/bin/env node
/**
 * Live index checks.
 *
 * The behaviour under test is the one a week of use exposed as missing: the index
 * has to follow the sessions on its own. These are hermetic — a temp DSH home with
 * plain (uncompressed) session logs, a stub embedder, and no network — so they
 * assert the *mechanism*: watermarks, hash dedup, the quiet window, the model
 * guard, the writer lock, and the fact that an unchanged session costs nothing.
 *
 *   node scripts/test-live-index.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, readIndex, writeIndex } from '../lib/store.mjs';
import { LiveIndex, listSessionLogs, progressPathFor } from '../lib/live-index.mjs';
// Tests must not write the production decision log: `record()` appends to
// DSH_G_MEMORY_AUTO_STATS, and a simulated failure that lands in the real telemetry
// looks exactly like a production failure. Point it at a temp file for this process.
process.env.DSH_G_MEMORY_AUTO_STATS = join(await mkdtemp(join(tmpdir(), 'gm-stats-')), 'stats.jsonl');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

const DIM = 8;
const MODEL = 'stub-embed';
const dir = await mkdtemp(join(tmpdir(), 'gm-live-'));
const home = join(dir, 'dsh-home');
const indexDir = join(dir, 'index');
const sessionDir = join(home, 'sessions', '--root--', 'session-abc');
await mkdir(sessionDir, { recursive: true });
await mkdir(indexDir, { recursive: true });
const logPath = join(sessionDir, 'session.v4.jsonl');

/** Deterministic pseudo-vectors, so the test needs no embedding endpoint. */
const stubEmbed = async (texts) => texts.map((text, i) => {
  const out = new Array(DIM).fill(0);
  for (let k = 0; k < text.length; k += 1) out[(text.charCodeAt(k) + k + i) % DIM] += 1;
  const norm = Math.hypot(...out) || 1;
  return out.map((v) => v / norm);
});

const event = (type, seq, text) => JSON.stringify({
  type,
  seq,
  time: 1_800_000_000_000 + seq * 1000,
  data: type === 'user/message'
    ? { content: [{ type: 'text', text }] }
    : { message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

const sentence = (n) => `这是一段用于增量索引测试的会话正文，编号 ${n}，长度足够形成记忆单元。`;

async function writeLog(lines) {
  await writeFile(logPath, `${[JSON.stringify({ type: 'session', id: 'abc' }), ...lines].join('\n')}\n`);
}

/** Write the log, then push its mtime back so the quiet window does not apply. */
async function writeLogSettled(lines) {
  await writeLog(lines);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

await writeFile(join(indexDir, 'index.ndjson.zstd'), '');
await writeIndex(indexDir, new MemoryIndex({ version: 1, dim: DIM, model: MODEL, builtAt: Date.now(), units: [] }));

const makeLive = (overrides = {}) => new LiveIndex(
  { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
  {
    indexDir,
    home,
    embed: { model: MODEL },
    embedFn: stubEmbed,
    liveIndex: { enabled: true, quietMs: 0, debounceMs: 600_000, startupDelayMs: 0, ...overrides },
  },
);

await check('a session log is discovered as one directory, newest version only', async () => {
  await writeLogSettled([event('user/message', 1, sentence(1))]);
  const logs = await listSessionLogs(join(home, 'sessions'));
  assert.deepEqual(logs, [logPath]);
  // A v3 copy beside the v4 file must not add a second entry.
  await writeFile(join(sessionDir, 'session.v3.jsonl'), '{"type":"session"}\n');
  assert.deepEqual(await listSessionLogs(join(home, 'sessions')), [logPath]);
  await rm(join(sessionDir, 'session.v3.jsonl'));
});

await check('the first pass indexes the session and records a watermark', async () => {
  const live = makeLive();
  const result = await live.runOnce({ force: true });
  assert.equal(result.units, 1, `expected one unit, got ${JSON.stringify(result)}`);
  const index = await readIndex(indexDir);
  assert.equal(index.size, 1);
  assert.equal(index.data.units[0].session, 'session-abc', 'the locator must name the directory that was read');
  assert.equal(index.data.units[0].seq, 1);
  const progress = JSON.parse(await readFile(progressPathFor(indexDir), 'utf8'));
  assert.equal(progress.sessions[logPath].lastSeq, 1, 'the watermark must advance to the last event seen');
});

await check('an unchanged session costs nothing', async () => {
  const live = makeLive();
  const result = await live.runOnce();
  assert.equal(result.sessions, 0, 'nothing should be read when the mtime did not move');
  assert.equal(result.units, 0);
});

await check('only the events past the watermark are indexed', async () => {
  await appendFile(logPath, `${[event('user/message', 2, sentence(2)), event('assistant/message', 3, sentence(3))].join('\n')}\n`);
  const live = makeLive();
  const result = await live.runOnce();
  assert.equal(result.units, 2, `expected the two new units, got ${JSON.stringify(result)}`);
  const index = await readIndex(indexDir);
  assert.equal(index.size, 3);
  assert.deepEqual(index.data.units.map((u) => u.seq).sort((a, b) => a - b), [1, 2, 3]);
});

await check('a re-read never duplicates a unit', async () => {
  // `force` ignores both the mtime and the quiet window, so the whole log is
  // re-parsed: hash dedup is what keeps the index a set rather than a log.
  const live = makeLive();
  const result = await live.runOnce({ force: true });
  assert.equal(result.units, 0, 'every unit was already known');
  assert.equal((await readIndex(indexDir)).size, 3);
});

await check('a log rewritten from scratch does not duplicate or lose units', async () => {
  // Simulates the writer compacting or replacing a log: the mtime moves, the
  // content is the same shape but the watermark is stale.
  await writeLogSettled([event('user/message', 1, sentence(1)), event('user/message', 2, sentence(2))]);
  const live = makeLive();
  await live.runOnce({ force: true });
  assert.equal((await readIndex(indexDir)).size, 3, 'the third unit is still there');
});

await check('the quiet window defers a session that is still being written', async () => {
  await writeLogSettled([event('user/message', 4, sentence(4))]);
  const live = makeLive({ quietMs: 60_000 });
  const result = await live.runOnce();
  assert.equal(result.units, 0, 'a session written seconds ago is not indexed yet');
  const forced = await live.runOnce({ force: true });
  assert.equal(forced.units, 1, 'forcing ignores the window');
});

await check('a model mismatch pauses the live path instead of mixing vector spaces', async () => {
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir, home, embed: { model: 'a-different-model' }, embedFn: stubEmbed, liveIndex: { quietMs: 0 } },
  );
  const result = await live.runOnce({ force: true });
  assert.equal(result.skipped, 'model-mismatch');
  assert.equal((await readIndex(indexDir)).size, 4, 'the index must be untouched');
});

await check('a held lock makes the pass step aside', async () => {
  const lock = join(indexDir, '.index.lock');
  await writeFile(lock, 'someone-else');
  const live = makeLive();
  const result = await live.runOnce({ force: true });
  assert.equal(result.skipped, 'locked');
  await rm(lock, { force: true });
  assert.equal((await live.runOnce({ force: true })).skipped, undefined, 'the lock is honoured, not permanent');
});

await check('the first pass seeds its watermarks from the existing index', async () => {
  // Without a progress file the naive behaviour is "everything is new", which on a
  // real corpus means re-reading a week of logs the index already covers. Seeding
  // from the index's build time plus its highest indexed seq per log keeps the
  // first pass exact and cheap.
  const fresh = join(dir, 'fresh-index');
  await mkdir(fresh, { recursive: true });
  const freshLog = join(sessionDir, 'session.v4.jsonl');
  await writeFile(freshLog, `${[JSON.stringify({ type: 'session', id: 'abc' }),
    event('user/message', 1, sentence(1)), event('user/message', 2, sentence(2))].join('\n')}\n`);
  const seeded = await readIndex(indexDir);
  const units = seeded.data.units.map((u) => ({ ...u, session: 'session-abc' }));
  await writeIndex(fresh, new MemoryIndex({
    version: 1, dim: DIM, model: MODEL,
    // Built *after* the log's mtime, so the log counts as already covered.
    builtAt: Date.now() + 60_000, units,
  }));
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir: fresh, home, embed: { model: MODEL }, embedFn: stubEmbed, liveIndex: { quietMs: 0 } },
  );
  const result = await live.runOnce();
  assert.equal(result.units, 0, 'nothing new should be found when the index is already current');
  assert.equal(result.sessions, 0, 'and no log should even be read');
  const progress = JSON.parse(await readFile(progressPathFor(fresh), 'utf8'));
  assert.ok(progress.sessions[freshLog].lastSeq >= 1, 'the seed records the highest indexed seq');
});

await check('the disabled switch stops it entirely', async () => {
  const live = makeLive({ enabled: false });
  assert.equal((await live.runOnce({ force: true })).skipped, 'disabled');
});

await check('a failed embedding leaves the index and the watermark intact', async () => {
  const before = (await readIndex(indexDir)).size;
  const progressBefore = JSON.parse(await readFile(progressPathFor(indexDir), 'utf8'));
  await writeLogSettled([event('user/message', 5, sentence(5))]);
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir, home, embed: { model: MODEL }, embedFn: async () => { throw new Error('endpoint down'); }, liveIndex: { quietMs: 0 } },
  );
  const result = await live.runOnce({ force: true });
  assert.equal(result.skipped, 'error', 'a failed pass must be reported, not thrown');
  assert.equal((await readIndex(indexDir)).size, before, 'the index must not gain half-embedded units');
  const progressAfter = JSON.parse(await readFile(progressPathFor(indexDir), 'utf8'));
  assert.equal(progressAfter.sessions[logPath].lastSeq, progressBefore.sessions[logPath].lastSeq,
    'the watermark must not advance past units that were never stored');
});

await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  live index: all checks passed\n'
  : `\n  live index: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
