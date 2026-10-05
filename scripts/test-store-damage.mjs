#!/usr/bin/env node
/**
 * Store damage checks: what happens when the index on disk is not intact.
 *
 * `deserializeIndex` is deliberately defensive — it coerces, validates the vector
 * width and drops what it cannot trust — and `readIndex` falls back to the
 * uncompressed copy when the compressed one will not decompress. Neither was
 * covered by a test, and neither reported anything: the index silently served
 * fewer units, or an older copy, with nothing to explain the change.
 *
 *   node scripts/test-store-damage.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryIndex, writeIndex, readIndex, serializeIndex, deserializeIndex,
  lastSkippedRows, lastCompressedError, reportIndexDamage,
} from '../lib/store.mjs';
import { renderRecall } from '../lib/inject.mjs';
import { indexFingerprint } from '../lib/cache.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';

const DIM = 8;
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

const unit = (text, i) => ({
  text, role: 'user', session: 'fixture', seq: i, time: Date.now() - 86_400_000,
  hash: `h${i}`, vector: (() => { const { codes, scale } = quantizeInt8(l2Normalize(Float32Array.from({ length: DIM }, (_, j) => (i + 1) * (j + 1)))); return packVector(codes, scale); })(),
});
const fixture = () => new MemoryIndex({ version: 1, dim: DIM, model: 'fixture', builtAt: Date.now(), units: [unit('第一段记忆', 0), unit('第二段记忆', 1)] });

const dir = await mkdtemp(join(tmpdir(), 'gm-damage-'));
await writeIndex(dir, fixture());

await check('a healthy index reads back whole', async () => {
  const index = await readIndex(dir);
  assert.equal(index.size, 2);
  assert.equal(lastSkippedRows, 0);
  assert.equal(lastCompressedError, null);
});

await check('a row with the wrong vector width is dropped, not coerced', async () => {
  const raw = serializeIndex(fixture());
  const lines = raw.split('\n').filter(Boolean);
  lines.push(JSON.stringify({ text: '宽度不对', role: 'user', session: 'x', seq: 9, time: 1, hash: 'bad', vector: Buffer.alloc(3).toString('base64') }));
  await writeFile(join(dir, 'index.ndjson'), `${lines.join('\n')}\n`);
  await rm(join(dir, 'index.ndjson.zstd'), { force: true });
  const index = await readIndex(dir);
  assert.equal(index.size, 2, 'the damaged row must not enter the index');
  assert.equal(lastSkippedRows, 1, 'and it must be counted');
});

await check('a malformed JSON row is dropped and counted', async () => {
  const raw = serializeIndex(fixture());
  await writeFile(join(dir, 'index.ndjson'), `${raw}not json at all\n`);
  const index = await readIndex(dir);
  assert.equal(index.size, 2);
  assert.equal(lastSkippedRows, 1);
});

await check('an index with no header is refused rather than half-read', async () => {
  const bare = join(dir, 'bare');
  await rm(bare, { recursive: true, force: true });
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, 'index.ndjson'), `${JSON.stringify({ text: '无头' })}\n`);
  await assert.rejects(() => readIndex(bare), /missing its header|empty/);
});

await check('an unsupported index version is refused', async () => {
  const future = join(dir, 'future');
  await rm(future, { recursive: true, force: true });
  await mkdir(future, { recursive: true });
  const header = JSON.parse(serializeIndex(fixture()).split('\n')[0]);
  header.version = 99;
  await writeFile(join(future, 'index.ndjson'), `${JSON.stringify(header)}\n`);
  await assert.rejects(() => readIndex(future), /version 99 is not supported/);
});

await check('an unreadable compressed copy falls back to the raw one, and says so', async () => {
  // The raw copy is no longer written by default (it cost 30.7 MB of 46 MB, and the
  // compressed read measured no slower), so the fallback scenario has to ask for it
  // explicitly — which is also the only way it exists in production: a machine
  // without the zstd CLI.
  await writeIndex(dir, fixture(), { plain: true });
  await writeFile(join(dir, 'index.ndjson.zstd'), Buffer.from('this is not zstd'));
  const index = await readIndex(dir);
  assert.equal(index.size, 2, 'the raw copy must still answer');
  assert.ok(lastCompressedError, 'the fallback must be recorded, not swallowed');

  const warnings = [];
  reportIndexDamage({ warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, 'a standing condition warns once');
  assert.match(warnings[0], /compressed index unusable/);
  reportIndexDamage({ warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, 'and does not repeat while it persists');
});

await check('damage reporting is silent on a healthy index', async () => {
  await writeIndex(dir, fixture());
  await readIndex(dir);
  const warnings = [];
  reportIndexDamage({ warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 0);
});

await check('the index is stored once, as one complete file', async () => {
  // What used to be tested here was "the raw copy survives a crash between the two
  // writes". With one copy the property that matters is atomicity: the visible index
  // is always a complete file, and a leftover temp file from an interrupted write is
  // ignored rather than parsed.
  await writeIndex(dir, fixture());
  const files = (await readdir(dir)).filter((f) => f.startsWith('index.ndjson'));
  assert.deepEqual(files, ['index.ndjson.zstd'], `expected a single index file, got ${files.join(', ')}`);

  // A crash between write and rename leaves a temp file behind; it must not confuse
  // the reader, which picks the index by name.
  await writeFile(join(dir, 'index.ndjson.zstd.tmp-99999'), 'half a file');
  const index = await readIndex(dir);
  assert.equal(index.size, 2, 'the complete copy must still answer');

  // And the raw copy can still be asked for, which is what a machine without zstd
  // gets — verified by reading it back with the compressed copy removed.
  await writeIndex(dir, fixture(), { plain: true });
  await rm(join(dir, 'index.ndjson.zstd'), { force: true });
  const fallback = await readIndex(dir);
  assert.equal(fallback.size, 2, 'the raw copy must answer on its own');
});

await check('an orphaned unit survives the round trip and is labelled unverifiable', async () => {
  // The build marks units whose source session is gone. That flag used to be
  // computed and then dropped by the serialiser, so the injection layer presented
  // a memory with no transcript behind it as "verbatim, checkable against source".
  const indexed = fixture();
  indexed.data.units[0].orphaned = true;
  const back = deserializeIndex(serializeIndex(indexed));
  assert.equal(back.unit(0).orphaned, true, 'the flag must survive the index');
  assert.equal(back.unit(1).orphaned, false, 'and must not spread to its neighbours');

  const block = renderRecall([
    { text: back.unit(0).text, time: Date.now() - 86_400_000, session: 's', seq: 0, orphaned: back.unit(0).orphaned },
    { text: back.unit(1).text, time: Date.now() - 86_400_000, session: 's', seq: 1, orphaned: back.unit(1).orphaned },
  ], { maxTotalChars: 2000 });
  // Count the label, not the word: the frame's closing lines explain what
  // "unverifiable" means, so the bare word is always present once.
  const labels = block.match(/unverifiable \(source deleted\)/g) ?? [];
  assert.equal(labels.length, 1, 'exactly the orphan entry must carry the label');
  const orphanLine = block.split('\n').find((l) => l.includes('第一段记忆'));
  const plainLine = block.split('\n').find((l) => l.includes('第二段记忆'));
  assert.match(orphanLine, /unverifiable \(source deleted\)/);
  assert.doesNotMatch(plainLine, /unverifiable \(source deleted\)/);
});

await check('an authoring unit keeps its role across the round trip', async () => {
  // The deserialiser coerces any role it does not recognise to `tool`. That turned
  // an `action` unit — a tool the agent *issued* — back into a tool *result* on
  // every read, so the label the synthesis prompt uses would have been wrong for
  // 2.12 MiB of authored content while the index itself looked correct.
  const indexed = fixture();
  indexed.data.units[0].role = 'action';
  const back = deserializeIndex(serializeIndex(indexed));
  assert.equal(back.unit(0).role, 'action', 'a known role must survive');
  assert.equal(back.unit(1).role, 'user', 'and its neighbours must be untouched');

  // An unknown role is still coerced rather than trusted: the whitelist is what
  // stops a hand-edited index from inventing a role nothing else understands.
  const damaged = fixture();
  damaged.data.units[0].role = 'root';
  assert.equal(deserializeIndex(serializeIndex(damaged)).unit(0).role, 'tool');
});

await check('the cache fingerprint changes when the embedding model does', async () => {
  // Content hashes are model-independent, so a fingerprint built only from them
  // was identical across models — and a synthesis answer produced from the old
  // model's retrieval was then served for the new model's.
  const a = fixture();
  const b = fixture();
  b.data.model = 'a-different-model';
  assert.notEqual(indexFingerprint(a), indexFingerprint(b));
  const c = fixture();
  c.data.dim = 1024;
  assert.notEqual(indexFingerprint(a), indexFingerprint(c));
  assert.equal(indexFingerprint(a), indexFingerprint(fixture()), 'the same index must fingerprint the same');
});

await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  store damage: all checks passed\n'
  : `\n  store damage: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
