#!/usr/bin/env node
/**
 * Calibrate the degraded-card gate: `policy.cardMinSimilarity` and
 * `policy.cardMargin`.
 *
 * When reranking is unavailable, a card has no cross-encoder score to be judged
 * on: its `score` is 0, so the ordinary floor rejects every card, and the old
 * answer was a fixed cosine floor of 0.35. That number was set on 15 cards with
 * the previous embedding model and is now *always* true on this corpus — the
 * measured lower bound in the EmbeddingGemma space is about 0.58, so a random
 * token clears 0.35 (8/8). A gate that cannot say no is not a gate.
 *
 * So the degraded path needs two numbers, both derived from the same pool:
 *
 *   cardMinSimilarity  an absolute floor on the card's cosine similarity
 *   cardMargin         the gap between top1 and top2, so a query that is equally
 *                      close to many cards (no card actually answers it) is
 *                      refused even when the absolute floor is cleared
 *
 * This script measures the pair against the real card store and a negative set
 * that the corpus was checked against (scripts/cases.negatives.json, "these
 * words appear nowhere in the index"): a negative admitted here is a card handed
 * to the model for a question no memory can answer. Positives are derived from
 * the cards themselves — each one's summary is its own best query — because a
 * card that cannot find itself will never be found by anything else.
 *
 * Read-only: it opens the card store and the embedder, and writes nothing.
 *
 *   node scripts/eval-card-gate.mjs
 *   node scripts/eval-card-gate.mjs --cards ~/.dsh/dsh-g-memory/cards.ndjson
 *   node scripts/eval-card-gate.mjs --positives 10 --json
 *   node scripts/eval-card-gate.mjs --allow-negatives 1     # gate tolerance
 *
 * Exit code: 0 when the shipped pair admits fewer negatives than allowed, 1
 * when it does not (so this can be a pre-release check), 2 when the embedder or
 * the card store is unusable — an unmeasurable gate is not a passing one.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { readCards, defaultCardPath, searchCards } from '../lib/cards.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { prepareQueryVector } from '../lib/store.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};
const asJson = argv.includes('--json');
const cardsPath = valueOf('--cards', defaultCardPath());
const negativesPath = valueOf('--negatives', 'scripts/cases.negatives.json');
const positivesWanted = Math.max(1, Math.min(50, Number(valueOf('--positives', '10'))));
const allowedNegatives = Math.max(0, Number(valueOf('--allow-negatives', '0')));
/** The shipped pair; the grid always contains it and it is the row the exit code reads. */
const CHOSEN_SIMILARITY = 0.68;
const CHOSEN_MARGIN = 0.02;
const SIMILARITIES = [0.5, 0.55, 0.6, 0.62, 0.65, 0.66, 0.68, 0.7, 0.72, 0.75];
const MARGINS = [0, 0.01, 0.02, 0.03, 0.05, 0.08];

/** The degraded-card decision, mirroring lib/quality.mjs's pickDegradedCards. */
async function loadCardPicker() {
  try {
    const quality = await import('../lib/quality.mjs');
    if (typeof quality.pickDegradedCards !== 'function') {
      throw new Error('lib/quality.mjs does not export pickDegradedCards');
    }
    return quality.pickDegradedCards;
  } catch (error) {
    console.error('eval-card-gate: cannot load lib/quality.mjs (created with the 0.13 quality work):');
    console.error('  ' + (error?.message || error));
    console.error('  the gate this script measures lives there; run it after that module exists.');
    process.exit(2);
  }
}

/**
 * One query against the whole card pool, decided at several thresholds.
 *
 * The scores are cosine similarities because cards are pre-filtered by
 * similarity before the cross-encoder ever sees them (see cardEntries). Cards
 * without a vector are skipped by searchCards, which is the same behaviour the
 * live path has — a card that cannot be embedded is not searchable.
 */
function decide(pickDegradedCards, cards, queryVector, similarity, margin) {
  const hits = searchCards(cards, queryVector, { limit: 8 });
  const entries = hits.map((hit) => ({
    text: hit.card.summary,
    source: 'card',
    cardId: hit.card.id,
    similarity: hit.score,
    score: 0,
  }));
  const picked = pickDegradedCards(entries, { cardMinSimilarity: similarity, cardMargin: margin });
  return {
    passed: picked.entries.length > 0,
    top1: hits.length > 0 ? Number(hits[0].score.toFixed(4)) : null,
    top2: hits.length > 1 ? Number(hits[1].score.toFixed(4)) : null,
    cardId: hits.length > 0 ? String(hits[0].card.id).slice(0, 8) : null,
    similarity: hits.length > 0 ? Number(hits[0].score.toFixed(4)) : null,
  };
}

/** The first line of a card is its topic; the rest is detail that would bias the query. */
function summaryQuery(card) {
  const text = String(card.summary || '')
    .replace(/\s+/g, ' ')
    .replace(/[*`#]/g, '')
    .trim();
  return text.length > 160 ? text.slice(0, 160) : text;
}

const pickDegradedCards = await loadCardPicker();

let cards = [];
try {
  cards = (await readCards(cardsPath)).filter((card) => typeof card.vector === 'string');
} catch (error) {
  console.error('eval-card-gate: cannot read the card store at ' + cardsPath + ': ' + (error?.message || error));
  process.exit(2);
}
if (cards.length === 0) {
  console.error('eval-card-gate: no cards with vectors at ' + cardsPath + '; nothing to calibrate against');
  process.exit(2);
}

// Positive queries: evenly spaced cards, so the sample spans the whole store
// instead of whatever happens to sit at the head of it.
const positives = [];
const step = Math.max(1, Math.floor(cards.length / positivesWanted));
for (let i = 0; i < cards.length && positives.length < positivesWanted; i += step) {
  const query = summaryQuery(cards[i]);
  if (query.length >= 20) positives.push({ query, cardId: String(cards[i].id).slice(0, 8) });
}

let negatives = [];
try {
  negatives = JSON.parse(await readFile(negativesPath, 'utf8')).map((spec) => ({ query: String(spec.query || spec) }));
} catch (error) {
  console.error('eval-card-gate: cannot read the negative set at ' + negativesPath + ': ' + (error?.message || error));
  process.exit(2);
}
if (negatives.length === 0 || positives.length === 0) {
  console.error('eval-card-gate: need both classes (positives=' + positives.length + ', negatives=' + negatives.length + ')');
  process.exit(2);
}

const embedCfg = resolveConfig();
async function embedOne(query) {
  const [raw] = await embedBatch([query], embedCfg, { purpose: 'query' });
  return prepareQueryVector(raw);
}

if (!asJson) {
  console.log('cards      ' + cardsPath + ' (' + cards.length + ' with vectors)');
  console.log('embedder   ' + embedCfg.model + ' at ' + embedCfg.url + '  q=' + JSON.stringify(embedCfg.queryPrefix || ''));
  console.log('negatives  ' + negativesPath + ' (' + negatives.length + ')');
  console.log('positives  ' + positives.length + ' (evenly sampled card summaries)');
  console.log('');
}

const scoredPositives = [];
for (const spec of positives) {
  const vector = await embedOne(spec.query);
  scoredPositives.push({ ...spec, vector });
  process.stderr.write('.');
}
const scoredNegatives = [];
for (const spec of negatives) {
  const vector = await embedOne(spec.query);
  scoredNegatives.push({ ...spec, vector });
  process.stderr.write('x');
}
process.stderr.write('\n\n');

const grid = [];
for (const similarity of SIMILARITIES) {
  for (const margin of MARGINS) {
    const posHits = scoredPositives.map((spec) => decide(pickDegradedCards, cards, spec.vector, similarity, margin));
    const negHits = scoredNegatives.map((spec) => decide(pickDegradedCards, cards, spec.vector, similarity, margin));
    grid.push({
      similarity,
      margin,
      positivesKept: posHits.filter((hit) => hit.passed).length,
      negativesAdmitted: negHits.filter((hit) => hit.passed).length,
      totalPositives: posHits.length,
      totalNegatives: negHits.length,
    });
  }
}

const chosen = grid.find((row) => row.similarity === CHOSEN_SIMILARITY && row.margin === CHOSEN_MARGIN);
const negativeRows = scoredNegatives.map((spec, i) => ({
  query: spec.query,
  ...decide(pickDegradedCards, cards, spec.vector, CHOSEN_SIMILARITY, CHOSEN_MARGIN),
}));
const positiveRows = scoredPositives.map((spec, i) => ({
  query: spec.query.slice(0, 80),
  ...decide(pickDegradedCards, cards, spec.vector, CHOSEN_SIMILARITY, CHOSEN_MARGIN),
}));

if (asJson) {
  console.log(JSON.stringify({
    cardsPath,
    cardCount: cards.length,
    embedder: { url: embedCfg.url, model: embedCfg.model, queryPrefix: embedCfg.queryPrefix || '' },
    chosen: { similarity: CHOSEN_SIMILARITY, margin: CHOSEN_MARGIN, ...chosen },
    allowedNegatives,
    gatePassed: chosen.negativesAdmitted <= allowedNegatives,
    grid,
    positives: positiveRows,
    negatives: negativeRows,
  }, null, 1));
} else {
  console.log('degraded-card gate: negatives admitted / positives kept');
  console.log('similarity  margin  negatives (want 0)   positives kept');
  for (const row of grid) {
    const mark = row.similarity === CHOSEN_SIMILARITY && row.margin === CHOSEN_MARGIN ? ' <- shipped' : '';
    console.log('  ' + String(row.similarity).padEnd(10) + String(row.margin).padEnd(8)
      + (row.negativesAdmitted + '/' + row.totalNegatives).padEnd(21)
      + row.positivesKept + '/' + row.totalPositives + mark);
  }
  console.log('');
  console.log('at ' + CHOSEN_SIMILARITY + '/' + CHOSEN_MARGIN + ': '
    + chosen.negativesAdmitted + '/' + chosen.totalNegatives + ' negative(s) admitted, '
    + chosen.positivesKept + '/' + chosen.totalPositives + ' positive(s) kept');
  const admitted = negativeRows.filter((row) => row.passed);
  if (admitted.length > 0) {
    console.log('');
    console.log('admitted negatives (these would become cards handed to the model):');
    for (const row of admitted) console.log('  ' + row.similarity + '  ' + row.query.slice(0, 90));
  }
  const lost = positiveRows.filter((row) => !row.passed);
  if (lost.length > 0) {
    console.log('');
    console.log('positives refused (a card that cannot find itself is not retrievable):');
    for (const row of lost) console.log('  ' + row.similarity + '  ' + row.query);
  }
  console.log('');
  console.log(chosen.negativesAdmitted <= allowedNegatives
    ? 'gate ok: the shipped pair admits ' + chosen.negativesAdmitted + ' negative(s) (max ' + allowedNegatives + ')'
    : 'gate FAIL: the shipped pair admits ' + chosen.negativesAdmitted + ' negative(s) (max ' + allowedNegatives + ')');
}

process.exit(chosen.negativesAdmitted <= allowedNegatives ? 0 : 1);
