#!/usr/bin/env node
/**
 * Hermetic end-to-end check: the automatic path, with nothing external.
 *
 * The suite's live checks run against the *production* index and a hard-coded
 * query, so their verdict moves when the corpus or the embedding model changes —
 * that is how a green suite coexisted with a gate that had been a no-op for 27
 * hours, and how the same code produced 35/35 and 33/35 on different days.
 *
 * This one owns its inputs: a stub embedding server with a deterministic vector
 * function, a fixture index built from it, and the real plugin on top. No
 * network, no model, no session history — just the decision path.
 *
 *   node scripts/test-e2e-hermetic.mjs
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, writeIndex, prepareQueryVector } from '../lib/store.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';
import { apply } from '../lib/index.js';
// Tests must not write the production decision log: `record()` appends to
// DSH_G_MEMORY_AUTO_STATS, and a simulated failure that lands in the real telemetry
// looks exactly like a production failure. Point it at a temp file for this process.
process.env.DSH_G_MEMORY_AUTO_STATS = join(await mkdtemp(join(tmpdir(), 'gm-stats-')), 'stats.jsonl');

const DIM = 64;
let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failures += 1; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
};

/** Deterministic vector: hashed character bigrams, L2-normalised. */
function vectorOf(text) {
  const v = new Array(DIM).fill(0);
  const s = String(text).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    for (const gram of [s.slice(i, i + 1), s.slice(i, i + 2)]) {
      if (!gram) continue;
      const h = createHash('sha1').update(gram).digest();
      v[h[0] % DIM] += 1;
      v[h[1] % DIM] += 0.5;
    }
  }
  return l2Normalize(v);
}

// ── stub server: embeddings *and* a cross-encoder ────────────────────────────
//
// Deterministic, and query-sensitive — both matter. The first version scored a
// document by a marker it contained, ignoring the query entirely, so an
// unrelated question still cleared the gate and the check was vacuous. This one
// counts shared character bigrams, which is what a cross-encoder approximates:
// a related pair shares vocabulary, an unrelated pair does not.
const bigrams = (text) => {
  const s = String(text).toLowerCase();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
};
const SHARED_BIGRAMS_TO_PASS = 3;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* keep empty */ }
    if (req.url.startsWith('/v1/rerank')) {
      const queryGrams = bigrams(payload.query ?? '');
      const documents = payload.documents ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: documents.map((doc, index) => {
          const docGrams = bigrams(doc);
          let shared = 0;
          for (const gram of queryGrams) if (docGrams.has(gram)) shared += 1;
          return { index, relevance_score: shared >= SHARED_BIGRAMS_TO_PASS ? 2 : -2 };
        }),
      }));
      return;
    }
    const input = payload.input ?? [];
    const list = Array.isArray(input) ? input : [input];
    res.writeHead(200, { 'content-type': 'application/json' });
    // Float32Array would serialise to an object, not an array, and the client
    // rejects that — correctly.
    res.end(JSON.stringify({ data: list.map((text, index) => ({ index, embedding: Array.from(vectorOf(text)) })) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

// ── fixture index, same vector function ──────────────────────────────────────
const MEMORY = '生产记忆库的嵌入模型已切换为 EmbeddingGemma-300M，体积减半。';
const UNRELATED = '南极科考站的柴油发电机每两千小时维护一次。';
// Four units, and the count matters: the head-margin rule only applies once three
// candidates have been scored, so a two-unit fixture silently skipped it — the
// degraded-path check below passed for the wrong reason until a mutation showed it.
const FILLER_UNITS = [
  '这个夹具需要足够的单元数，否则头部间距规则根本不会生效。',
  '第四段用于凑够候选数量，让闸门真的去读前几名的分差。',
];
const dir = await mkdtemp(join(tmpdir(), 'gm-hermetic-'));
const units = [MEMORY, UNRELATED, ...FILLER_UNITS].map((text, i) => ({
  text, role: 'user', session: 'fixture', seq: i, time: Date.now(),
  hash: createHash('sha1').update(text).digest('hex'),
  vector: (() => { const { codes, scale } = quantizeInt8(vectorOf(text)); return packVector(codes, scale); })(),
}));
await writeIndex(dir, new MemoryIndex({ version: 1, dim: DIM, model: 'fixture', builtAt: Date.now(), units }));

// ── the plugin, with the fixture wired in through options ────────────────────
const listeners = new Map();
/**
 * Apply the plugin to a fresh context and feed it one user turn.
 *
 * A function rather than top-level code because there are two configurations to
 * check and each needs its own listener set.
 */
async function scenario(name, config, agentId, question) {
  const listeners = new Map();
  const ctx = {
    get: (n) => (n === 'tools' ? { register: () => () => {} } : null),
    on: (n, fn) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); return () => {}; },
    effect: (fn) => { fn(); return () => {}; },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  };
  apply(ctx, { indexDir: dir, embed: { url, model: 'fixture' }, synthesis: { enabled: false }, liveIndex: { enabled: false }, ...config });

  const onInsert = (listeners.get('agent/inbox/inserted') || [])[0];
  const preStep = (listeners.get('agent/pre-step') || [])[0];
  check(`${name}: the automatic path registered its listeners`, Boolean(onInsert && preStep));
  if (!onInsert || !preStep) return null;

  onInsert({ agent: { id: agentId }, message: { role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } } });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const decision = await preStep({ agent: { id: agentId } },
      async () => ({ kind: 'enter', messages: [{ id: 'u', role: 'user', source: { kind: 'user' } }] }));
    if (decision.messages.length > 1) return decision.messages[0];
  }
  return null;
}

// ── scenario 1: the configured path — reranker + head-margin gate ────────────
const injected = await scenario('reranked', {
  // Passed as composition config, not as an environment variable: that is the path
  // that was broken — `options.rerank` never reached AutoRecall.
  rerank: { url, model: 'fixture-rerank' },
  // Also composition: `resolvePolicy` used to accept `overrides` and ignore it, so
  // a policy configured here had no effect at all.
  policy: { marginGate: 1.18 },
}, 't-memory', '嵌入模型换成什么了');

check('a query about a stored memory is recalled', injected !== null);
if (injected) {
  const text = injected.content.map((c) => c.text || '').join('');
  check('the recalled payload is framed as untrusted', /untrusted background information/i.test(text));
  check('the recalled payload carries the fixture memory', text.includes('EmbeddingGemma-300M'));
  check('the injected message uses the v4 source kind',
    injected.source?.kind === 'plugin:dsh-g-memory', `got ${JSON.stringify(injected.source)}`);
  check('the injected message is well-formed', injected.role === 'user' && Array.isArray(injected.content));
  check('the block respects the injection budget', text.length <= 1200, `got ${text.length}`);
}

const nothing = await scenario('reranked', { rerank: { url, model: 'fixture-rerank' }, policy: { marginGate: 1.18 } },
  't-none', '钢琴调律的标准音高是多少赫兹');
check('an unrelated question recalls nothing', nothing === null,
  nothing ? `got ${nothing.content.map((c) => c.text).join('').slice(0, 120)}` : '');

// ── scenario 2: no reranker, margin gate on ─────────────────────────────────
//
// The margin compares the separation between the top candidates, which only means
// anything on the cross-encoder's unbounded scale. On the fused RRF scale every
// score sits within 1/61 of the next, so applying it there would reject every
// turn — the degraded path has to switch it off, and that is what this checks.
const degraded = await scenario('degraded', {
  rerank: { url: '' },
  policy: { marginGate: 1.18 },
}, 't-degraded', '嵌入模型换成什么了');
check('with no reranker the margin gate is not applied to the RRF scale', degraded !== null,
  'the degraded path must still deliver a memory rather than reject every turn');

server.close();
await rm(dir, { recursive: true, force: true });

console.log(failures === 0
  ? '\n  hermetic end-to-end: all checks passed\n'
  : `\n  hermetic end-to-end: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
