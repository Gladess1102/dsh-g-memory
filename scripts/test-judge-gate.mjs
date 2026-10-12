#!/usr/bin/env node
/**
 * The judge as a gate on the live path.
 *
 * What this pins down is the thing that makes the judge worth having: when it
 * says "this turn does not want memory", the pipeline must not run at all.
 * Skipping the embedding, the recall and the rerank is the difference between a
 * decision that costs one call and a decision that costs one call *plus* the
 * three-to-eleven seconds the retrieval would have spent — and on the traffic
 * measured on 2026-10-13 (a real chat message scores a median of -1.49 against a
 * floor of 3) that retrieval was going to throw its result away anyway.
 *
 * Hermetic: a stub embedder counts its own requests, a one-unit fixture index,
 * no network, no model. The rules layer is the backend under test, so no judge
 * endpoint is needed either.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, writeIndex } from '../lib/store.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';
import { AutoRecall } from '../lib/auto-recall.mjs';

const statsPath = join(mkdtempSync(join(tmpdir(), 'gm-judge-gate-')), 'stats.jsonl');
process.env.DSH_G_MEMORY_AUTO_STATS = statsPath;

const sha1 = (text) => createHash('sha1').update(String(text));
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
  return l2Normalize(v);
}

/** The stub embedder, counting how often the pipeline actually reaches it. */
let embedRequests = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    embedRequests += 1;
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep empty */ }
    const input = payload.input ?? [];
    const list = Array.isArray(input) ? input : [input];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: list.map((text, index) => ({ index, embedding: fixtureVector(text, 64) })) }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const embedUrl = 'http://127.0.0.1:' + server.address().port;

const memory = 'llama-server 的物理批上限是 512 token，超过就会被截断。';
const dir = mkdtempSync(join(tmpdir(), 'gm-judge-index-'));
{
  const { codes, scale } = quantizeInt8(fixtureVector(memory, 64));
  await writeIndex(dir, new MemoryIndex({
    version: 1, dim: 64, model: 'fixture', builtAt: Date.now(),
    units: [{ text: memory, role: 'user', session: 'fixture', seq: 0, time: Date.now(), hash: sha1(memory).digest('hex'), vector: packVector(codes, scale) }],
  }));
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

const events = async () => {
  await new Promise((r) => setTimeout(r, 120));
  try { return readFileSync(statsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const makeRecall = (judge) => new AutoRecall({ logger: { debug() {}, info() {} } }, {
  indexDir: dir,
  embed: { url: embedUrl, model: 'fixture' },
  rerank: { url: '' },
  consolidate: false,
  judge,
});

console.log('judge gate');

await check('judge off leaves the pipeline exactly as it was', async () => {
  const before = embedRequests;
  const ar = makeRecall({ provider: 'off' });
  ar.start('agent-off', '今天天气不错，随便聊聊吧');
  const log = await events();
  assert.equal(embedRequests - before, 1, 'the embedder is still called when the judge is off');
  assert.equal(log.filter((e) => e.event === 'judge').length, 0, 'and no judge event is written');
});

await check('a turn the judge skips never reaches the embedder', async () => {
  const before = embedRequests;
  const ar = makeRecall({ provider: 'rules' });
  ar.start('agent-skip', '今天天气不错，随便聊聊吧');
  const log = await events();
  assert.equal(embedRequests - before, 0, 'the whole retrieval pipeline is skipped');
  const judge = log.filter((e) => e.event === 'judge').pop();
  assert.ok(judge, 'the decision is recorded');
  assert.equal(judge.verdict, 'skip');
  assert.equal(judge.source, 'rules');
  assert.ok(typeof judge.ms === 'number', 'the decision carries its own cost');
});

await check('a turn the judge fires on does reach the embedder', async () => {
  const before = embedRequests;
  const ar = makeRecall({ provider: 'rules' });
  ar.start('agent-fire', '你还记得我们上次说的那个物理批上限吗');
  const log = await events();
  assert.ok(embedRequests - before >= 1, 'retrieval runs after the judge says yes');
  const judge = log.filter((e) => e.event === 'judge').pop();
  assert.equal(judge.verdict, 'fire');
  assert.equal(judge.kind, 'explicit');
  assert.equal(judge.confidence, 1);
});

await check('the skipped turn parks an empty result with the reason attached', async () => {
  const ar = makeRecall({ provider: 'rules' });
  // Longer than MIN_QUERY_CHARS on purpose: a six-character message never
  // reaches the judge at all, which is a different (and earlier) skip.
  ar.start('agent-reason', '今天天气不错，随便聊聊吧');
  await new Promise((r) => setTimeout(r, 120));
  const entry = ar.pending.get('agent-reason');
  assert.equal(entry.status, 'empty');
  assert.match(String(entry.reason), /judge: none/);
});

await check('the first turn of a session is knowable', async () => {
  const ar = makeRecall({ provider: 'off' });
  ar.start('agent-turns', '第一条消息，足够长了吧');
  ar.start('agent-turns', '第二条消息，也足够长');
  assert.equal(ar.turnCounts.get('agent-turns'), 2);
});

server.close();
rmSync(dir, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'judge gate: all checks passed' : 'judge gate: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
