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
import { consolidateSession } from '../lib/consolidate.mjs';
import { readCards } from '../lib/cards.mjs';
import { l2Normalize } from '../lib/vector.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/** A summary long enough to pass parseCard's 30-character floor. */
const SUMMARY = '这条会话判断的核心结论是：嵌入模型换成 Gemma 之后，索引必须整体重建而不能复用旧向量。';
const mode = { value: 'ok' };

const server = createServer((req, res) => {
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

server.close();
await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  consolidation: all checks passed\n'
  : `\n  consolidation: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
