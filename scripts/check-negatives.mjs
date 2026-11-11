#!/usr/bin/env node
// Validate negative cases: a query is a usable negative only if its mustNot
// strings appear in NO retrieved unit. The shipped cases.negatives.json fails
// this today (13/13 hit) because the file itself was indexed as tool output.
// env: NG_TOP=40  NG_JSON=1
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig, probe } from '../lib/embedder.mjs';

const env = process.env;
const top = Number(env.NG_TOP || 40);
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/check-negatives.mjs <negatives.json>'); process.exit(2); }
const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
const cases = Array.isArray(raw) ? raw : (raw.cases ?? raw.negatives ?? []);
const cfg = resolveConfig();
const health = await probe(cfg);
if (!health.ok) { console.error('embedder down'); process.exit(1); }
const index = await readIndex(defaultIndexDir());
const vectors = await embedBatch(cases.map((c) => c.query), cfg, { purpose: 'query' });

const out = [];
let clean = 0;
for (let i = 0; i < cases.length; i += 1) {
  const spec = cases[i];
  const needles = (spec.mustNot || []).map((n) => String(n).toLowerCase());
  const hits = index.recall(prepareQueryVector(vectors[i]), spec.query, { k: top });
  let contaminated = 0;
  let worst = null;
  for (const { index: idx } of hits) {
    const text = String(index.unit(idx).text ?? '').toLowerCase();
    const hit = needles.filter((n) => text.includes(n));
    if (hit.length) { contaminated += 1; if (!worst) worst = hit[0]; }
  }
  const ok = contaminated === 0;
  if (ok) clean += 1;
  out.push({ query: spec.query, ok, contaminated, example: worst, top: hits.length });
  console.log((ok ? 'CLEAN ' : 'DIRTY ') + String(contaminated) + '/' + hits.length + '  ' + spec.query.slice(0, 60));
}
console.log('');
console.log('usable negatives: ' + clean + '/' + cases.length);
if (env.NG_JSON) console.log(JSON.stringify(out, null, 2));
process.exit(0);
