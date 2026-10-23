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
 * clause out of context. `maxEntryChars: 1200` is the largest entry worth a slot in
 * a block whose whole budget is 1200 characters — an entry above it is dropped whole
 * (a truncated memory is a wrong memory), not clipped.
 */
export const QUALITY_LIMITS = { minContentChars: 60, maxEntryChars: 1200 };

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
 * @param {{ text?: string } | string} entry
 * @param {{ minContentChars?: number, maxEntryChars?: number }} [limits]
 * @returns {'too-short' | 'json' | 'tool-fragment' | 'path-only' | 'log-dump' | 'too-long' | null}
 */
export function contentRejectReason(entry, limits = QUALITY_LIMITS) {
  const cap = { ...QUALITY_LIMITS, ...limits };
  const text = typeof entry === 'string' ? entry : String(entry?.text ?? '');

  // 1. Fragments. A path, a heading, one clause: inject nothing rather than a line
  //    that reads as content and carries none.
  if (text.trim().length < cap.minContentChars) return 'too-short';

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
  //    read as complete, and that is the failure this plugin ranks worst.
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
