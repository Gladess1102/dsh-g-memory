#!/usr/bin/env node
/**
 * Calibrate `policy.marginGate` against the pipeline that is actually deployed.
 *
 * The gate reads the *head margin* — `score[0] - score[2]` of the reranked
 * candidates — and refuses to inject when the top of the list is not separated
 * from the rest. The shipped 1.18 was measured on a different embedder and a
 * different candidate distribution, so it has to be re-derived whenever either
 * moves.
 *
 * It needs both classes: answerable queries (margin should be large) and
 * unanswerable ones (margin should be small). The negatives carry `mustNot`
 * terms, and any negative whose terms DO appear in the index is reported —
 * because a "negative" that the corpus answers is not a negative, and silently
 * counting it would flatter the gate.
 *
 *   node scripts/margin-gate-eval.mjs [--top 20] [--negatives FILE] [--json]
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { rerankEntries, resolveRerankConfig } from '../lib/rerank.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};

const topK = Number(valueOf('--top', '20'));
const negativesFile = valueOf('--negatives', 'scripts/cases.negatives.json');
const indexDir = valueOf('--index', defaultIndexDir());
const embedCfg = resolveConfig();
const rerankCfg = resolveRerankConfig();

async function marginOf(query) {
  const [raw] = await embedBatch([query], embedCfg, { purpose: 'query' });
  const vector = prepareQueryVector(raw);
  const hits = index.recall(vector, query, { k: topK });
  const entries = hits.map((h) => ({ text: index.unit(h.index).text }));
  const outcome = await rerankEntries(query, entries, { config: rerankCfg });
  const scores = outcome.entries.map((e) => e.rerankScore).filter((s) => Number.isFinite(s));
  if (scores.length < 3) return { margin: null, top1: scores[0] ?? null, scored: scores.length, scores };
  return { margin: scores[0] - scores[2], top1: scores[0], scored: scores.length, scores };
}

const positives = [
  ...JSON.parse(await readFile('scripts/cases-personal.local.json', 'utf8')),
  ...JSON.parse(await readFile('scripts/cases.calibration.json', 'utf8')),
];
const negatives = JSON.parse(await readFile(negativesFile, 'utf8'));

const index = await readIndex(indexDir);
console.log('index     ' + indexDir + ' (' + index.size + ' units, ' + index.dim + 'd, ' + index.model + ')');
console.log('embedder  ' + embedCfg.model + '  prefixes: q=' + JSON.stringify(embedCfg.queryPrefix) + ' d=' + JSON.stringify(embedCfg.docPrefix));
console.log('reranker  ' + rerankCfg.model + '  maxChars=' + rerankCfg.maxChars + '  pool=' + topK);
console.log('');

// A negative whose subject matter is in the corpus is not a negative.
let contaminated = 0;
for (const spec of negatives) {
  const terms = Array.isArray(spec.mustNot) ? spec.mustNot : [];
  let found = 0;
  for (let i = 0; i < index.size && found < 3; i += 1) {
    const text = index.unit(i).text;
    if (terms.some((t) => text.includes(String(t)))) found += 1;
  }
  if (found > 0) {
    contaminated += 1;
    console.log('WARN  negative "' + spec.query.slice(0, 30) + '" has index hits for ' + JSON.stringify(terms) + ' (' + found + '+)');
  }
}
if (contaminated) console.log('      ' + contaminated + ' negative(s) may be answerable; see the rows below');

const pos = [];
for (const spec of positives) {
  const r = await marginOf(spec.query);
  pos.push({ query: spec.query, ...r });
  process.stderr.write('.');
}
const neg = [];
for (const spec of negatives) {
  const r = await marginOf(spec.query);
  neg.push({ query: spec.query, ...r });
  process.stderr.write('x');
}
process.stderr.write('\n\n');

const values = (rows) => rows.map((r) => r.margin).filter((m) => m !== null).sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
const P = values(pos); const N = values(neg);

console.log('answerable   n=' + P.length + '  margin  min ' + q(P, 0).toFixed(2) + '  p25 ' + q(P, 0.25).toFixed(2)
  + '  median ' + q(P, 0.5).toFixed(2) + '  max ' + q(P, 0.999).toFixed(2));
console.log('unanswerable n=' + N.length + '  margin  min ' + q(N, 0).toFixed(2) + '  p25 ' + q(N, 0.25).toFixed(2)
  + '  median ' + q(N, 0.5).toFixed(2) + '  max ' + q(N, 0.999).toFixed(2));

// Rank-based separation: P(margin of a random answerable > margin of a random unanswerable).
let wins = 0; let ties = 0;
for (const p of P) for (const n of N) { if (p > n) wins += 1; else if (p === n) ties += 1; }
const auc = (wins + 0.5 * ties) / (P.length * N.length);
console.log('separation   AUC ' + auc.toFixed(3) + '  (0.5 = the margin says nothing)');
const unscored = [...pos, ...neg].filter((r) => r.margin === null).length;
if (unscored > 0) console.log('note  ' + unscored + ' quer(ies) had fewer than 3 scored candidates and are in no row below');

console.log('');
console.log('head margin (what policy.marginGate reads — the statistic above)');
console.log('gate   negatives admitted   answerable kept');
for (const gate of [0, 0.5, 1.0, 1.18, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]) {
  const admit = N.filter((m) => m >= gate).length;
  const keep = P.filter((m) => m >= gate).length;
  console.log('  ' + String(gate).padEnd(5) + String(admit + '/' + N.length).padEnd(20) + keep + '/' + P.length);
}

// The knob a deployment usually reaches for is `policy.gate`: an absolute floor on
// the cross-encoder score, not on its spread. Printing only the margin table made
// a config cite numbers this script never computed.
console.log('');
console.log('absolute floor on each candidate score (what policy.gate / midGate read)');
console.log('floor   negatives kept   answerable kept   answerable kept 3+');
for (const floor of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6]) {
  const kept = (rows) => rows.filter((r) => (r.scores ?? []).some((s) => s >= floor)).length;
  const kept3 = (rows) => rows.filter((r) => (r.scores ?? []).filter((s) => s >= floor).length >= 3).length;
  console.log('  ' + String(floor).padEnd(7) + (kept(neg) + '/' + neg.length).padEnd(16)
    + (kept(pos) + '/' + pos.length).padEnd(18) + kept3(pos) + '/' + pos.length);
}

// AUC of this run, and the honest caveat: the margin is a difference of noisy
// gaps, so it moves between runs on identical settings. Two runs of this script on
// 2026-10-08 gave 0.347 and 0.000 for the same corpus.
if (P.length === 0 || N.length === 0) console.log('\nseparation   n/a (one class is empty)');

if (argv.includes('--json')) {
  console.log(JSON.stringify({ auc, positives: pos, negatives: neg }, null, 1));
}
