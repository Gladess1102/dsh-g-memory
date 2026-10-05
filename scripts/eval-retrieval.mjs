#!/usr/bin/env node
/**
 * Retrieval quality check.
 *
 * Two modes, because they answer different questions and one of them cannot work
 * on anyone else's machine:
 *
 *   (default)  **self-contained.** Cases are generated from the index under
 *              test: a distinctive phrase is taken from a known unit, and the
 *              check is whether that unit comes back. This measures the
 *              retrieval *plumbing* — embedding, both arms, fusion, ranking —
 *              and runs anywhere there is an index. It cannot measure semantic
 *              quality, because the query is drawn from the target text.
 *
 *   --cases F  **labelled.** Each case names a query plus the fact that must be
 *              present in a retrieved entry. This measures whether the retriever
 *              can reach an *answer* phrased differently from the question, and
 *              it is the mode the tuning decisions were made in. Such a set is
 *              corpus-specific by nature: "what is the compression ratio" only
 *              means something against the sessions that discussed it.
 *              `scripts/cases.calibration.json` is the original set, recorded
 *              against one machine's history; it is expected to score near zero
 *              anywhere else, which is why it is data rather than a default.
 *
 *              Labelled cases are scored against **both** layers the product
 *              actually searches: index units and durable cards. Scoring units
 *              alone measured a pool that neither live path builds — `memory_recall`
 *              and automatic recall both put `cardEntries(...)` and the unit hits
 *              into one pool, then rerank the two together. Cards are distilled
 *              summaries, so an answer can live there in one sentence while the
 *              transcript layer buries it.
 *
 *              `--no-cards` reproduces the old number. Measured on the current sets
 *              when the card layer was added: calibration 20/20 either way and
 *              challenge 0/2 either way, i.e. **no case is card-only today** — the
 *              change makes the check measure the right pool, it does not move the
 *              current score. The two challenge misses are unanswerable for a
 *              different, recorded reason: their answers exist only in source code
 *              written with `write`/`edit`, which the index did not read at all
 *              until the authoring extractor landed.
 *
 * Measurement rules that matter (learned the hard way): a case must assert that
 * the *answer* is present, never that a word from the query is present — a
 * passage that merely mentions the topic produced a false 5/5 once.
 *
 * Usage:
 *   node scripts/eval-retrieval.mjs [--cases FILE] [--samples N] [--top K] [--index DIR]
 *                                   [--cards FILE | --no-cards] [--json]
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { readCards, cardEntries, defaultCardPath } from '../lib/cards.mjs';
import { embedBatch, resolveConfig, probe } from '../lib/embedder.mjs';
import { numberEnv } from '../lib/env.mjs';

/** Characters taken from a unit to build a self-generated query. */
const PHRASE_CHARS = 28;
/** How many units to sample when generating cases. */
const DEFAULT_SAMPLES = 12;

/**
 * Build a case set from the index itself.
 *
 * A phrase is usable only if it occurs in exactly one unit; otherwise the
 * correct answer is ambiguous and a low rank would not mean a failure. Windows
 * are tried from the middle of the text outward, because the opening words of a
 * chunk are frequently boilerplate (a tool banner, "the following is…").
 *
 * @param {import('../lib/store.mjs').MemoryIndex} index
 * @param {number} wanted
 * @returns {{ query: string, target: number, note: string }[]}
 */
function generateCases(index, wanted) {
  const units = [];
  for (let i = 0; i < index.size; i += 1) {
    const text = String(index.unit(i).text ?? '');
    if (text.length >= PHRASE_CHARS + 20) units.push({ i, text });
  }
  if (units.length === 0) return [];

  const stride = Math.max(1, Math.floor(units.length / (wanted * 3)));
  const cases = [];
  for (let u = 0; u < units.length && cases.length < wanted; u += stride) {
    const { i, text } = units[u];
    const middle = Math.floor(text.length / 2);
    const starts = [middle];
    for (let d = PHRASE_CHARS; d < text.length - PHRASE_CHARS; d += PHRASE_CHARS) {
      starts.push(middle + d, middle - d);
    }
    for (const start of starts) {
      if (start < 0 || start + PHRASE_CHARS > text.length) continue;
      const phrase = text.slice(start, start + PHRASE_CHARS).trim();
      if (phrase.length < PHRASE_CHARS) continue;
      let occurrences = 0;
      for (let j = 0; j < index.size && occurrences < 2; j += 1) {
        if (String(index.unit(j).text ?? '').includes(phrase)) occurrences += 1;
      }
      if (occurrences !== 1) continue;
      cases.push({ query: phrase, target: i, note: 'phrase from a known unit' });
      break;
    }
  }
  return cases;
}

/**
 * Does this retrieved unit count as the answer?
 * @param {{must?: string[], any?: string[], target?: number}} spec
 * @param {string} text
 */
function satisfies(spec, text) {
  const haystack = String(text).toLowerCase();
  if (Array.isArray(spec.must) && spec.must.length > 0) {
    return spec.must.every((needle) => haystack.includes(String(needle).toLowerCase()));
  }
  if (Array.isArray(spec.any) && spec.any.length > 0) {
    return spec.any.some((needle) => haystack.includes(String(needle).toLowerCase()));
  }
  return false;
}

/** Read a flag's value, refusing a following flag. */
function valueOf(argv, getI, setI, flag) {
  const next = argv[getI() + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
  setI(getI() + 1);
  return next;
}

/** Read a positive count, refusing NaN and zero. */
function countOf(argv, getI, setI, flag) {
  const raw = valueOf(argv, getI, setI, flag);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got "${raw}"`);
  return n;
}

function parseArgs(argv) {
  const args = { _: [] };
  // Declared outside the loop so the readers below can advance it; block-scoped in
  // the `for` header they would be invisible to them.
  let i = 0;
  /** Read a flag's value, refusing a following flag. */
  const value = (flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    return next;
  };
  /** Read a positive count, so a missing value cannot arrive as NaN. */
  const count = (flag) => {
    const raw = value(flag);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got "${raw}"`);
    return n;
  };
  for (; i < argv.length; i += 1) {
    const token = argv[i];
    // Validated the way the CLI's own flags are: `argv[++i]` let a flag be consumed
    // as another flag's value, and `Number(undefined)` reached the comparator as NaN.
    if (token === '--cases') args.cases = value('--cases');
    else if (token === '--cards') args.cards = value('--cards');
    else if (token === '--no-cards') args.noCards = true;
    else if (token === '--index') args.index = value('--index');
    else if (token === '--top') args.top = count('--top');
    else if (token === '--samples') args.samples = count('--samples');
    else if (token === '--min-rate') args.minRate = Number(value('--min-rate'));
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else args._.push(token);
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (args.help) {
  console.log('usage: node scripts/eval-retrieval.mjs [--cases FILE] [--samples N] [--top K] [--index DIR] [--json]');
  console.log('');
  console.log('  (no --cases)  generate cases from the index; measures retrieval plumbing');
  console.log('  --cases FILE  labelled cases {query, must?|any?}; measures answer retrieval');
  console.log("  --cards FILE  card store to search as well (default: the plugin's own)");
  console.log('  --no-cards    score index units only, the way this check used to');
  console.log('  --min-rate R  pass threshold, 0..1 (default 0.75 self-contained, 1.0 labelled)');
  process.exit(0);
}

const indexDir = args.index ? resolve(args.index) : defaultIndexDir();
const topK = args.top ?? 20;
const samples = args.samples ?? numberEnv('DSH_G_MEMORY_EVAL_SAMPLES', DEFAULT_SAMPLES, { min: 1, max: 200 });

/**
 * Pass threshold.
 *
 * A labelled case set is curated, so every case must pass. A generated set is
 * sampled, and some phrases land in minified bundles and filenames where neither
 * arm can reasonably find them — demanding 100% there would make the suite fail
 * for reasons unrelated to retrieval health. The floor is a smoke-test bar, not
 * a quality claim.
 */
const minRate = args.minRate ?? (args.cases !== undefined ? 1 : 0.75);

const cfg = resolveConfig();
const health = await probe(cfg);
if (!health.ok) {
  console.error(`embedding endpoint unavailable (${cfg.url}): ${health.error}`);
  console.error('an index cannot be queried without it; start the embedding server first.');
  process.exit(1);
}

const index = await readIndex(indexDir);
console.log(`index    ${indexDir}`);
console.log(`units    ${index.size}   dim ${index.data.dim}   model ${index.data.model}`);

const labelled = args.cases !== undefined;
const cases = labelled
  ? JSON.parse(await readFile(args.cases, 'utf8'))
  : generateCases(index, samples);

console.log(`mode     ${labelled ? `labelled (${args.cases})` : 'self-contained (generated from the index)'}`);
console.log(`cases    ${cases.length}   topK ${topK}`);
console.log('');

if (cases.length === 0) {
  if (labelled) {
    // An empty frontier is a result, not a failure: it means nothing in the set is
    // known to fail. Saying so is the point — a file that silently reports 0/0 would
    // look like a broken run.
    console.log('no cases: this set is empty — nothing is currently known to fail.');
    process.exit(0);
  }
  console.error('no usable cases: the index has too few distinct units to sample from.');
  process.exit(1);
}

const queryVectors = await embedBatch(cases.map((c) => c.query), cfg);

/**
 * The card store, searched exactly the way the product searches it.
 *
 * `cardEntries` is imported rather than re-implemented: it applies the same
 * similarity pre-filter and the same retired/superseded rule the two live paths
 * apply, so a card that appears here is one the product would really have had in
 * its pool. Only labelled cases use it — a generated case's answer is a specific
 * index unit, which no card can stand in for.
 */
const cardPath = args.cards ?? defaultCardPath();
/** @type {any[]} */
let cards = [];
// `readCards` returns `[]` for ENOENT, which is right for the default path (a
// machine with no cards yet) and wrong for a path the caller typed: a typo would
// score zero cards and report the layer as empty.
if (labelled && !args.noCards && args.cards !== undefined && !existsSync(cardPath)) {
  console.error(`cards    --cards points at ${cardPath}, which does not exist`);
  process.exit(1);
}
if (labelled && !args.noCards) {
  try {
    cards = await readCards(cardPath);
  } catch (error) {
    // An unreadable store is not an empty one, and `readCards` already returns `[]`
    // for the honest case (no cards yet). Swallowing the rest made a permissions
    // problem, a directory in place of the file, or a mistyped `--cards` look like
    // "this deployment has no cards" — and the check would then quietly report on a
    // layer it never searched.
    console.error(`cards    cannot read ${cardPath}: ${error?.message || error}`);
    console.error('the card layer cannot be scored; fix the path or pass --no-cards to score units only.');
    process.exit(1);
  }
}
console.log(`cards    ${args.noCards ? 'not scored (--no-cards)' : `${cards.length} from ${cardPath}`}`);

/** @type {{query: string, unit: number|null, card: number|null, perArm: Record<string, number|null>}[]} */
const rows = [];
let passed = 0;
/** Answers that only the card layer could supply — the number this check used to lose. */
let cardOnly = 0;

for (let i = 0; i < cases.length; i += 1) {
  const spec = cases[i];
  const vector = prepareQueryVector(queryVectors[i]);

  // Each arm is evaluated separately so a regression in one stays visible even
  // when fusion masks it.
  const arms = {
    vector: index.searchVector(vector, topK),
    lexical: index.searchLexical(spec.query, topK),
    fused: index.recall(vector, spec.query, { k: topK }).map((r) => r.index),
  };

  /** @type {Record<string, number|null>} */
  const perArm = {};
  for (const [armName, indices] of Object.entries(arms)) {
    const at = Number.isInteger(spec.target)
      ? indices.indexOf(spec.target)
      : indices.findIndex((idx) => satisfies(spec, index.unit(idx).text));
    perArm[armName] = at === -1 ? null : at + 1;
  }

  const cardAt = cards.length > 0
    ? cardEntries(cards, vector).findIndex((entry) => satisfies(spec, entry.text))
    : -1;
  const unitRank = perArm.fused;
  const cardRank = cardAt === -1 ? null : cardAt + 1;

  const ok = unitRank !== null || cardRank !== null;
  if (ok) passed += 1;
  if (unitRank === null && cardRank !== null) cardOnly += 1;
  rows.push({ query: spec.query, unit: unitRank, card: cardRank, perArm });

  const shown = spec.query.length > 46 ? `${spec.query.slice(0, 46)}…` : spec.query;
  console.log(
    `${ok ? 'OK  ' : 'MISS'} unit#${unitRank ?? '-'}  card#${cardRank ?? '-'}  `
    + `vector#${perArm.vector ?? '-'}  lexical#${perArm.lexical ?? '-'}   ${shown.replace(/\s+/g, ' ')}`,
  );
}

const rate = passed / cases.length;
const ok = rate >= minRate;
const unitOnly = rows.filter((r) => r.unit !== null).length;
console.log('');
const layer = cards.length > 0 ? 'units + cards' : 'units only';
console.log(`recall@${topK} (${layer}): ${passed}/${cases.length}  (${(rate * 100).toFixed(0)}%, floor ${(minRate * 100).toFixed(0)}%)`);
if (cards.length > 0) {
  console.log(`  · units alone: ${unitOnly}/${cases.length}   cards alone: ${rows.filter((r) => r.card !== null).length}/${cases.length}`
    + (cardOnly > 0 ? `   (${cardOnly} answerable only from a card)` : ''));
}
console.log(ok ? 'result   PASS' : 'result   FAIL');

if (args.json) {
  console.log(JSON.stringify({
    indexDir,
    units: index.size,
    cards: cards.length,
    cardPath: cards.length > 0 || !args.noCards ? cardPath : null,
    mode: labelled ? 'labelled' : 'self-contained',
    topK,
    passed,
    unitOnly,
    cardOnly,
    total: cases.length,
    minRate,
    ok,
    rows,
  }, null, 2));
}

process.exitCode = ok ? 0 : 1;
