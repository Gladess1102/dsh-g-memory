#!/usr/bin/env node
/**
 * The resident layer: a session starts with its working set.
 *
 * The checks that matter here are negative ones. This layer runs before the
 * judge and before retrieval, and it injects text it did not rank by any score —
 * so what has to be true is that it stays silent when it has no name to match, it
 * stays silent when it is switched off, it never surfaces a withdrawn memory, and
 * it only speaks on the first turn. A resident layer that leaks a superseded
 * memory into every session would be worse than the silence it replaces.
 *
 * Hermetic: cards written into a temporary DSH_HOME, a stub embedder, a two-unit
 * fixture index, no network.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, writeIndex } from '../lib/store.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';
import { writeCards } from '../lib/cards.mjs';

const home = mkdtempSync(join(tmpdir(), 'gm-resident-'));
process.env.DSH_HOME = home;
process.env.DSH_G_MEMORY_AUTO_STATS = join(home, 'stats.jsonl');

const { AutoRecall } = await import('../lib/auto-recall.mjs');

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
  return Array.from(l2Normalize(v));
}

let embedRequests = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    embedRequests += 1;
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep empty */ }
    const list = Array.isArray(payload.input) ? payload.input : [payload.input];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: list.map((text, index) => ({ index, embedding: fixtureVector(text, 64) })) }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const embedUrl = 'http://127.0.0.1:' + server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'gm-resident-index-'));
{
  const unit = (text, seq) => {
    const { codes, scale } = quantizeInt8(l2Normalize(fixtureVector(text, 64)));
    return { text, role: 'user', session: 'fixture', seq, time: Date.now(), hash: sha1(text).digest('hex'), vector: packVector(codes, scale) };
  };
  await writeIndex(dir, new MemoryIndex({
    version: 1, dim: 64, model: 'fixture', builtAt: Date.now(),
    units: [unit('llama-server 的物理批上限是 512 token。', 0), unit('无关记录：今天天气不错。', 1)],
  }));
}

const now = Date.now();
const card = (id, summary, extra = {}) => ({ id, session: 'session-fixture', time: now, summary, tags: [], hash: sha1(summary).digest('hex').slice(0, 24), ...extra });
await writeCards([
  card('11111111111111111111', 'dsh-g-memory 的常驻层用卡片的确定性命名匹配，不做分数阈值。', { tags: ['dsh-g-memory'] }),
  card('22222222222222222222', '无关的旧记录：关于香水与天气。', { tags: ['生活'] }),
  card('33333333333333333333', 'dsh-g-memory 的旧结论已被取代。', { tags: ['dsh-g-memory'], status: 'superseded', supersededBy: '11111111111111111111' }),
], join(home, 'dsh-g-memory', 'cards.ndjson'));

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
/**
 * Events for one agent only.
 *
 * The log is append-only and shared across checks, so counting "resident events"
 * without filtering reads every earlier check's work as this one's. The session
 * field (the agent id, trimmed) is what makes the question askable.
 */
const eventsFor = async (agent) => {
  await new Promise((r) => setTimeout(r, 120));
  try {
    return readFileSync(process.env.DSH_G_MEMORY_AUTO_STATS, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.session === agent);
  } catch { return []; }
};
const WORKSPACE = '/Users/yangyuxin/.dsh/local-keep/dsh-g-memory';
const makeRecall = (resident, cwd = WORKSPACE) => new AutoRecall({ logger: { debug() {}, info() {} } }, {
  indexDir: dir,
  embed: { url: embedUrl, model: 'fixture' },
  rerank: { url: '' },
  consolidate: false,
  cwd,
  resident,
});

console.log('resident layer');

await check('off by default: nothing is injected and nothing is recorded', async () => {
  const ar = makeRecall(undefined);
  ar.start('agent-off', '继续 dsh-g-memory 插件的活');
  await new Promise((r) => setTimeout(r, 700));
  const log = await eventsFor('agent-off');
  assert.equal(log.filter((e) => e.event === 'resident').length, 0, 'the layer stays out of the way');
  // The ordinary path still runs — that is the point of the switch — so the
  // pending state is deliberately not asserted here.
  assert.ok(ar.pending.get('agent-off'), 'the ordinary path still produced a result');
});

await check('the opening turn gets the named card, and only the named card', async () => {
  const ar = makeRecall({ enabled: true });
  ar.start('agent-on', '继续 dsh-g-memory 插件的活，把常驻层做完');
  await new Promise((r) => setTimeout(r, 700));
  const entry = ar.pending.get('agent-on');
  assert.equal(entry?.status, 'ready', 'the working set is injected');
  assert.match(String(entry.text), /常驻层用卡片的确定性命名匹配/, 'the matching card is there');
  assert.ok(!/香水/.test(String(entry.text)), 'the unrelated card is not');
  assert.ok(!/旧结论已被取代/.test(String(entry.text)), 'a superseded memory is never surfaced');
  const log = await eventsFor('agent-on');
  const resident = log.filter((e) => e.event === 'resident').pop();
  assert.ok(resident, 'the decision is recorded');
  assert.equal(resident.cards, 1);
  assert.ok(Array.isArray(resident.why) && resident.why.length > 0, 'and carries why');
  assert.ok(resident.why.some((w) => String(w).startsWith('name')), 'a name match is what put it there');
});

await check('later turns do not re-inject the working set', async () => {
  const ar = makeRecall({ enabled: true });
  ar.start('agent-later', '继续 dsh-g-memory 插件的活');
  await new Promise((r) => setTimeout(r, 700));
  const before = ar.pending.get('agent-later');
  assert.equal(before?.status, 'ready');
  ar.start('agent-later', '再问一句 dsh-g-memory 的事');
  await new Promise((r) => setTimeout(r, 500));
  const log = await eventsFor('agent-later');
  assert.equal(log.filter((e) => e.event === 'resident').length, 1, 'the resident layer speaks once per session');
});

await check('no shared name anywhere: the layer stays silent', async () => {
  const ar = makeRecall({ enabled: true }, '/tmp/unrelated-project');
  ar.start('agent-nomatch', '今天天气不错，随便聊聊吧');
  await new Promise((r) => setTimeout(r, 700));
  const log = await eventsFor('agent-nomatch');
  assert.equal(log.filter((e) => e.event === 'resident').length, 0, 'no card is dragged in by recency alone');
});

await check('same workspace is itself a reason: project memory comes back with the project', async () => {
  const ar = makeRecall({ enabled: true }, WORKSPACE);
  ar.start('agent-workspace', '今天天气不错，随便聊聊吧');
  await new Promise((r) => setTimeout(r, 700));
  const log = await eventsFor('agent-workspace');
  const resident = log.filter((e) => e.event === 'resident').pop();
  assert.ok(resident, 'opening the project brings its memory with it, message aside');
  assert.ok(resident.why.some((w) => String(w).startsWith('cwd')), 'and the reason recorded is the workspace');
});

server.close();
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'resident: all checks passed' : 'resident: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
