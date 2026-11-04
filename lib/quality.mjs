/**
 * Content quality: what may be injected at all, and what a card is worth without a reranker.
 *
 * Two judgements live here because both are about the *text* rather than about a
 * ranking, and both were missing. Measured over 425 injected blocks (230 sessions):
 * 23-27% of entries were under 80 characters — a bare path, a tool-call fragment, a
 * line of log — and 57-68% had been cut mid-sentence at the preview cap, which is a
 * memory that reads as complete and is not. The score gate cannot see either defect:
 * it answers "is this relevant", and a JSON fragment can be relevant and useless.
 *
 * The length half of that first judgement was recalibrated on 2026-10-25: the floor
 * is compared against a CJK-weighted length, and a user message is exempt from it.
 * See {@link weightedLength} and the length rule in {@link contentRejectReason}.
 *
 * The second judgement is the degraded card path. A card enters the pool with
 * `score: 0` (it is not an RRF hit), so without a reranker the gate has no scale to
 * read it on. The absolute floor that stood in for one — 0.35 cosine — is close to
 * always true in the current embedding space (8 of 8 random tokens cleared it; the
 * cosine lower bound measured about 0.58), so it admitted a card for a query that
 * had none. A card is curated content, so the substitute is a *relative* reading:
 * one card, above a floor, and clearly ahead of the next one.
 *
 * This module imports nothing from `inject.mjs` or `policy.mjs` — both import it.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Defaults, shared by both callers.
 *
 * `minContentChars: 60` is where an entry stops being a fragment and starts being a
 * statement: below it, the injected block carries a path, a heading, or a single
 * clause out of context.
 *
 * **The unit is a Latin-character equivalent, not a character count.** A CJK
 * character is written without a space and carries roughly what two or three Latin
 * characters carry, so the comparison is made against `weightedLength(text)` —
 * one CJK character counts two — and 60 therefore means about 30 characters of
 * Chinese. The variable keeps its name and its environment spelling
 * (`DSH_G_MEMORY_MIN_CONTENT_CHARS`); a deployment that reads it as "characters"
 * is reading the old meaning. `maxEntryChars` is *not* weighted: it is the raw
 * character ceiling on a block sized in characters.
 *
 * `maxEntryChars: 1200` is the largest entry worth a slot in a block whose whole
 * budget is 1200 characters — an entry above it is dropped whole (a truncated
 * memory is a wrong memory), not clipped.
 */
export const QUALITY_LIMITS = { minContentChars: 60, maxEntryChars: 1200 };

/**
 * Code-point ranges that count double in {@link weightedLength}.
 *
 * CJK prose is written without spaces, so a fixed character floor calibrated on
 * Latin text cuts whole sentences. Measured on 2026-10-25 over a replay of 97 real
 * queries (1046 candidates): 137 entries were dropped as too-short, 16 of them the
 * highest-scored candidate of their pool, and 12 of 97 turns lost their only
 * injection. 78 of the 137 were `role: 'user'` sentences with a p50 length of 32
 * characters — short Chinese statements, not the paths and log lines the floor was
 * written for (the index layer already filtered 0-3 of those).
 *
 * Covers the unified-ideograph blocks and their extensions, the punctuation CJK
 * prose actually uses (`。，、：` — U+3000-303F), the fullwidth forms, and kana /
 * Hangul, which are written the same way. Code points are tested directly rather
 * than through a Unicode property escape so the weighting does not silently change
 * with the engine's Unicode tables.
 */
const CJK_RANGES = [
  [0x1100, 0x11ff],   // Hangul Jamo
  [0x2e80, 0x2eff],   // CJK radicals supplement
  [0x2f00, 0x2fdf],   // Kangxi radicals
  [0x3000, 0x303f],   // CJK symbols and punctuation: 。、〈〉《》「」
  [0x3040, 0x30ff],   // Hiragana and Katakana
  [0x3100, 0x312f],   // Bopomofo
  [0x3130, 0x318f],   // Hangul compatibility Jamo
  [0x31a0, 0x31bf],   // Bopomofo extended
  [0x31c0, 0x31ef],   // CJK strokes
  [0x3200, 0x32ff],   // Enclosed CJK letters and months
  [0x3300, 0x33ff],   // CJK compatibility
  [0x3400, 0x4dbf],   // CJK unified ideographs extension A
  [0x4e00, 0x9fff],   // CJK unified ideographs
  [0xa960, 0xa97f],   // Hangul Jamo extended-A
  [0xac00, 0xd7af],   // Hangul syllables
  [0xd7b0, 0xd7ff],   // Hangul Jamo extended-B
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe10, 0xfe19],   // Vertical forms
  [0xfe30, 0xfe4f],   // CJK compatibility forms
  [0xff01, 0xff60],   // Fullwidth ASCII variants and fullwidth punctuation
  [0xffe0, 0xffe6],   // Fullwidth signs (￥ etc.)
  [0x1f200, 0x1f2ff], // Enclosed ideographic supplement
  [0x20000, 0x2a6df], // CJK unified ideographs extension B
  [0x2a700, 0x2ebef], // CJK unified ideographs extensions C-F
  [0x2ebf0, 0x2ee5f], // CJK unified ideographs extension I
  [0x2f800, 0x2fa1f], // CJK compatibility ideographs supplement
  [0x30000, 0x3134f], // CJK unified ideographs extension G
];

/** Whether one code point is weighted double by {@link weightedLength}. */
function isWideCodePoint(codePoint) {
  for (const [low, high] of CJK_RANGES) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/**
 * Length in Latin-character equivalents: one CJK character counts two.
 *
 * The number `minContentChars` is compared against. Every non-CJK code point
 * counts one — ASCII and everything else, so a 60-character English sentence is
 * still exactly 60 and no Latin deployment changes behaviour. Iterating by code
 * point rather than by UTF-16 unit means an astral ideograph counts two, not four.
 *
 * @param {string} text
 * @returns {number}
 */
export function weightedLength(text) {
  let total = 0;
  for (const character of String(text ?? '')) {
    total += isWideCodePoint(character.codePointAt(0)) ? 2 : 1;
  }
  return total;
}

/**
 * Markers that identify a tool call or its arguments, whatever wraps them.
 *
 * The leading-bracket test catches serialised JSON; these catch the case where the
 * fragment is an argument list quoted inside prose, which does not start with a
 * bracket. A run_code result was injected that way on 2026-10-24 — `{ "callId": …,
 * "arguments": … }` pasted into a sentence — and it is the incident this filter
 * exists to stop.
 */
const TOOL_MARKERS = ['"callId"', '"tool_calls"', '"arguments":', '"type":"tool'];

/** `YYYY-MM-DD HH:MM:SS` at line start, with or without the brackets a log adds. */
const TIMESTAMP_LINE = /^\s*\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** Log levels in the shape `[ERROR]`, `[WARN]`, … */
const LOG_LEVEL = /\[(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]/;

/** A horizontal rule of the kind logs and dumps use to separate sections. */
const RULE_LINE = /^={3,}$/;

/**
 * One token with no spaces: the shape a bare path or identifier has.
 *
 * ASCII on purpose. Chinese prose has no spaces, so a CJK-inclusive class would
 * classify a one-line sentence that happens to contain a slash as a path and drop a
 * real memory — a false positive on the common case to catch a rarer one.
 */
const SINGLE_TOKEN = /^[\w.~/-]+$/;

/**
 * Why an entry must not be injected, or null when it may.
 *
 * Checked in this order, because the most specific reason is the one worth
 * recording: a 12-character JSON fragment is both `too-short` and `json`, and
 * reporting its length tells the operator less than reporting its shape. `too-long`
 * comes last: an entry that is oversized *and* a tool fragment is still reported as
 * the fragment.
 *
 * @param {{ text?: string, role?: string } | string} entry the whole entry: `role`
 *   decides whether the length rule applies (a user message is context, not an
 *   answer — see the length rule below)
 * @param {{ minContentChars?: number, maxEntryChars?: number }} [limits]
 * @returns {'too-short' | 'json' | 'tool-fragment' | 'path-only' | 'log-dump' | 'too-long' | null}
 */
export function contentRejectReason(entry, limits = QUALITY_LIMITS) {
  const cap = { ...QUALITY_LIMITS, ...limits };
  const text = typeof entry === 'string' ? entry : String(entry?.text ?? '');
  const role = typeof entry === 'string' ? undefined : entry?.role;

  // 1. Fragments. A path, a heading, one clause: inject nothing rather than a line
  //    that reads as content and carries none.
  //
  //    Two calibrations, both from the 2026-10-25 replay described on
  //    {@link CJK_RANGES}:
  //
  //    - The comparison is weighted, not counted: `minContentChars` is a length in
  //      Latin-character equivalents (one CJK character counts two), so its default
  //      of 60 admits a ~30-character Chinese sentence. The old raw count cut those
  //      whole sentences — 137 drops, 16 of them their pool's best candidate.
  //    - A user message is exempt from the *length* rule alone. What a user said is
  //      context or a preference, not an answer: "不需要节省时间与token资源，完成
  //      这个项目更加重要" is 26 characters and carries a decision that governed the
  //      whole session. A user message that is *also* a JSON fragment, a quoted tool
  //      call, a bare path, a log dump or oversized is still rejected by the rules
  //      below — those are shapes, not lengths.
  //
  //    An entry with no text at all stays `too-short` either way: there is nothing
  //    to inject, and that is not a length judgement.
  const body = text.trim();
  if (body === '') return 'too-short';
  if (role !== 'user' && weightedLength(body) < cap.minContentChars) return 'too-short';

  // 2. Serialised tool calls. Two shapes: the whole entry is JSON, or the arguments
  //    are quoted inside prose and the entry only contains them.
  const head = text.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (TOOL_MARKERS.some((marker) => text.includes(marker))) return 'tool-fragment';

  const lines = text.split('\n');

  // 3. A bare path is a locator, not a memory: the caller can re-read the file. A
  //    path with prose around it is a memory and is not caught here.
  if (lines.length === 1 && text.includes('/') && SINGLE_TOKEN.test(text.trim())) return 'path-only';

  // 4. Log dumps. A stack of timestamps or levels is a diagnostic artefact of the
  //    previous session, not a fact about it; quoting one costs 200 characters of a
  //    1200-character budget and answers nothing a later turn asks. Prose that
  //    merely *starts* with a timestamp line is not caught: three consecutive ones
  //    are.
  if (lines.length > 1) {
    if (lines.some((line) => RULE_LINE.test(line.trim()))) return 'log-dump';
    if (LOG_LEVEL.test(text)) return 'log-dump';
    let streak = 0;
    for (const line of lines) {
      streak = TIMESTAMP_LINE.test(line) ? streak + 1 : 0;
      if (streak >= 3) return 'log-dump';
    }
  }

  // 5. Oversized. Dropped whole rather than clipped: a memory cut mid-sentence is
  //    read as complete, and that is the failure this plugin ranks worst. Raw
  //    characters, not weighted ones: this is a ceiling on a block whose budget is
  //    counted in characters, and no user-role exemption applies (the block does not
  //    grow because the text is dense).
  if (text.length > cap.maxEntryChars) return 'too-long';

  return null;
}

/**
 * The cards a degraded (no-reranker) recall may inject: at most one.
 *
 * On this path a card has no cross-encoder score, so the only things readable are its
 * own similarity and its *lead* over the next card. The floor alone was measured
 * nearly vacuous (see the module note); the margin is what an unrelated query fails,
 * because its top cards are interchangeable. Fewer than two candidates leaves the
 * margin undefined, so it is not read — a one-card pool already means retrieval
 * narrowed hard, and vetoing it would lose a real match to a rule with nothing to say
 * about it.
 *
 * Only entries with `source: 'card'` are considered; `dropped` counts card entries
 * not returned. The selected card is marked `unverified`, because nothing on this
 * path confirmed its relevance against the query.
 *
 * @param {Array<{ source?: string, similarity?: number, text?: string, [k: string]: unknown }>} entries
 * @param {{ cardMinSimilarity?: number, cardMargin?: number }} [options]
 * @returns {{ entries: any[], dropped: number, reason?: string }}
 */
export function pickDegradedCards(entries, { cardMinSimilarity = 0.68, cardMargin = 0.02 } = {}) {
  const cards = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.source === 'card');
  const ranked = cards
    .map((entry) => ({ entry, similarity: Number(entry.similarity ?? 0) }))
    .sort((a, b) => b.similarity - a.similarity);
  const reject = (reason) => ({ entries: [], dropped: cards.length, reason });

  if (ranked.length === 0) return reject('no card candidate');
  if (cardMinSimilarity > 0 && ranked[0].similarity < cardMinSimilarity) {
    return reject(`best card similarity ${ranked[0].similarity.toFixed(3)} is below ${cardMinSimilarity}`);
  }
  if (cardMargin > 0 && ranked.length >= 2) {
    const margin = ranked[0].similarity - ranked[1].similarity;
    if (margin < cardMargin) {
      return reject(`card margin ${margin.toFixed(3)} is below ${cardMargin}: the top cards are indistinguishable, which is what an unrelated query looks like`);
    }
  }

  return { entries: [{ ...ranked[0].entry, unverified: true }], dropped: cards.length - 1 };
}

/**
 * Local `YYYY-MM-DD HH:mm` for a timestamp.
 *
 * Rendered times were `toISOString()`, i.e. UTC. At UTC+8 every memory was injected
 * eight hours younger than it was, and the recall evaluation's "the smallest original
 * age is exactly 8.0h" was that offset showing up as data. The block is read by a
 * person and a model working in local time, so it is formatted in local time.
 *
 * @param {number} ms epoch milliseconds
 * @returns {string} `unknown time` when the value is not a usable timestamp
 */
export function formatLocalTime(ms) {
  const value = Number(ms);
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return 'unknown time';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
