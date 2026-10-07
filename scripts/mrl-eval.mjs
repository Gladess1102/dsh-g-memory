#!/usr/bin/env node
/**
 * Would Matryoshka truncation cost us anything?
 *
 * EmbeddingGemma 2 is trained with Matryoshka Representation Learning, so the
 * first 256 of its 768 dimensions are themselves a usable, shorter embedding
 * (renormalised). Truncating would shrink the stored vectors 3x — the index is
 * ~45% vectors — at whatever quality cost.
 *
 * Measured offline against the production index: the stored int8 codes are cut to
 * their first N dimensions and renormalised, and the query is cut the same way.
 * That is a hair different from truncating the float embedding before quantising
 * (the stored scale was computed over all 768 dims), which is stated rather than
 * hidden: it is a decision-grade number, not a precision measurement.
 *
 *   node scripts/mrl-eval.mjs [--dims 768,512,256,128] [--top 20]
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { unpackVector, l2Normalize } from '../lib/vector.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};

const dims = valueOf('--dims', '768,512,256,128').split(',').map(Number);
if (dims.some((d) => !Number.isInteger(d) || d <= 0)) {
  throw new Error('--dims must be a comma-separated list of positive integers, got ' + JSON.stringify(valueOf('--dims', '')));
}
const topK = Number(valueOf('--top', '20'));
const embedCfg = resolveConfig();
const index = await readIndex(valueOf('--index', defaultIndexDir()));

const cases = [
  ...JSON.parse(await readFile('scripts/cases-personal.local.json', 'utf8')),
  ...JSON.parse(await readFile('scripts/cases.calibration.json', 'utf8')),
];

// Unpack every stored vector once per dimension.
const bank = new Map();
for (const d of dims) {
  const rows = [];
  for (let i = 0; i < index.size; i += 1) {
    const { codes, scale } = unpackVector(index.unit(i).vector);
    const head = new Float32Array(d);
    for (let j = 0; j < d; j += 1) head[j] = codes[j] * scale;
    rows.push(l2Normalize(head));
  }
  bank.set(d, rows);
}

const queryVectors = await embedBatch(cases.map((c) => c.query), embedCfg, { purpose: 'query' });

if (dims.some((d) => d > index.dim)) {
  throw new Error('--dims asks for ' + Math.max(...dims) + ' dimensions but the index holds ' + index.dim);
}
console.log('index    ' + index.size + ' units, model ' + (index.data.model ?? 'unknown'));
console.log('cases    ' + cases.length + ', pool ' + topK);
console.log('embedder ' + embedCfg.model + ' query prefix ' + JSON.stringify(embedCfg.queryPrefix));
console.log('');
console.log('dims   R@1    R@3    R@' + topK + '   vector bytes/unit');

for (const d of dims) {
  const rows = bank.get(d);
  let at1 = 0; let at3 = 0; let at20 = 0;
  for (let c = 0; c < cases.length; c += 1) {
    const musts = (cases[c].must ?? []).map(String);
    const q = prepareQueryVector(queryVectors[c].slice(0, d));
    const scored = rows.map((v, i) => {
      let s = 0;
      for (let j = 0; j < d; j += 1) s += q[j] * v[j];
      return { i, s };
    }).sort((a, b) => b.s - a.s).slice(0, topK);
    const rank = scored.findIndex((e) => musts.some((m) => index.unit(e.i).text.toLowerCase().includes(m.toLowerCase()))) + 1;
    if (rank === 1) at1 += 1;
    if (rank > 0 && rank <= 3) at3 += 1;
    if (rank > 0 && rank <= topK) at20 += 1;
  }
  console.log(String(d).padEnd(6) + (at1 + '/' + cases.length).padEnd(7) + (at3 + '/' + cases.length).padEnd(7)
    + (at20 + '/' + cases.length).padEnd(7) + (d + 4) + ' B  (' + Math.round(100 * (d + 4) / 772) + '% of 768d)');
}
