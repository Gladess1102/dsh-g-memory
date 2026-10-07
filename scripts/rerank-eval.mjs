#!/usr/bin/env node
/**
 * What the reranker is worth on the current index.
 *
 * Reports the answer's rank in the fused order against its rank after the
 * cross-encoder reorders the same pool, plus the score separation the relevance
 * gate reads — a reranker swap changes that scale, and `policy.marginGate` was
 * calibrated against the old one.
 *
 *   node scripts/rerank-eval.mjs [--cases FILE] [--top N] [--index DIR]
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

const casesFile = valueOf('--cases', 'scripts/cases-personal.local.json');
const topK = Number(valueOf('--top', '20'));
if (!Number.isFinite(topK) || topK <= 0) throw new Error('--top needs a positive number');
const indexDir = valueOf('--index', defaultIndexDir());
const embedCfg = resolveConfig();
const rerankCfg = resolveRerankConfig();

if (!String(rerankCfg.url || '').trim()) {
  console.error('no reranker configured (set DSH_G_MEMORY_RERANK_URL); nothing to measure');
  process.exit(1);
}

const cases = JSON.parse(await readFile(casesFile, 'utf8'));
const index = await readIndex(indexDir);

console.log('index    ' + indexDir + ' (' + index.size + ' units, ' + index.dim + 'd, model ' + (index.data.model ?? 'unknown') + ')');
console.log('embedder ' + embedCfg.model + ' at ' + embedCfg.url + (embedCfg.queryPrefix ? ' (query prefix set)' : ''));
console.log('reranker ' + rerankCfg.model + ' at ' + rerankCfg.url + rerankCfg.path + ' (maxChars ' + rerankCfg.maxChars + ')');
console.log('cases    ' + cases.length + ' from ' + casesFile + ', pool ' + topK);
console.log('');

let fusedTop1 = 0; let rerankTop1 = 0; let fusedTop3 = 0; let rerankTop3 = 0; let reranked = 0; let scored = 0;
/** Requests where the reranker was configured but unusable — not the same as "no effect". */
let rerankFailures = 0;
const answerScores = []; const bestOtherScores = [];

for (const spec of cases) {
  const [raw] = await embedBatch([spec.query], embedCfg, { purpose: 'query' });
  const vector = prepareQueryVector(raw);
  const hits = index.recall(vector, spec.query, { k: topK });
  const entries = hits.map((h) => ({ text: index.unit(h.index).text }));
  const musts = Array.isArray(spec.must) ? spec.must.map(String) : [];
  const isAnswer = (e) => musts.some((m) => String(e.text).toLowerCase().includes(m.toLowerCase()));
  const rankOf = (list) => {
    const at = list.findIndex(isAnswer);
    return at === -1 ? 0 : at + 1;
  };

  const fusedRank = rankOf(entries);
  const outcome = await rerankEntries(spec.query, entries, {
    config: rerankCfg,
    // Reported, not swallowed: "the reranker was down" and "the reranker changed
    // nothing" otherwise print as the same table.
    onFailure: (error) => { rerankFailures += 1; console.error('  rerank failed: ' + error.message); },
  });
  const order = outcome.entries;
  if (outcome.reranked) reranked += 1;
  const rerankRank = rankOf(order);

  if (fusedRank === 1) fusedTop1 += 1;
  if (rerankRank === 1) rerankTop1 += 1;
  if (fusedRank > 0 && fusedRank <= 3) fusedTop3 += 1;
  if (rerankRank > 0 && rerankRank <= 3) rerankTop3 += 1;

  const target = order.find(isAnswer);
  if (target && Number.isFinite(target.rerankScore)) { answerScores.push(target.rerankScore); scored += 1; }
  const others = order.filter((e) => !isAnswer(e) && Number.isFinite(e.rerankScore)).map((e) => e.rerankScore);
  if (others.length) bestOtherScores.push(Math.max(...others));

  console.log((fusedRank > 0 ? 'hit  ' : 'MISS ') + 'fused#' + (fusedRank || '-') + '  reranked#' + (rerankRank || '-') + '  ' + spec.query.slice(0, 40));
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log('');
console.log('requests reranked      ' + reranked + '/' + cases.length
  + (rerankFailures > 0 ? '   (reranker unavailable ' + rerankFailures + 'x — the two columns below are then the same run)' : ''));
console.log('answer top-1           fused ' + fusedTop1 + '/' + cases.length + '   reranked ' + rerankTop1 + '/' + cases.length);
console.log('answer top-3           fused ' + fusedTop3 + '/' + cases.length + '   reranked ' + rerankTop3 + '/' + cases.length);
if (scored) {
  console.log('cross-encoder score of the ANSWER (n=' + scored + '): min ' + Math.min(...answerScores).toFixed(2)
    + '  median ' + median(answerScores).toFixed(2) + '  max ' + Math.max(...answerScores).toFixed(2));
}
if (bestOtherScores.length) {
  console.log('cross-encoder score of the best NON-ANSWER in the same pool: median ' + median(bestOtherScores).toFixed(2)
    + '  max ' + Math.max(...bestOtherScores).toFixed(2));
}
