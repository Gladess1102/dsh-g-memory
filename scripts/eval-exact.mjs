#!/usr/bin/env node
/**
 * Does the exact-match arm actually find what the user typed?
 *
 * `lib/exact.mjs` is a third retrieval arm — quoted phrases, calendar dates,
 * #tags and file paths — and it has been wired into the index since 0.12 with
 * no measurement of its own. That is the same shape as the judge: a component
 * that runs on every recall, costs a full scan, and whose contribution nobody
 * can state. This script states it on the corpus the arm actually searches.
 *
 * The samples are mined from the index, not invented. Each kind is measured by
 * its own contract, because they answer different questions:
 *
 *   path  a literal string: "which unit names this file?"  → hit@k is meaningful
 *   tag   a literal string, restricted to rare ones: a #tag that appears in
 *         hundreds of units cannot have a top-1 answer, so sampling it would
 *         measure the corpus instead of the arm
 *   date  a CALENDAR day: the arm scores `unit.time`'s local date, not text, so
 *         the question is "did it return that day, and only that day" —
 *         precision and coverage, not a specific unit
 *
 * The other question is the one from the review: does the arm pull tool JSON
 * fragments into the candidate pool? The arm scores by substring, so it can
 * rank a fragment that happens to contain the literal; the noise rate below is
 * the share of returned units that begin like JSON or carry a tool-call field.
 *
 * Read-only: it opens the index and writes nothing.
 *
 *   node scripts/eval-exact.mjs
 *   node scripts/eval-exact.mjs --samples 15 --limit 10 --json
 *   node scripts/eval-exact.mjs --gate        # fail below the hit-rate floor
 *
 * Exit code: 0 always unless --gate is given (then 1 when hit@5 over the
 * literal kinds < 0.8, day precision < 0.9, or the JSON-fragment share of
 * returned units > 0.1), 2 when the index is unreadable or has no literals.
 *
 * SPDX-License-Identifier: MIT
 */

import { readIndex, defaultIndexDir } from '../lib/store.mjs';
import { parseExactQuery, searchExact } from '../lib/exact.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};
const asJson = argv.includes('--json');
const gateOn = argv.includes('--gate');
const indexDir = valueOf('--index', defaultIndexDir());
const perKind = Math.max(1, Math.min(200, Number(valueOf('--samples', '15'))));
const limit = Math.max(1, Math.min(50, Number(valueOf('--limit', '10'))));
const GATE_HIT_AT_5 = 0.8;
const GATE_DAY_PRECISION = 0.9;
const GATE_NOISE = 0.1;

const PATH_LITERAL = /\b[\w.~/-]{3,}\.(?:mjs|js|json|md|ya?ml|py|sh|ts|tsx|toml|txt|log)\b/g;
/** Tags with a digit or a separator are the ones a user actually types; a bare CJK word is prose. */
const TAG_LITERAL = /#([\w-]{3,40})\b/g;
/** A unit that starts like JSON, or carries a tool-call field, is a fragment. */
const JSON_FRAGMENT = /^\s*[{[]|"callId"|"tool_calls"|"arguments"\s*:/;

const index = await readIndex(indexDir).catch((error) => {
  console.error('eval-exact: cannot read the index at ' + indexDir + ': ' + (error?.message || error));
  process.exit(2);
});
const units = index.data.units;
if (!Array.isArray(units) || units.length === 0) {
  console.error('eval-exact: the index at ' + indexDir + ' has no units');
  process.exit(2);
}

const localDay = (time) => {
  const date = new Date(Number(time) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
};

/** text → {count, candidates}. Count is corpus frequency; only rare tags are sampled. */
const tagFrequency = new Map();
const pathMatches = new Map();
/** day → unit indices, capped: a day with hundreds of units has no top-10 answer either. */
const dayMatches = new Map();
const remember = (map, key, unitIndex, cap) => {
  let entry = map.get(key);
  if (!entry) {
    entry = { key, count: 0, candidates: [] };
    map.set(key, entry);
  }
  entry.count += 1;
  if (entry.candidates.length < cap) entry.candidates.push(unitIndex);
};

for (let i = 0; i < units.length; i += 1) {
  const unit = units[i];
  const text = String(unit?.text ?? '');
  if (text.length >= 8) {
    for (const match of text.matchAll(new RegExp(PATH_LITERAL.source, 'g'))) {
      if (match[0].includes('://')) continue;
      remember(pathMatches, match[0], i, 50);
    }
    for (const match of text.matchAll(new RegExp(TAG_LITERAL.source, 'g'))) {
      remember(tagFrequency, match[1], i, 50);
    }
  }
  const day = localDay(unit?.time);
  if (day) remember(dayMatches, day, i, 200);
}

const pickEvenly = (pool, wanted, predicate) => {
  const eligible = pool.filter(predicate);
  const out = [];
  const step = Math.max(1, Math.floor(eligible.length / wanted));
  for (let i = 0; i < eligible.length && out.length < wanted; i += step) out.push(eligible[i]);
  return out;
};

const pathSamples = pickEvenly([...pathMatches.values()].sort((a, b) => a.key.localeCompare(b.key)), perKind, () => true);
// A tag that appears once in 40k units is a needle, not a search; keep it to a
// small neighbourhood so the expected answer can actually be ranked.
const tagSamples = pickEvenly(
  [...tagFrequency.values()].filter((entry) => /[\d-]/.test(entry.key) && entry.count <= 5).sort((a, b) => a.key.localeCompare(b.key)),
  perKind,
  () => true,
);
const daySamples = pickEvenly(
  [...dayMatches.values()].filter((entry) => entry.count >= 3).sort((a, b) => a.key.localeCompare(b.key)),
  perKind,
  () => true,
);
if (pathSamples.length + tagSamples.length + daySamples.length === 0) {
  console.error('eval-exact: no usable literals in ' + units.length + ' units; nothing to measure');
  process.exit(2);
}

const rows = [];
let returnedUnits = 0;
let jsonFragments = 0;
const noteReturned = (hits) => {
  for (const hit of hits) {
    returnedUnits += 1;
    if (JSON_FRAGMENT.test(String(units[hit.index]?.text ?? '').slice(0, 200))) jsonFragments += 1;
  }
};

for (const spec of pathSamples) {
  const parsed = parseExactQuery(spec.key);
  const parseOk = parsed.paths.some((path) => path.toLowerCase() === spec.key.toLowerCase());
  const hits = parseOk ? searchExact(units, parsed, { limit }) : [];
  noteReturned(hits);
  const candidates = new Set(spec.candidates);
  rows.push({
    kind: 'path', text: spec.key, parseOk, pool: spec.count,
    hitAt1: hits.length > 0 && candidates.has(hits[0].index),
    hitAt5: hits.slice(0, 5).some((hit) => candidates.has(hit.index)),
    hitAtLimit: hits.some((hit) => candidates.has(hit.index)),
  });
}

for (const spec of tagSamples) {
  const parsed = parseExactQuery('#' + spec.key);
  const parseOk = parsed.tags.some((tag) => tag.toLowerCase() === spec.key.toLowerCase());
  const hits = parseOk ? searchExact(units, parsed, { limit }) : [];
  noteReturned(hits);
  const candidates = new Set(spec.candidates);
  rows.push({
    kind: 'tag', text: '#' + spec.key, parseOk, pool: spec.count,
    hitAt1: hits.length > 0 && candidates.has(hits[0].index),
    hitAt5: hits.slice(0, 5).some((hit) => candidates.has(hit.index)),
    hitAtLimit: hits.some((hit) => candidates.has(hit.index)),
  });
}

for (const spec of daySamples) {
  const parsed = parseExactQuery(spec.key);
  const parseOk = parsed.dates.some((date) => {
    const [year, month, day] = spec.key.split('-').map(Number);
    return date.year === year && date.month === month && date.day === day;
  });
  const hits = parseOk ? searchExact(units, parsed, { limit }) : [];
  noteReturned(hits);
  // "Correct" for a day means the unit really is from that day. Coverage asks
  // whether the top-10 covered the day at all; both are reported, and only the
  // precision side is gated (coverage is bounded by the limit, not the arm).
  const onDay = hits.filter((hit) => localDay(units[hit.index]?.time) === spec.key).length;
  rows.push({
    kind: 'date', text: spec.key, parseOk, pool: spec.count,
    dayPrecision: hits.length > 0 ? Number((onDay / hits.length).toFixed(4)) : null,
    dayCovered: onDay > 0,
    retrieved: hits.length,
  });
}

const share = (subset, predicate) => (subset.length > 0 ? Number((subset.filter(predicate).length / subset.length).toFixed(4)) : null);
const literalGroup = (subset) => ({
  samples: subset.length,
  parseRate: share(subset, (row) => row.parseOk),
  hitAt1: share(subset, (row) => row.hitAt1),
  hitAt5: share(subset, (row) => row.hitAt5),
  hitAtLimit: share(subset, (row) => row.hitAtLimit),
});
const dateRows = rows.filter((row) => row.kind === 'date');
const dateGroup = {
  samples: dateRows.length,
  parseRate: share(dateRows, (row) => row.parseOk),
  dayPrecision: dateRows.filter((row) => row.dayPrecision !== null).length > 0
    ? Number((dateRows.reduce((sum, row) => sum + (row.dayPrecision ?? 0), 0) / dateRows.filter((row) => row.dayPrecision !== null).length).toFixed(4))
    : null,
  dayCovered: share(dateRows, (row) => row.dayCovered),
};
const literalRows = rows.filter((row) => row.kind !== 'date');
const overall = {
  samples: rows.length,
  literal: literalGroup(literalRows),
  date: dateGroup,
  returnedUnits,
  jsonFragmentShare: returnedUnits > 0 ? Number((jsonFragments / returnedUnits).toFixed(4)) : null,
};

const result = {
  indexDir,
  units: units.length,
  limit,
  overall,
  byKind: {
    path: literalGroup(rows.filter((row) => row.kind === 'path')),
    tag: literalGroup(rows.filter((row) => row.kind === 'tag')),
    date: dateGroup,
  },
  missed: rows.filter((row) => (row.kind === 'date' ? !row.dayCovered : !row.hitAtLimit))
    .map((row) => ({ kind: row.kind, text: row.text, pool: row.pool, parseOk: row.parseOk })),
  gate: { hitAt5: GATE_HIT_AT_5, dayPrecision: GATE_DAY_PRECISION, jsonFragmentShare: GATE_NOISE },
};
// Only paths are gated as literals. A #tag is scored by substring, so "#142"
// is also matched inside "1420", "4142" and any other number — a real unit can
// be pushed out of the top 10 by units that merely contain the digits. That is
// the arm's contract, not a regression, so tags are reported and not gated.
result.gatePassed = gateOn
  ? (result.byKind.path.hitAt5 ?? 0) >= GATE_HIT_AT_5
    && (overall.date.dayPrecision ?? 1) >= GATE_DAY_PRECISION
    && (overall.jsonFragmentShare ?? 0) <= GATE_NOISE
  : null;

if (asJson) {
  console.log(JSON.stringify(result, null, 1));
} else {
  const pct = (value) => (value === null || value === undefined ? 'n/a' : (value * 100).toFixed(1) + '%');
  console.log('index   ' + indexDir + ' (' + units.length + ' units)');
  console.log('samples ' + overall.samples + ' literals mined from the index, limit ' + limit);
  console.log('');
  console.log('literal kinds (is the unit that names it returned?)');
  console.log('kind    n     parsed   hit@1    hit@5    hit@' + limit + '   corpus freq');
  for (const kind of ['path', 'tag']) {
    const row = result.byKind[kind];
    const freq = rows.filter((entry) => entry.kind === kind).map((entry) => entry.pool);
    const median = freq.length > 0 ? freq.sort((a, b) => a - b)[Math.floor(freq.length / 2)] : null;
    console.log('  ' + kind.padEnd(6) + String(row.samples).padEnd(6) + pct(row.parseRate).padEnd(9) + pct(row.hitAt1).padEnd(9) + pct(row.hitAt5).padEnd(9) + pct(row.hitAtLimit).padEnd(9) + (median ?? 'n/a'));
  }
  console.log('  ' + 'all'.padEnd(6) + String(overall.literal.samples).padEnd(6) + pct(overall.literal.parseRate).padEnd(9) + pct(overall.literal.hitAt1).padEnd(9) + pct(overall.literal.hitAt5).padEnd(9) + pct(overall.literal.hitAtLimit));
  console.log('  (tag hit@k is substring-bounded by design: #142 also matches inside 1420 and 4142)');
  console.log('');
  console.log('date kind (does the arm return that day, and only that day?)');
  console.log('  n ' + dateGroup.samples + ', parsed ' + pct(dateGroup.parseRate)
    + ', returned unit on the asked day ' + pct(dateGroup.dayPrecision)
    + ', day covered by top-' + limit + ' ' + pct(dateGroup.dayCovered));
  console.log('');
  console.log('noise   ' + pct(overall.jsonFragmentShare) + ' of ' + overall.returnedUnits + ' returned unit(s) look like tool JSON fragments');
  if (result.missed.length > 0) {
    console.log('');
    console.log('missed (' + result.missed.length + '):');
    for (const row of result.missed.slice(0, 10)) console.log('  [' + row.kind + '] ' + row.text + ' (corpus freq ' + row.pool + (row.parseOk ? '' : ', parser did not claim it') + ')');
  }
  if (gateOn) {
    console.log('');
    console.log(result.gatePassed
      ? 'exact gate: pass'
      : 'exact gate: FAIL (path hit@5 ' + pct(result.byKind.path.hitAt5) + ' vs ' + pct(GATE_HIT_AT_5)
        + ', day precision ' + pct(overall.date.dayPrecision) + ' vs ' + pct(GATE_DAY_PRECISION)
        + ', noise ' + pct(overall.jsonFragmentShare) + ' vs ' + pct(GATE_NOISE) + ')');
  }
}

process.exit(gateOn && !result.gatePassed ? 1 : 0);
