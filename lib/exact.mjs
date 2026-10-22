/**
 * Exact-match retrieval arm: quoted phrases, dates, tags and paths.
 *
 * Why a third arm: the vector arm answers "what is this about" and the lexical
 * arm answers "which tokens co-occur", so neither can honour a user who typed a
 * literal string, a calendar day, or a file path. VCP 2.0's DailyNoteAPI solves
 * that by scanning the raw notes for exactly those tokens before falling back to
 * semantic search; this module is that first pass. It stays a pure function over
 * `units` so the fusion layer can rank it as its own RRF arm without agreeing on
 * a score scale with the other two.
 *
 * Three deliberate choices, each because the obvious alternative is wrong:
 *
 *   - A span is claimed once. Text inside quotes is a literal phrase and is not
 *     re-read for tags or dates: a unit would otherwise be scored by two rules
 *     for one substring, and the `rest` rewrite would overwrite the same range
 *     twice.
 *   - Dates compare on the LOCAL calendar (getFullYear/getMonth/getDate). A
 *     memory written at 07:00 in UTC+8 is 23:00 the previous day in UTC, but a
 *     user asking for "2026-10-22" means the day they lived through.
 *   - An invalid date keeps its text in `rest` instead of being stripped. If
 *     "2026-13" were consumed, the query would lose a token that no arm matched,
 *     which reads to the user as "the search ignored my words".
 *
 * `kind` on a hit names the arm that contributed the most to that hit's score,
 * so a caller can explain a hit without replaying the scoring. It does not
 * affect ordering; tied scores break on index so output is deterministic.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * @typedef {object} ExactDate
 * @property {number} year
 * @property {number} [month]  1-12; absent only for a bare year, which the
 *   parser never emits today but the scorer tolerates
 * @property {number} [day]    1-31
 */

/**
 * @typedef {object} ExactQuery
 * @property {string[]} phrases   quoted spans with the quotes removed
 * @property {ExactDate[]} dates
 * @property {string[]} tags      names only, no hash or "tag:" prefix
 * @property {string[]} paths
 * @property {string} rest        the query with every claimed span removed
 */

// Weights from the adapter contract: a phrase outranks a path or tag, and a day
// outranks a month, because each step is more specific.
const PHRASE_WEIGHT = 3;
const PATH_WEIGHT = 2;
const TAG_WEIGHT = 2;
const DATE_DAY_WEIGHT = 3;
const DATE_MONTH_WEIGHT = 1;

/**
 * Same width as MemoryIndex.recall defaults its k to, so a caller fusing the
 * arms feeds equal-length rank lists and no arm is starved by fusion.
 */
const DEFAULT_LIMIT = 20;

/**
 * Quoted phrases, one alternative per quote style. The ASCII single quote is
 * guarded on both sides so contractions ("don't") and possessives are not read
 * as the opening of a phrase; without the guards, "it's a 'test'" would parse as
 * a phrase starting inside "it's".
 */
const QUOTED = /"([^"\n]+)"|“([^”\n]+)”|「([^」\n]+)」|(?<![\p{L}\p{N}])'([^'\n]+)'(?![\p{L}\p{N}])/gu;

/**
 * 2026-10, 2026-10-22, 2026/10/22. Greedy on the day so "2026-10-32" fails as a
 * whole rather than backtracking to a valid "2026-10": the user typed a day, and
 * silently dropping it would make the date arm answer a question nobody asked.
 */
const DATE = /\b(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?\b/g;

/**
 * Hash tags. A trailing space breaks the character class, so a Markdown heading
 * "# 标题" contributes nothing.
 */
const HASH_TAG = /#([\p{L}\p{N}_-]+)/gu;

/** "tag:name", case-insensitive; the word boundary keeps "posttag:x" out. */
const PREFIX_TAG = /\btag:([\p{L}\p{N}_-]+)/giu;

/**
 * Whitespace-or-punctuation-delimited token. Slash and dot are kept because a
 * path needs them; CJK sentence punctuation is dropped so a trailing "。" does
 * not become part of a filename.
 */
const TOKEN = /[^\s"'’‘“”「」,，。；;、:：!！?？()（）\[\]【】<>{}]+/g;

/** An extension as the contract defines it: one to five alphanumerics. */
const EXTENSION = /(\.[a-z0-9]{1,5})\b/i;

/**
 * Empty result for "no query" and for "parsing blew up". A factory rather than a
 * shared constant so a caller that mutates one result cannot poison the next.
 *
 * @returns {ExactQuery}
 */
function emptyExactQuery() {
  return { phrases: [], dates: [], tags: [], paths: [], rest: '' };
}

/**
 * @param {ExactDate} a
 * @param {ExactDate} b
 * @returns {boolean}
 */
function sameDate(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * Whether a token names a file or directory rather than a piece of prose.
 *
 * The contract's test is "contains a slash and is at least 3 characters, or
 * carries an extension". The extra condition here is that the extension must
 * contain a letter: otherwise "1.5", "v1.2" and "GPT-5.2" all qualify, and a
 * version number would be scored as a path — precisely the kind of false
 * positive that makes an exact arm worse than no arm.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikePath(token) {
  if (token.length < 3) return false;
  if (token.includes('/')) return true;
  const match = EXTENSION.exec(token);
  return Boolean(match && /[a-z]/i.test(match[1].slice(1)));
}

/**
 * Split a query into the exact tokens it contains and the prose left over.
 *
 * Never throws: malformed input yields the empty structure, because this runs on
 * the recall path where a parse error would cost the user their whole turn.
 *
 * @param {string} query
 * @returns {ExactQuery}
 */
export function parseExactQuery(query) {
  if (typeof query !== 'string') return emptyExactQuery();

  const text = query.trim();
  if (!text) return emptyExactQuery();

  try {
    /** @type {ExactQuery} */
    const parsed = { phrases: [], dates: [], tags: [], paths: [], rest: text };
    /** @type {Array<[number, number]>} half-open [start, end) ranges already claimed */
    const spans = [];
    /** @param {number} start @param {number} end */
    const claim = (start, end) => { spans.push([start, end]); };
    /** @param {number} start @param {number} end */
    const claimed = (start, end) => spans.some((entry) => start < entry[1] && entry[0] < end);

    // 1. Quoted phrases claim their innermost text first, so every later rule
    //    can skip whatever a phrase already owns.
    for (const match of text.matchAll(QUOTED)) {
      const body = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
      if (!body) continue;
      if (!parsed.phrases.includes(body)) parsed.phrases.push(body);
      const at = match.index ?? 0;
      claim(at, at + match[0].length);
    }

    // 2. Dates. An out-of-range month or day is skipped *before* the span is
    //    claimed, so the text survives into `rest` and the lexical arm can still
    //    see it.
    for (const match of text.matchAll(DATE)) {
      const at = match.index ?? 0;
      if (claimed(at, at + match[0].length)) continue;
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (month < 1 || month > 12) continue;
      /** @type {ExactDate} */
      const date = { year, month };
      if (match[3] !== undefined) {
        const day = Number(match[3]);
        if (day < 1 || day > 31) continue;
        date.day = day;
      }
      if (!parsed.dates.some((existing) => sameDate(existing, date))) parsed.dates.push(date);
      claim(at, at + match[0].length);
    }

    // 3. Paths, token by token, so "2026/10/22" is already owned by the date
    //    rule above and cannot be read as a path with slashes.
    for (const match of text.matchAll(TOKEN)) {
      const at = match.index ?? 0;
      // A sentence-final period belongs to the prose, not to the filename — but
      // the claimed span still has to cover it, otherwise every sentence that
      // ends on a path leaves a stray "." in `rest`.
      const raw = match[0];
      const token = raw.replace(/\.+$/, '');
      if (!looksLikePath(token)) continue;
      if (claimed(at, at + token.length)) continue;
      if (!parsed.paths.includes(token)) parsed.paths.push(token);
      claim(at, at + raw.length);
    }

    // 4. Tags last, because a line anchor ("docs/plan.md#L24") is part of the
    //    path and must not also register as a tag.
    for (const pattern of [HASH_TAG, PREFIX_TAG]) {
      for (const match of text.matchAll(pattern)) {
        const at = match.index ?? 0;
        if (claimed(at, at + match[0].length)) continue;
        const name = match[1];
        if (!name) continue;
        const key = name.toLowerCase();
        if (!parsed.tags.some((tag) => tag.toLowerCase() === key)) parsed.tags.push(name);
        claim(at, at + match[0].length);
      }
    }

    // Rewrite right-to-left so earlier offsets stay valid, then collapse the
    // gaps left behind into single spaces.
    let rest = text;
    for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
      rest = rest.slice(0, start) + ' ' + rest.slice(end);
    }
    parsed.rest = rest.replace(/\s+/g, ' ').trim();

    return parsed;
  } catch {
    return emptyExactQuery();
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function resolveLimit(value) {
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_LIMIT;
}

/**
 * Score units against the exact tokens in a query.
 *
 * Per the contract: each phrase hit +3 (additive across phrases), each path hit
 * +2, each tag hit +2, a date's day +3 or its month +1. Matching is
 * case-insensitive on the unit text, which is the only sane rule for a user who
 * typed a filename in the wrong case.
 *
 * @param {Array<{text: string, time: number}>} units
 * @param {ExactQuery} parsed
 * @param {{limit?: number}} [options]
 * @returns {{index: number, score: number, kind: string}[]}
 */
export function searchExact(units, parsed, options = {}) {
  if (!Array.isArray(units) || units.length === 0) return [];
  if (!parsed || typeof parsed !== 'object') return [];

  const phrases = Array.isArray(parsed.phrases) ? parsed.phrases.filter(isNonEmptyString) : [];
  const paths = Array.isArray(parsed.paths) ? parsed.paths.filter(isNonEmptyString) : [];
  const tags = Array.isArray(parsed.tags) ? parsed.tags.filter(isNonEmptyString) : [];
  const dates = Array.isArray(parsed.dates) ? parsed.dates.filter((date) => date && typeof date === 'object') : [];

  // No exact intent means no exact rank list at all. Returning every unit at
  // score 0 would still contribute to RRF and would drown the other two arms
  // with an arbitrary ordering.
  if (phrases.length === 0 && paths.length === 0 && tags.length === 0 && dates.length === 0) return [];

  const limit = resolveLimit(options.limit);
  const loweredPhrases = phrases.map((phrase) => phrase.toLowerCase());
  const loweredPaths = paths.map((path) => path.toLowerCase());
  const loweredTags = tags.map((tag) => tag.toLowerCase());

  /** @type {{index: number, score: number, kind: string}[]} */
  const scored = [];

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const text = typeof unit?.text === 'string' ? unit.text.toLowerCase() : '';

    let phraseScore = 0;
    for (const phrase of loweredPhrases) if (text.includes(phrase)) phraseScore += PHRASE_WEIGHT;

    let pathScore = 0;
    for (const path of loweredPaths) if (text.includes(path)) pathScore += PATH_WEIGHT;

    let tagScore = 0;
    for (const tag of loweredTags) if (text.includes(tag)) tagScore += TAG_WEIGHT;

    let dateScore = 0;
    if (dates.length > 0 && typeof unit?.time === 'number' && Number.isFinite(unit.time)) {
      const stamp = new Date(unit.time);
      const year = stamp.getFullYear();
      const month = stamp.getMonth() + 1;
      const day = stamp.getDate();
      for (const date of dates) {
        if (date.year !== year) continue;
        if (date.month !== undefined && date.month !== month) continue;
        // A day-level date still credits the rest of that month at the month
        // weight: "the 22nd" narrows the month, it does not exclude it.
        if (date.day !== undefined) {
          dateScore += date.day === day ? DATE_DAY_WEIGHT : DATE_MONTH_WEIGHT;
        } else {
          dateScore += DATE_MONTH_WEIGHT;
        }
      }
    }

    const score = phraseScore + pathScore + tagScore + dateScore;
    if (score <= 0) continue;

    // Ties resolve toward the more specific arm: a phrase beats a date beats a
    // path beats a tag. Only the label changes; the score already contains all
    // four contributions.
    let kind = 'phrase';
    let best = phraseScore;
    if (dateScore > best) { kind = 'date'; best = dateScore; }
    if (pathScore > best) { kind = 'path'; best = pathScore; }
    if (tagScore > best) { kind = 'tag'; best = tagScore; }

    scored.push({ index, score, kind });
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit);
}
