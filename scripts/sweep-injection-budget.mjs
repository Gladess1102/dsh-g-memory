#!/usr/bin/env node
// Sweep the injection budget against coverage. Retrieval+rerank are computed once
// per candidate depth; selectByPolicy+renderRecall are pure CPU and are swept.
// env: SW_CANDIDATES="8,20,40" SW_ENTRIES="3,6,10" SW_BUDGETS="1200,1800,2400,3000,4000"
//      SW_FULL="400" SW_BRIEF="200" SW_BRIEF_SCORE="2" SW_GATE="-1" SW_MID_GATE="-1.5"
//      SW_NO_CARDS="1"  SW_JSON="1"
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { readCards, cardEntries, defaultCardPath } from '../lib/cards.mjs';
import { embedBatch, resolveConfig, probe } from '../lib/embedder.mjs';
import { defaultRerankConfig, rerankEntries } from '../lib/rerank.mjs';
import { resolvePolicy, selectByPolicy } from '../lib/policy.mjs';
import { renderRecall, INJECTION_FRAME_CHARS } from '../lib/inject.mjs';

const env = process.env;
const list = (k, d) => (env[k] || d).split(',').map(Number).filter((n) => Number.isFinite(n));
const num = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));

function satisfies(spec, text) {
  const hay = String(text).toLowerCase();
  if (Array.isArray(spec.must) && spec.must.length) return spec.must.every((n) => hay.includes(String(n).toLowerCase()));
  if (Array.isArray(spec.any) && spec.any.length) return spec.any.some((n) => hay.includes(String(n).toLowerCase()));
  return false;
}

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/sweep-injection-budget.mjs <cases.json>'); process.exit(2); }
const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
const cases = Array.isArray(raw) ? raw : (raw.cases ?? raw.queries ?? []);

const cands = list('SW_CANDIDATES', '8,20,40');
const entryOpts = list('SW_ENTRIES', '3,6,10');
const budgets = list('SW_BUDGETS', '1200,1800,2400,3000,4000');
const renderBudgets = list('SW_RENDER', '1200,2400,4000');
const fullChars = num('SW_FULL', 400);
const briefChars = num('SW_BRIEF', 200);
const briefScore = num('SW_BRIEF_SCORE', 2);
const gate = num('SW_GATE', -1);
const midGate = num('SW_MID_GATE', -1.5);

const cfg = resolveConfig();
const health = await probe(cfg);
if (!health.ok) { console.error('embedder down'); process.exit(1); }
const index = await readIndex(defaultIndexDir());
const cards = env.SW_NO_CARDS ? [] : await readCards(defaultCardPath()).catch(() => []);
const vectors = await embedBatch(cases.map((c) => c.query), cfg, { purpose: 'query' });
const rerankConfig = defaultRerankConfig();

const results = [];
for (const candidates of cands) {
  // stage 1: pool + rerank, once per depth
  const perCase = [];
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
    const { entries: ordered, reranked } = await rerankEntries(spec.query, entries, { config: rerankConfig, onFailure: () => {} });
    const scored = reranked ? ordered.map(({ rerankScore, ...e }) => ({ ...e, score: rerankScore })) : ordered;
    perCase.push({ spec, scored, reranked });
  }
  for (const maxEntries of entryOpts) {
    for (const maxTotalChars of budgets) {
     for (const renderMax of renderBudgets) {
      const policy = resolvePolicy({ maxEntries, maxTotalChars, fullChars, briefChars, briefScore, gate, midGate });
      let covered = 0, injected = 0, chars = 0, entriesSum = 0, budgetDrops = 0;
      for (const { spec, scored, reranked } of perCase) {
        const sel = selectByPolicy(scored, { policy, limit: maxEntries, reranked });
        const block = sel.selected.length ? renderRecall(sel.selected, { maxTotalChars: renderMax }) : '';
        if (block.length > 0) {
          injected += 1; chars += block.length; entriesSum += sel.selected.length;
          if (satisfies(spec, block)) covered += 1;
        }
        if (sel.droppedReasons && sel.droppedReasons.budget) budgetDrops += 1;
      }
      results.push({
        candidates, maxEntries, maxTotalChars, renderMax,
        coverage: Number((covered / cases.length).toFixed(3)),
        injectionRate: Number((injected / cases.length).toFixed(3)),
        covered, injected,
        avgChars: injected ? Math.round(chars / injected) : 0,
        avgEntries: injected ? Number((entriesSum / injected).toFixed(2)) : 0,
        budgetDrops,
      });
     }
    }
  }
}

if (env.SW_JSON) console.log(JSON.stringify({ cases: cases.length, frameChars: INJECTION_FRAME_CHARS, results }, null, 2));
else {
  console.log('cases=' + cases.length + ' frame=' + INJECTION_FRAME_CHARS + ' fullChars=' + fullChars + ' briefChars=' + briefChars);
  console.log('cand  ent  polBud  rndBud  net   cov    inj    chars/blk  ent/blk');
  for (const r of results) {
    console.log(String(r.candidates).padEnd(5) + String(r.maxEntries).padEnd(5) + String(r.maxTotalChars).padEnd(8) + String(r.renderMax).padEnd(8)
      + String(r.renderMax - INJECTION_FRAME_CHARS).padEnd(6)
      + String((r.coverage * 100).toFixed(0) + '%').padEnd(7)
      + String((r.injectionRate * 100).toFixed(0) + '%').padEnd(7)
      + String(r.avgChars).padEnd(11) + r.avgEntries);
  }
}
