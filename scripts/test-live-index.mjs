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
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, readIndex, writeIndex } from '../lib/store.mjs';
import { LiveIndex, listSessionLogs, progressPathFor, extractorPathFor } from '../lib/live-index.mjs';
import { EXTRACTOR_VERSION } from '../lib/session-source.mjs';
import { projectKey } from './workspace-key.mjs';
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

await check('a workspace maps to the session directory DSH would use', async () => {
  // A session lives at `sessions/<projectKey(cwd)>/<session id>/`. The rule is
  // transcribed from the harness (`dsh-session-persistence-jsonl`), and it was
  // checked against this machine: the derived key equalled the real directory name
  // for 10 of 10 sessions with a readable log header. `/` is the one case that can
  // be asserted without a filesystem, and it is the one every session started in an
  // unnamed directory lands in.
  assert.equal(projectKey('/'), '--root--');
  assert.equal(projectKey('/a/b'), '--a-b--');
  assert.equal(projectKey('/Users/x/.dsh/local-keep/dsh-g-memory'), '--Users-x-.dsh-local-keep-dsh-g-memory--',
    'dots and dashes stay as-is; only separators collapse');
  // The escape is `~` + four uppercase hex digits, with no trailing tilde — checked
  // against this machine's own directories, which contain `Application~0020Support`.
  assert.equal(projectKey('/tmp/a b'), '--tmp-a~0020b--', 'anything else is escaped, uppercase hex');
});

await check('a symlinked session log is not followed', async () => {
  // The walker is meant to read one DSH home and nothing else. Its sibling in the
  // CLI skips symlinks; this one had lost the guard when it was written, and the
  // inline implementation it replaced had it too. A link can point anywhere, so the
  // rule is the difference between "reads this home" and "reads whatever is linked
  // into it".
  const linkHome = join(dir, 'link-home');
  const linkDir = join(linkHome, 'sessions', '--tmp--', 'session-linked');
  await mkdir(linkDir, { recursive: true });
  const outside = join(dir, 'outside.jsonl');
  await writeFile(outside, `${JSON.stringify({ type: 'session', id: 'outside' })}\n`);
  await symlink(outside, join(linkDir, 'session.v4.jsonl'));
  assert.deepEqual(await listSessionLogs(join(linkHome, 'sessions')), [],
    'a linked log must not enter the index');
  // …while a real file in the same directory is still found, so the check is about
  // the link and not about the directory being skipped.
  await writeFile(join(linkDir, 'session.v3.jsonl'), `${JSON.stringify({ type: 'session', id: 'real' })}\n`);
  assert.deepEqual(await listSessionLogs(join(linkHome, 'sessions')), [join(linkDir, 'session.v3.jsonl')]);
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

await check('an index this revision already covers is not re-read', async () => {
  // With the revision recorded, watermarks can be seeded from the index's own build
  // time plus its highest indexed seq per log, so a first pass costs nothing.
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
  // First pass: no revision recorded yet, so this one re-reads (see the next check)
  // and records the revision.
  const first = await live.runOnce();
  assert.ok(first.sessions > 0, 'an unknown revision re-reads before it can be trusted');
  assert.equal(first.units, 0, 'and finds nothing new, because the text is already indexed');
  const progress = JSON.parse(await readFile(progressPathFor(fresh), 'utf8'));
  assert.ok(progress.sessions[freshLog].lastSeq >= 1, 'the seed records the highest indexed seq');
});

await check('the revision is recorded, so an upgrade re-reads exactly once', async () => {
  // Two failure modes meet here, and both were silent before:
  //   1. the revision never reaches disk -> every pass re-reads the whole corpus;
  //   2. the rescan seeds a non-zero mtime -> the mtime check skips every unchanged
  //      log and the upgrade does nothing at all.
  // Both are asserted through a NON-forced pass, because `force` bypasses the mtime
  // half of the check and would hide the second one.
  const revDir2 = join(dir, 'rev-record-index');
  await mkdir(revDir2, { recursive: true });
  const seeded = await readIndex(indexDir);
  await writeIndex(revDir2, new MemoryIndex({
    ...seeded.data,
    builtAt: Date.now() - 60_000,
    units: seeded.data.units.map((u) => ({ ...u, session: 'session-abc' })),
  }));
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir: revDir2, home, embed: { model: MODEL }, embedFn: stubEmbed, liveIndex: { quietMs: 0 } },
  );

  const upgrade = await live.runOnce();
  assert.ok(upgrade.sessions > 0, 'the unknown revision must actually re-read, mtime notwithstanding');

  const marked = JSON.parse(await readFile(extractorPathFor(revDir2), 'utf8'));
  assert.equal(marked.extractor, EXTRACTOR_VERSION, 'the pass must record which revision it used');

  // And once recorded, the next pass is incremental again: nothing changed, so
  // nothing is even read. Without the file this would be a full re-read every tick.
  const settled = await live.runOnce();
  assert.equal(settled.sessions, 0, 'a recorded revision must stop the re-reading');
  assert.equal(settled.units, 0);

  // A different revision is re-read once more, not never and not always.
  await writeFile(extractorPathFor(revDir2), JSON.stringify({ extractor: EXTRACTOR_VERSION + 1 }));
  assert.ok((await live.runOnce()).sessions > 0, 'an older or newer revision re-reads');
  assert.equal((await live.runOnce()).sessions, 0, 'and is recorded again when it finishes');
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

await check('a pass that hits the unit cap does not mark dropped units as processed', async () => {
  // The cap falls inside a log, not between logs. Advancing that log's watermark
  // and mtime anyway — which the pass used to do — drops its remaining units
  // permanently: the next pass sees an unchanged mtime and never looks again.
  // Three 4-unit logs with a cap of 2: before the fix the index settled at 4 of 12.
  const capDir = join(dir, 'cap-index');
  const capHome = join(dir, 'cap-home');
  await mkdir(capDir, { recursive: true });
  const makeSession = async (name, count) => {
    const sessionPath = join(capHome, 'sessions', '--root--', name);
    await mkdir(sessionPath, { recursive: true });
    const lines = [JSON.stringify({ type: 'session', id: name })];
    for (let i = 1; i <= count; i += 1) lines.push(event('user/message', i, sentence(`${name}-${i}`)));
    await writeFile(join(sessionPath, 'session.v4.jsonl'), `${lines.join('\n')}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await makeSession('session-a', 4);
  await makeSession('session-b', 4);
  await makeSession('session-c', 4);
  // `builtAt` is deliberately *older* than the logs: a fresh index is seeded with
  // mtime = builtAt, so a log written after the build is read and one written
  // before it counts as already covered.
  await writeIndex(capDir, new MemoryIndex({ version: 1, dim: DIM, model: MODEL, builtAt: Date.now() - 60_000, units: [] }));
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    {
      indexDir: capDir, home: capHome, embed: { model: MODEL }, embedFn: stubEmbed,
      liveIndex: { enabled: true, quietMs: 0, debounceMs: 600_000, startupDelayMs: 0, maxUnitsPerTick: 2 },
    },
  );
  // Each pass is capped at 2 units, so convergence takes several; the point is
  // that it converges at all. Deliberately NOT `force`: forcing re-reads logs that
  // are already complete, and those occupy the per-pass log budget forever, which
  // is a property of the test harness rather than of the pass under test.
  for (let pass = 0; pass < 10; pass += 1) await live.runOnce();
  const index = await readIndex(capDir);
  assert.equal(index.size, 12, `every unit must eventually be indexed, got ${index.size} of 12`);
  const seqs = index.data.units.map((u) => u.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], 'and none of them may be missing');
});

await check('a new extractor revision re-reads logs the watermark had already passed', async () => {
  // Watermarks are only valid for the extraction rule that set them. When the rule
  // starts admitting a new kind of event (tool calls, here), every already-processed
  // session would keep missing those units forever — and it would look exactly like
  // a corpus that has no such events.
  const revDir = join(dir, 'rev-index');
  const revHome = join(dir, 'rev-home');
  const revSession = join(revHome, 'sessions', '--root--', 'session-rev');
  await mkdir(revSession, { recursive: true });
  await mkdir(revDir, { recursive: true });
  const revLog = join(revSession, 'session.v4.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', id: 'rev' }),
    event('user/message', 1, sentence('rev-1')),
    JSON.stringify({
      type: 'tool/call',
      seq: 2,
      time: 1_800_000_002_000,
      data: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/rev.mjs', content: sentence('rev-written') }) },
    }),
  ];
  await writeFile(revLog, `${lines.join('\n')}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeIndex(revDir, new MemoryIndex({ version: 1, dim: DIM, model: MODEL, builtAt: Date.now(), units: [] }));
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir: revDir, home: revHome, embed: { model: MODEL }, embedFn: stubEmbed, liveIndex: { quietMs: 0 } },
  );
  const first = await live.runOnce({ force: true });
  assert.equal(first.units, 2, `the conversation and the authoring call both index, got ${first.units}`);
  // As an older revision would have left it: watermarks current, and no marker
  // file at all.
  await rm(extractorPathFor(revDir), { force: true });
  // And make the index look like it was built by that older rule: conversation
  // only, so the authoring unit is missing and the watermark hides it.
  const current = await readIndex(revDir);
  await writeIndex(revDir, new MemoryIndex({
    ...current.data,
    units: current.data.units.filter((u) => u.role !== 'action'),
  }));
  assert.equal((await readIndex(revDir)).size, 1);
  const rescanned = await live.runOnce({ force: true });
  assert.equal(rescanned.units, 1, 'the rescan must recover the unit the old rule never made');
  assert.equal((await readIndex(revDir)).size, 2, 'and it must not duplicate what was already indexed');
});

await check('a role that was stored wrongly is repaired even though the text is known', async () => {
  // Dedup is by content hash, and the hash covers the text but not the role. So a
  // role stored wrongly is not self-correcting: every later re-read matches on the
  // hash and skips the unit, and the wrong role survives every rebuild.
  //
  // This is not hypothetical. An index written by a version whose role whitelist did
  // not know `action` reads back with those units relabelled `tool` (measured on the
  // live store: 0 rows carrying `action`, 699 units whose text begins `[write] `/
  // `[edit] `/`[str_replace_editor] `). The text still retrieves, but the label —
  // which is what tells the model it is looking at a past tool call rather than at
  // conversation — was permanently wrong, and the rescan that restored the text
  // could not restore the role.
  const roleDir = join(dir, 'role-index');
  const roleHome = join(dir, 'role-home');
  const roleSession = join(roleHome, 'sessions', '--root--', 'session-role');
  await mkdir(roleSession, { recursive: true });
  await mkdir(roleDir, { recursive: true });
  await writeFile(join(roleSession, 'session.v4.jsonl'), `${[
    JSON.stringify({ type: 'session', id: 'role' }),
    event('user/message', 1, sentence('role-1')),
    JSON.stringify({
      type: 'tool/call',
      seq: 2,
      time: 1_800_000_002_000,
      data: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/role.mjs', content: sentence('role-written') }) },
    }),
  ].join('\n')}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeIndex(roleDir, new MemoryIndex({ version: 1, dim: DIM, model: MODEL, builtAt: Date.now() - 60_000, units: [] }));
  const live = new LiveIndex(
    { on: () => () => {}, logger: { debug: () => {}, warn: () => {} } },
    { indexDir: roleDir, home: roleHome, embed: { model: MODEL }, embedFn: stubEmbed, liveIndex: { quietMs: 0 } },
  );
  await live.runOnce();
  const indexed = await readIndex(roleDir);
  assert.equal(indexed.data.units.filter((u) => u.role === 'action').length, 1, 'the call indexes as an action first');

  // Now simulate the old reader's wash: same text, same hash, role rewritten.
  await writeIndex(roleDir, new MemoryIndex({
    ...indexed.data,
    units: indexed.data.units.map((u) => (u.role === 'action' ? { ...u, role: 'tool' } : u)),
  }));
  assert.equal((await readIndex(roleDir)).data.units.filter((u) => u.role === 'action').length, 0);

  // The repair rides the rescan, and that is the only pass that re-reads events the
  // watermark has already passed — `force` moves the mtime check aside but leaves
  // the watermark alone, so it cannot see this event again. The progress file is
  // rewritten the way the old process left it (extractor field stripped), which is
  // exactly the state the live store was found in.
  await rm(extractorPathFor(roleDir), { force: true });

  const repaired = await live.runOnce({ force: true });
  assert.equal(repaired.units, 0, 'no new text: the repair is not a re-index');
  assert.equal(repaired.relabelled, 1, 'the pass must report what it corrected');
  const after = await readIndex(roleDir);
  assert.equal(after.data.units.filter((u) => u.role === 'action').length, 1, 'the role must come back');
  assert.equal(after.size, 2, 'and nothing may be duplicated');

  // A pass that changes nothing must not claim to have relabelled anything.
  const quiet = await live.runOnce({ force: true });
  assert.equal(quiet.relabelled, 0);
  assert.equal(quiet.units, 0);
});

await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  live index: all checks passed\n'
  : `\n  live index: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
