/**
 * Time tiering for the memory index: month buckets, extractive summaries, and
 * keyword-level month selection.
 *
 * ## Why this exists (VCP 2.0 / VCPTimeLine)
 *
 * VCP 2.0's VCPTimeLine keeps a cheap month-level view over long-term memory and,
 * at recall time, lets a keyword-matching month vote for the units that fall
 * inside it. The value is not precision — it is an almost free third opinion:
 * month summaries are built once per index, and a bucket can be scored against a
 * query with the same bigram tokenizer the lexical arm already uses, so no
 * embedding call is involved. A month hit is evidence that a whole region of the
 * corpus is about the query, which is signal the per-unit arms cannot see: they
 * rank units by themselves, with nothing that knows what a month is about.
 *
 * ## Boundaries
 *
 * Pure: the clock is an input (each unit's `time`), never read. Month keys are
 * formatted in UTC, so the same index produces the same buckets on any host — a
 * local-time calendar month would shift the boundary by the host's UTC offset,
 * which would make an index built here disagree with the same index built
 * elsewhere. The cost is that a unit in the first UTC-offset hours of a month is
 * filed one month earlier than a human would file it; for an index whose job is
 * coarse co-recall weighting, that is the right trade.
 *
 * SPDX-License-Identifier: MIT
 */

import { tokenSet } from './tokenizer.mjs';

/** Month key for units whose timestamp cannot be trusted. */
export const UNKNOWN_MONTH = 'unknown';

/** Default cap on a month's extracted summary, in characters. */
export const DEFAULT_SUMMARY_CHARS = 200;

/** How many units feed a summary, and how many characters of each survive. */
export const SUMMARY_UNIT_COUNT = 12;
export const SUMMARY_TEXT_CHARS = 60;

/**
 * Minimum original length for a unit to be worth quoting.
 *
 * A summary is a fixed-size index entry, so it should be spent on units that
 * carry content. Short fragments ("ok", "继续") cost a separator and a reader's
 * attention while adding nothing a keyword search could not already find.
 */
export const SUMMARY_MIN_TEXT_CHARS = 20;

/**
 * A second, wider text view of a month, used only by `selectMonths`.
 *
 * The summary is capped at 12 long units on purpose, which means a precise short
 * token (an error code, a file name) in the 13th unit is invisible to month
 * scoring. The sample keeps a longer, looser view so the selector sees more of
 * the month without inflating the summary a caller may display.
 */
export const SAMPLE_UNIT_COUNT = 24;
export const SAMPLE_TEXT_CHARS = 80;
export const SAMPLE_MAX_CHARS = 600;

/** Largest timestamp `Date` can format (8.64e15 ms, about year 275760). */
const MAX_TIME_MS = 8.64e15;

/**
 * @typedef {object} MonthBucket
 * @property {string} month          'YYYY-MM', or 'unknown'
 * @property {number} count          units in this bucket
 * @property {string} summary        extractive summary, at most `maxSummaryChars`
 * @property {number[]} unitIndices  unit indices, ascending
 * @property {string} sample         wider text view, for `selectMonths` only
 */

/**
 * Group units into months, and summarise each month once.
 *
 * @param {Array<{text: string, time: number}>} units
 * @param {{ maxSummaryChars?: number }} [options]
 * @returns {{ months: MonthBucket[], byIndex: Map<number, string> }}
 *   - `months` is newest first; the `unknown` bucket, when present, is last
 *   - `byIndex` maps a unit index to its month key, for cheap lookups at recall
 *     time. A `Map` rather than an array because a caller may hold a subset of
 *     the units and still want to ask about the ones it holds.
 */
export function buildTimeline(units, options = {}) {
  const list = Array.isArray(units) ? units : [];
  const maxSummaryChars = positiveInteger(options?.maxSummaryChars, DEFAULT_SUMMARY_CHARS);

  /** @type {Map<number, string>} */
  const byIndex = new Map();
  /** @type {Map<string, Array<{index: number, time: number, unit: unknown}>>} */
  const buckets = new Map();

  for (let index = 0; index < list.length; index += 1) {
    const unit = list[index];
    const month = monthKeyOf(unit?.time);
    byIndex.set(index, month);
    const entry = { index, time: sortableTime(unit?.time), unit };
    const bucket = buckets.get(month);
    if (bucket) bucket.push(entry);
    else buckets.set(month, [entry]);
  }

  /** @type {MonthBucket[]} */
  const months = [];
  for (const [month, entries] of buckets) {
    // Ascending time: a month is usually opened by the thing it is for, so the
    // earliest units are the ones worth quoting. The unit index breaks ties,
    // because one extraction run stamps many units with the same time and an
    // unstable order would make two builds of the same index disagree.
    entries.sort((a, b) => (a.time - b.time) || (a.index - b.index));
    months.push(buildMonthBucket(month, entries, maxSummaryChars));
  }
  months.sort(compareMonths);
  return { months, byIndex };
}

/**
 * Pick the months a query is likely to live in.
 *
 * Score = share of the query's tokens found in the month's summary and sample
 * (0..1). Token overlap rather than embedding similarity is deliberate: this
 * runs on every recall, it must be explainable ("this month scored because 3 of
 * 4 query tokens appear in it"), and it must keep working when the embedder is
 * unavailable — the same reason the lexical arm exists.
 *
 * A whole-query substring match short-circuits to 1, because bigram tokenisation
 * can miss a phrase that is obviously present: the query "migrat" shares no
 * token with "migration plan", yet its presence is a clear signal.
 *
 * @param {{months: MonthBucket[]}} timeline
 * @param {string} query
 * @param {{ limit?: number, minScore?: number }} [options]
 * @returns {string[]} selected month keys, highest score first; [] when nothing matches
 */
export function selectMonths(timeline, query, options = {}) {
  const months = timeline && Array.isArray(timeline.months) ? timeline.months : [];
  const normalized = normalizeQuery(query);
  const queryTokens = normalized ? tokenSet(normalized) : new Set();
  if (queryTokens.size === 0) return [];

  const minScore = finiteOr(options?.minScore, 0);
  const limit = positiveInteger(options?.limit, Infinity);

  /** @type {Array<{month: string, score: number}>} */
  const scored = [];
  for (const bucket of months) {
    if (!bucket || typeof bucket.month !== 'string' || bucket.month === '') continue;
    const text = ((bucket.summary || '') + ' ' + (bucket.sample || '')).trim();
    if (!text) continue;

    const monthTokens = tokenSet(text);
    let hits = 0;
    for (const token of queryTokens) if (monthTokens.has(token)) hits += 1;
    let score = hits / queryTokens.size;
    if (normalized.length >= 2 && text.toLowerCase().indexOf(normalized) !== -1) score = 1;

    // A month with no overlap is not a weak match, it is no match: returning it
    // would let every query vote for every month, which is the same as no tiers.
    if (score <= 0 || score < minScore) continue;
    scored.push({ month: bucket.month, score });
  }

  scored.sort((a, b) => (b.score - a.score) || compareMonths(a, b));
  const ordered = scored.map((item) => item.month);
  return Number.isFinite(limit) ? ordered.slice(0, limit) : ordered;
}

/**
 * Newest first, with `unknown` last.
 *
 * The unknown bucket is not a month and does not belong at the top of a list
 * whose first entry promises to be the most recent one. Keeping it at the end
 * means a caller that walks `months` newest-first never has to special-case it.
 *
 * @param {{month: string}} a
 * @param {{month: string}} b
 */
function compareMonths(a, b) {
  if (a.month === b.month) return 0;
  if (a.month === UNKNOWN_MONTH) return 1;
  if (b.month === UNKNOWN_MONTH) return -1;
  return a.month < b.month ? 1 : -1;
}

/**
 * @param {string} month
 * @param {Array<{index: number, time: number, unit: unknown}>} entries time-ascending
 * @param {number} maxSummaryChars
 * @returns {MonthBucket}
 */
function buildMonthBucket(month, entries, maxSummaryChars) {
  return {
    month,
    count: entries.length,
    summary: buildSummary(entries, maxSummaryChars),
    unitIndices: entries.map((entry) => entry.index).sort((a, b) => a - b),
    sample: buildSample(entries),
  };
}

/**
 * Extractive summary: the first few substantial units of the month, joined whole.
 *
 * No model call and no ranking — the point of a tier is that it is cheap and
 * stable. Determinism is the requirement, so the selection is purely positional
 * over the time-ordered bucket.
 *
 * @param {Array<{unit: unknown}>} entries
 * @param {number} maxSummaryChars
 * @returns {string}
 */
function buildSummary(entries, maxSummaryChars) {
  /** @type {string[]} */
  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    if (items.length >= SUMMARY_UNIT_COUNT) break;
    const raw = textOf(entry.unit);
    if (raw.length < SUMMARY_MIN_TEXT_CHARS) continue;
    const item = truncate(cleanText(raw), SUMMARY_TEXT_CHARS);
    // A duplicate is not a summary entry; skipping it leaves the slot for a
    // unit that carries something new.
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return joinWithin(items, ' / ', maxSummaryChars);
}

/**
 * The wider, looser view behind `selectMonths`. Not for display.
 *
 * @param {Array<{unit: unknown}>} entries
 * @returns {string}
 */
function buildSample(entries) {
  /** @type {string[]} */
  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    if (items.length >= SAMPLE_UNIT_COUNT) break;
    const item = truncate(cleanText(textOf(entry.unit)), SAMPLE_TEXT_CHARS);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return joinWithin(items, ' ', SAMPLE_MAX_CHARS);
}

/**
 * Join whole items while the result stays within `limitChars`.
 *
 * Truncating on item boundaries (rather than on the string) keeps every summary
 * a concatenation of real excerpts — a reader can always match an entry back to
 * a unit, and a caller can never receive half a sentence that reads as a fact.
 *
 * @param {string[]} items
 * @param {string} separator
 * @param {number} limitChars
 * @returns {string}
 */
function joinWithin(items, separator, limitChars) {
  let out = '';
  for (const item of items) {
    const next = out ? out + separator + item : item;
    if (charLength(next) > limitChars) break;
    out = next;
  }
  return out;
}

/**
 * Truncate to `maxChars` characters without splitting a surrogate pair.
 *
 * A lone surrogate is a real defect in this codebase — `scripts/diagnose-surrogates.mjs`
 * exists because such rows were found in the index — and a summary is written
 * back into the index, so it must not manufacture them.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars) {
  if (!text) return '';
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return characters.slice(0, maxChars).join('').trim();
}

/**
 * Flatten a transcript fragment to one line of text.
 *
 * Newlines are separators, not content: an excerpt routinely spans several lines
 * and a summary entry has one line to spend. Collapsing every whitespace run also
 * keeps the " / " join unambiguous, including for tab-indented code.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * A unit's text as a string, whatever shape the row arrived in.
 *
 * @param {unknown} unit
 * @returns {string}
 */
function textOf(unit) {
  const text = unit && typeof unit === 'object' ? unit.text : undefined;
  return typeof text === 'string' ? text : '';
}

/**
 * 'YYYY-MM' in UTC, or `UNKNOWN_MONTH` when the timestamp cannot name a month.
 *
 * The length check exists because the sort order depends on a fixed-width key: a
 * year past 9999 formats wider than four digits and would sort (by string) as if
 * it were an earlier year. Such a row is unknown, not a month.
 *
 * @param {unknown} time
 * @returns {string}
 */
function monthKeyOf(time) {
  if (!isValidTime(time)) return UNKNOWN_MONTH;
  const date = new Date(Number(time));
  const key = String(date.getUTCFullYear()).padStart(4, '0')
    + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
  return key.length === 7 ? key : UNKNOWN_MONTH;
}

/**
 * Sort key for a unit inside its bucket.
 *
 * An invalid timestamp sorts at 0. Inside a real month that cannot happen; in the
 * unknown bucket the order between two undated units is meaningless, so the unit
 * index is what makes it reproducible.
 *
 * @param {unknown} time
 * @returns {number}
 */
function sortableTime(time) {
  return isValidTime(time) ? Number(time) : 0;
}

/**
 * Whether a timestamp can name a calendar month at all.
 *
 * `time` comes from the extractor, and a row written before timestamps were
 * recorded can carry 0 or NaN. Those are not "1 January 1970" — they are unknown,
 * and bucketing them at the epoch would put them at the bottom of a newest-first
 * list while claiming to know when they happened.
 *
 * @param {unknown} time
 * @returns {boolean}
 */
function isValidTime(time) {
  const value = Number(time);
  return Number.isFinite(value) && value > 0 && value <= MAX_TIME_MS;
}

/**
 * @param {string} query
 * @returns {string}
 */
function normalizeQuery(query) {
  return String(query ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * A positive integer from an option, or the fallback.
 *
 * Malformed options fall back instead of being coerced: a cap of `NaN` means
 * "unset", not "zero characters".
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Length in characters (code points), not UTF-16 units: one emoji is one
 * character, and a limit measured in code units would reject a summary that
 * reads as short.
 *
 * @param {string} text
 * @returns {number}
 */
function charLength(text) {
  return Array.from(text).length;
}
