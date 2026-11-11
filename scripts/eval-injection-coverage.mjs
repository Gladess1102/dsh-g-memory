#!/usr/bin/env node
// Injection-coverage: what the model actually receives, past the pool.
// Repro of lib/auto-recall.mjs (recall -> cardEntries -> rerank -> selectByPolicy -> renderRecall).
// Config via env: EIC_CANDIDATES EIC_MAX_ENTRIES EIC_MAX_TOTAL EIC_FULL EIC_BRIEF EIC_BRIEF_SCORE EIC_GATE EIC_MID_GATE EIC_NO_CARDS EIC_JSON
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { readCards, cardEntries, defaultCardPath } from '../lib/cards.mjs';
import { embedBatch, resolveConfig, probe } from '../lib/embedder.mjs';
import { defaultRerankConfig, rerankEntries } from '../lib/rerank.mjs';
import { resolvePolicy, selectByPolicy } from '../lib/policy.mjs';
import { renderRecall, INJECTION_FRAME_CHARS } from '../lib/inject.mjs';

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));

function satisfies(spec, text) {
  const hay = String(text).toLowerCase();
  if (Array.isArray(spec.must) && spec.must.length) return spec.must.every((n) => hay.includes(String(n).toLowerCase()));
  if (Array.isArray(spec.any) && spec.any.length) return spec.any.some((n) => hay.includes(String(n).toLowerCase()));
  return false;
}

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/eval-injection-coverage.mjs <cases.json>'); process.exit(2); }
const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
const cases = Array.isArray(raw) ? raw : (raw.cases ?? raw.queries ?? []);
if (!cases.length) { console.error('no cases'); process.exit(1); }

const candidates = num('EIC_CANDIDATES', 8);
const renderMax = num('EIC_RENDER', 0) || undefined;
const cfg = resolveConfig();
const health = await probe(cfg);
if (!health.ok) { console.error('embedder down: ' + (health.error || '?')); process.exit(1); }
const index = await readIndex(defaultIndexDir());
const cards = env.EIC_NO_CARDS ? [] : await readCards(defaultCardPath()).catch(() => []);

const policy = resolvePolicy({
  maxEntries: num('EIC_MAX_ENTRIES', undefined),
  maxTotalChars: num('EIC_MAX_TOTAL', undefined),
  fullChars: num('EIC_FULL', undefined),
  briefChars: num('EIC_BRIEF', undefined),
  briefScore: num('EIC_BRIEF_SCORE', undefined),
  gate: num('EIC_GATE', undefined),
  midGate: num('EIC_MID_GATE', undefined),
});
const maxEntries = policy.maxEntries;
const vectors = await embedBatch(cases.map((c) => c.query), cfg, { purpose: 'query' });
const rerankConfig = defaultRerankConfig();

const rows = [];
let injected = 0, covered = 0, totalChars = 0, totalEntries = 0, budgetDrops = 0, rerankFails = 0;
for (let i = 0; i < cases.length; i += 1) {
  const spec = cases[i];
  const vector = prepareQueryVector(vectors[i]);
  const hits = index.recall(vector, spec.query, { k: candidates });
  const entries = [
    ...(cards.length ? cardEntries(cards, vector) : []),
    ...hits.map(({ index: idx, score }) => {
      const u = index.unit(idx);
      return { text: u.text, role: u.role, time: u.time, session: u.session, seq: u.seq, orphaned: u.orphaned === true, hash: u.hash, score };
    }),
  ];
  const { entries: ordered, reranked } = await rerankEntries(spec.query, entries, { config: rerankConfig, onFailure: () => { rerankFails += 1; } });
  const scored = reranked ? ordered.map(({ rerankScore, ...e }) => ({ ...e, score: rerankScore })) : ordered;
  const sel = selectByPolicy(scored, { policy, limit: maxEntries, reranked });
  const block = sel.selected.length ? renderRecall(sel.selected, { maxTotalChars: renderMax }) : '';
  const did = block.length > 0;
  const ok = did && satisfies(spec, block);
  if (did) { injected += 1; totalChars += block.length; totalEntries += sel.selected.length; }
  if (ok) covered += 1;
  if (sel.droppedReasons && sel.droppedReasons.budget) budgetDrops += 1;
  rows.push({ query: spec.query, injected: did, covered: ok, kept: sel.selected.length, chars: block.length, tier: sel.tier, dropped: sel.droppedReasons ?? {}, reason: sel.reason ?? null });
  const shown = spec.query.length > 40 ? spec.query.slice(0, 40) + '...' : spec.query;
  if (!env.EIC_QUIET) console.log((ok ? 'COVER ' : did ? 'MISS  ' : 'EMPTY ') + 'n=' + String(sel.selected.length).padEnd(2) + ' c=' + String(block.length).padEnd(5) + ' ' + shown.replace(/\s+/g, ' '));
}

const cov = covered / cases.length;
const inj = injected / cases.length;
const out = {
  cases: cases.length, candidates,
  maxEntries, maxTotalChars: policy.maxTotalChars, renderMax: renderMax ?? 1200, fullChars: policy.fullChars,
  briefChars: policy.briefChars, gate: policy.gate, midGate: policy.midGate,
  cards: cards.length, rerankFails, frameChars: INJECTION_FRAME_CHARS,
  injectionRate: Number(inj.toFixed(3)), coverage: Number(cov.toFixed(3)),
  covered, injected,
  avgEntriesPerBlock: Number((totalEntries / Math.max(1, injected)).toFixed(2)),
  avgCharsPerBlock: Math.round(totalChars / Math.max(1, injected)),
  avgCharsPerCase: Math.round(totalChars / cases.length),
  budgetDrops, rows,
};
if (env.EIC_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log('');
  console.log('cases=' + cases.length + ' candidates=' + candidates + ' maxEntries=' + maxEntries + ' budget=' + policy.maxTotalChars + ' gate=' + policy.gate + ' cards=' + cards.length);
  console.log('injected ' + injected + '/' + cases.length + ' (' + (inj * 100).toFixed(0) + '%)  covered ' + covered + '/' + cases.length + ' (' + (cov * 100).toFixed(0) + '%)');
  console.log('per block ' + (totalEntries / Math.max(1, injected)).toFixed(2) + ' entries / ' + Math.round(totalChars / Math.max(1, injected)) + ' chars (frame ' + INJECTION_FRAME_CHARS + ')');
  if (budgetDrops) console.log('budget drops: ' + budgetDrops);
  if (rerankFails) console.log('rerank failures: ' + rerankFails);
}
process.exit(cov >= 1 ? 0 : 1);
