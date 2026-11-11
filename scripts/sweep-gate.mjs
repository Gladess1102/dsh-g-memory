#!/usr/bin/env node
// Recalibrate the score gate on a CLEAN negative set. The shipped negatives are
// contaminated (the file itself was indexed), so every past gate number was
// measured against queries the index could answer.
// env: SG_CAND=20 SG_ENT=6 SG_BUDGET=2400 SG_RENDER=2400 SG_FULL=400
//      SG_GATES="-3,-2,-1.5,-1,-0.5,0,0.5,1,1.5,2,3" SG_JSON=1
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { readCards, cardEntries, defaultCardPath } from '../lib/cards.mjs';
import { embedBatch, resolveConfig, probe } from '../lib/embedder.mjs';
import { defaultRerankConfig, rerankEntries } from '../lib/rerank.mjs';
import { resolvePolicy, selectByPolicy } from '../lib/policy.mjs';
import { renderRecall } from '../lib/inject.mjs';

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
const cand = num('SG_CAND', 20);
const budget = num('SG_BUDGET', 2400);
const renderMax = num('SG_RENDER', 2400);
const ent = num('SG_ENT', 6);
const fullChars = num('SG_FULL', 400);
const gates = (env.SG_GATES || '-3,-2,-1.5,-1,-0.5,0,0.5,1,1.5,2,3').split(',').map(Number);

function satisfies(spec, text) {
  const hay = String(text).toLowerCase();
  if (Array.isArray(spec.must) && spec.must.length) return spec.must.every((n) => hay.includes(String(n).toLowerCase()));
  if (Array.isArray(spec.any) && spec.any.length) return spec.any.some((n) => hay.includes(String(n).toLowerCase()));
  return false;
}
async function load(file) {
  const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
  return Array.isArray(raw) ? raw : (raw.cases ?? raw.queries ?? []);
}

const posFile = process.argv[2];
const negFile = process.argv[3];
if (!posFile || !negFile) { console.error('usage: node scripts/sweep-gate.mjs <positives.json> <negatives.json>'); process.exit(2); }
const pos = await load(posFile);
const neg = await load(negFile);
const all = [...pos.map((c) => ({ ...c, kind: 'pos' })), ...neg.map((c) => ({ ...c, kind: 'neg' }))];

const cfg = resolveConfig();
if (!(await probe(cfg)).ok) { console.error('embedder down'); process.exit(1); }
const index = await readIndex(defaultIndexDir());
const cards = env.SG_NO_CARDS ? [] : await readCards(defaultCardPath()).catch(() => []);
const vectors = await embedBatch(all.map((c) => c.query), cfg, { purpose: 'query' });
const rerankConfig = defaultRerankConfig();

const staged = [];
for (let i = 0; i < all.length; i += 1) {
  const spec = all[i];
  const vector = prepareQueryVector(vectors[i]);
  const hits = index.recall(vector, spec.query, { k: cand });
  const entries = [
    ...(cards.length ? cardEntries(cards, vector) : []),
    ...hits.map(({ index: idx, score }) => {
      const u = index.unit(idx);
      return { text: u.text, role: u.role, time: u.time, session: u.session, seq: u.seq, orphaned: u.orphaned === true, hash: u.hash, score };
    }),
  ];
  const { entries: ordered, reranked } = await rerankEntries(spec.query, entries, { config: rerankConfig, onFailure: () => {} });
  const scored = reranked ? ordered.map(({ rerankScore, ...e }) => ({ ...e, score: rerankScore })) : ordered;
  staged.push({ spec, scored, reranked, top1: scored.length ? Number(scored[0].score ?? 0) : -Infinity });
}

const top1pos = staged.filter((s) => s.spec.kind === 'pos').map((s) => s.top1).sort((a, b) => a - b);
const top1neg = staged.filter((s) => s.spec.kind === 'neg').map((s) => s.top1).sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))] : NaN);

const rows = [];
for (const gate of gates) {
  const policy = resolvePolicy({ maxEntries: ent, maxTotalChars: budget, fullChars, gate, midGate: gate });
  let covered = 0, injectedNeg = 0;
  for (const { spec, scored, reranked } of staged) {
    const sel = selectByPolicy(scored, { policy, limit: ent, reranked });
    const block = sel.selected.length ? renderRecall(sel.selected, { maxTotalChars: renderMax }) : '';
    if (!block) continue;
    if (spec.kind === 'pos' && satisfies(spec, block)) covered += 1;
    if (spec.kind === 'neg') injectedNeg += 1;
  }
  rows.push({
    gate,
    coverage: Number((covered / pos.length).toFixed(3)),
    falseInject: Number((injectedNeg / neg.length).toFixed(3)),
    covered, injectedNeg,
  });
}

const out = {
  positives: pos.length, negatives: neg.length, candidates: cand, maxEntries: ent,
  policyBudget: budget, renderBudget: renderMax, fullChars,
  top1: {
    pos: { p10: Number(q(top1pos, 0.1).toFixed(2)), p50: Number(q(top1pos, 0.5).toFixed(2)), p90: Number(q(top1pos, 0.9).toFixed(2)) },
    neg: { p10: Number(q(top1neg, 0.1).toFixed(2)), p50: Number(q(top1neg, 0.5).toFixed(2)), p90: Number(q(top1neg, 0.9).toFixed(2)) },
  },
  rows,
};
if (env.SG_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log('pos=' + pos.length + ' neg=' + neg.length + ' cand=' + cand + ' ent=' + ent + ' polBud=' + budget + ' rndBud=' + renderMax + ' full=' + fullChars);
  console.log('top1 pos p10/p50/p90 = ' + out.top1.pos.p10 + ' / ' + out.top1.pos.p50 + ' / ' + out.top1.pos.p90);
  console.log('top1 neg p10/p50/p90 = ' + out.top1.neg.p10 + ' / ' + out.top1.neg.p50 + ' / ' + out.top1.neg.p90);
  console.log('');
  console.log('gate     coverage  falseInject');
  for (const r of rows) {
    console.log(String(r.gate).padEnd(8) + String((r.coverage * 100).toFixed(0) + '%').padEnd(10) + (r.falseInject * 100).toFixed(0) + '%');
  }
}
