#!/usr/bin/env node
/**
 * Re-embed the durable card store onto a different embedding model.
 *
 * Cards carry their own packed int8 vector "in the same space as the index".
 * Changing the embedder therefore leaves every card in the OLD space at the SAME
 * width — a mismatch no dimension check can see, and the plugin's card gate would
 * silently score them against unrelated queries. This rewrites the vectors.
 *
 * Facts are untouched: id, summary, tags, time, session and model provenance are
 * copied through; only `vector` (and `model`, to record who produced it now) move.
 *
 *   DSH_G_MEMORY_EMBED_URL=... DSH_G_MEMORY_EMBED_MODEL=... \
 *   DSH_G_MEMORY_EMBED_DOC_PREFIX=... node scripts/reembed-cards.mjs [--dry-run]
 *
 * SPDX-License-Identifier: MIT
 */

import { copyFile } from 'node:fs/promises';
import { readCards, writeCards, withVector, defaultCardPath } from '../lib/cards.mjs';
// eslint-disable-next-line no-unused-vars -- readCards is used for the read-back below
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';

const dryRun = process.argv.includes('--dry-run');
const path = defaultCardPath();
const cfg = resolveConfig();

const cards = await readCards(path);
if (cards.length === 0) {
  console.log('no cards at ' + path);
  process.exit(0);
}

console.log('cards    ' + cards.length + ' from ' + path);
console.log('embedder ' + cfg.model + ' at ' + cfg.url + (cfg.docPrefix ? ' (doc prefix set)' : ''));

const targetDim = Number(process.env.DSH_G_MEMORY_EMBED_DIM ?? process.env.EMBED_DIM ?? 0);
let updated = [];
for (const card of cards) {
  const [vector] = await embedBatch([String(card.summary ?? '')], cfg, { purpose: 'doc' });
  // A card whose vector is the wrong *width* is not rejected anywhere: searchCards
  // skips it silently, so the whole store can become invisible while this script
  // reports success. Catch that here, where the cause is still in scope.
  if (targetDim > 0 && vector.length !== targetDim) {
    console.error('FAILED: endpoint returned ' + vector.length + ' dimensions, expected ' + targetDim);
    process.exit(1);
  }
  // `model` is the endpoint that *wrote the card* (synthesis provenance), not the
  // embedder. An earlier version stamped the embedder's name here, which silently
  // erased that provenance for every card; the field is left exactly as it was.
  updated.push(withVector(card, vector));
  process.stderr.write('.');
}
process.stderr.write('\n');

if (dryRun) {
  console.log('dry run: nothing written');
  process.exit(0);
}

const backup = path + '.before-' + cfg.model + '-' + Date.now();
await copyFile(path, backup);
const result = await writeCards(updated, path);
console.log('backup   ' + backup);
console.log('written  ' + JSON.stringify(result));

// Read back rather than trust the write: ids must all be present, and every
// vector must be the width this run embedded.
const after = await readCards(path);
const byId = new Map(after.map((c) => [c.id, c]));
const missing = updated.filter((c) => !byId.has(c.id)).map((c) => c.id);
const widths = new Set(after.map((c) => (typeof c.vector === 'string' ? Buffer.from(c.vector, 'base64').length : 0)));
console.log('readback ' + after.length + ' cards, vector widths ' + [...widths].join('/'));
if (missing.length > 0) {
  console.error('FAILED: ' + missing.length + ' card(s) missing after write: ' + missing.slice(0, 3).join(', '));
  process.exit(1);
}
if (widths.size !== 1) {
  console.error('FAILED: mixed vector widths in the store: ' + [...widths].join('/'));
  process.exit(1);
}
