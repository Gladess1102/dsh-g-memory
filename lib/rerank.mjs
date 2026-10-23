/**
 * Cross-encoder reranking client (llama.cpp `/v1/rerank`).
 *
 * ## Why this exists
 *
 * The retrieval arms are tuned for recall: measured on a real 12k-unit index,
 * fused recall@20 is 8/8 while top-1 is only 4-5/8. In other words the answer is
 * almost always *in the candidate pool* and the ranking is what fails. That is
 * precisely the problem a cross-encoder solves, because it scores a (query,
 * document) pair jointly instead of comparing two independently-produced
 * vectors — so it can tell "mentions the same words" from "answers this
 * question".
 *
 * ## Design rules
 *
 *   - **The cross-encoder score becomes the relevance score.** This module used
 *     to return an order only, keeping the fused RRF scores, on the theory that a
 *     second score scale would break `selectForInjection`'s RRF-calibrated
 *     threshold. Measurement retired that theory. On 8 answerable and 8
 *     deliberately unanswerable queries, top-1 fused RRF was 0.0159-0.0315 for
 *     the answerable set and 0.0145-0.0298 for the unanswerable one: the bands
 *     overlap almost completely, because a query that hits a single arm at a low
 *     rank lands near the 1/61 floor no matter how irrelevant it is. The
 *     cross-encoder separates the same two sets cleanly — unanswerable max 2.95,
 *     answerable min 2.46, medians -4.41 against 5.64. So when a reranker is
 *     configured its score, not RRF, is what the relevance gate reads.
 *   - **Opt-in.** No `DSH_G_MEMORY_RERANK_URL`, no reranking. Nothing new starts
 *     listening, and the plugin behaves exactly as before.
 *   - **Never fatal.** Every failure path returns `null`, and the caller keeps
 *     the fused order. A reranker that is down must degrade to a worse ranking,
 *     never to a failed recall.
 *   - **The caller owns the direction of the degradation.** "A worse ranking"
 *     must not become "a looser gate": when `reranked` comes back false the
 *     scores are fused RRF, and the sweep in the 2026-10-24 review showed the
 *     callers were tightening nothing — a card's cosine floor of 0.35 is below
 *     the noise floor of the current embedding space, so a degraded pool admitted
 *     whatever the arms happened to rank. This module deliberately does not
 *     compensate (it has no policy to read); it reports `reranked: false` and
 *     the callers clamp there: cards to a single top-1 that clears a relative
 *     margin, and the transcript to the RRF floor. See `rerankAvailable`.
 *
 * SPDX-License-Identifier: MIT
 */

import { numberEnv } from './env.mjs';

/**
 * Minimum cross-encoder score for a candidate to count as a memory at all.
 *
 * The default is 0 because that is where the measured separation is: a
 * cross-encoder scores a relevant pair positive and an irrelevant one negative.
 * At 0 the gate kept all 8 answerable queries and rejected 6 of the 8
 * unanswerable ones. The comparison that matters is against the alternatives —
 * the RRF floor kept 4 and rejected 7, and the silent no-op gate this replaces
 * kept 8 and rejected none, which is what let irrelevant chunks reach the
 * synthesiser. The two negative queries that survive at 0 scored 2.16 and 2.95;
 * an operator who would rather miss one answerable query (top-1 score 2.46) than
 * risk those two can raise this. Negative values are meaningful, so there is no
 * lower bound.
 */
/** Defaults; `url` is deliberately empty so reranking is off unless configured. */
/**
 * Defaults, read at call time.
 *
 * This used to be a module-level constant, which froze whatever the environment
 * held at import. `DSH_G_MEMORY_*` is how the CLI, the eval scripts and the
 * tests configure the package, so a later `process.env` change — a test
 * stubbing an endpoint, a shell that exports a different URL — silently did
 * nothing. That is the same shape that shipped a dead embedding endpoint in
 * 0.9.1; the embedder was fixed then, the rest of the config surface was not.
 *
 * @returns the defaults for this call, environment included.
 */
export function defaultRerankConfig() {
  return {
    url: process.env.DSH_G_MEMORY_RERANK_URL || '',
    model: process.env.DSH_G_MEMORY_RERANK_MODEL || 'bge-reranker-v2-m3',
    timeoutMs: numberEnv('DSH_G_MEMORY_RERANK_TIMEOUT_MS', 30_000, { min: 500 }),
    apiKey: process.env.DSH_G_MEMORY_RERANK_KEY || undefined,
    /**
     * Endpoint path. llama.cpp and TEI expose `/v1/rerank`, some gateways expose
     * `/rerank`, and hosted APIs differ again — hardcoding one makes the plugin
     * unusable against the others.
     */
    path: process.env.DSH_G_MEMORY_RERANK_PATH || '/v1/rerank',
    minScore: numberEnv('DSH_G_MEMORY_RERANK_MIN_SCORE', 0),
    /**
     * How much of each document the cross-encoder reads. Measured on 60 labelled
     * cases: 300 characters scored *better* than the whole fragment (top-1 50/60 vs
     * 49/60) and ran 2.7x faster (1.5 s vs 4.1 s) — the head of a fragment carries
     * its topic while the tail mostly adds noise. The speed matters as much as the
     * accuracy: at 4 s per call a second concurrent recall queued past the 30 s
     * timeout and the turn silently fell back to fused order instead of reranking.
     * 0 disables truncation (sends the whole document).
     */
    maxChars: numberEnv('DSH_G_MEMORY_RERANK_MAX_CHARS', 300, { min: 0 }),
    };
}

/**
 * Clip documents to what the cross-encoder should read.
 *
 * Exported so the clipping can be tested without an HTTP endpoint.
 *
 * @param {string[]} documents
 * @param {number} maxChars
 * @returns {string[]}
 */
export function clipForRerank(documents, maxChars) {
  if (!(maxChars > 0)) return documents;
  return documents.map((d) => (d.length > maxChars ? d.slice(0, maxChars) : d));
}

/**
 * How many fused candidates to hand to the reranker.
 *
 * Deeper than the 12 the vector arm used on its own, because the reranker can
 * only reorder what it is given: a pool of 20 is where recall@20 saturates
 * (8/8), so anything beyond it adds latency without adding answers.
 */
export const DEFAULT_RERANK_CANDIDATES = 20;

/**
 * @param {object} [overrides]
 * @returns {ReturnType<typeof defaultRerankConfig>}
 */
export function resolveRerankConfig(overrides = {}) {
  return { ...defaultRerankConfig(), ...overrides };
}

/**
 * Whether a reranker is configured at all.
 *
 * The one predicate both retrieval paths use, because "configured" was being
 * decided by reading the composition object alone — so a reranker set through
 * `DSH_G_MEMORY_RERANK_URL` sized the candidate pool as though there were none
 * while `rerankEntries` below did call it.
 *
 * The answer is also what tells a caller which direction to tighten in on a
 * failure: with a reranker configured the scores are cross-encoder logits and the
 * gate can read them; without one `rerankEntries` returns `reranked: false` and
 * the caller must clamp instead of loosening (see the module note above).
 *
 * @param {Partial<ReturnType<typeof defaultRerankConfig>>} [config]
 * @returns {boolean}
 */
export function rerankAvailable(config = {}) {
  return String(resolveRerankConfig(config).url ?? '').trim() !== '';
}

/** Reranking was configured but unusable. Callers treat this as "keep fused order". */
export class RerankUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RerankUnavailableError';
  }
}

/**
 * Order documents by relevance to a query.
 *
 * @param {string} query
 * @param {string[]} documents
 * @param {Partial<ReturnType<typeof defaultRerankConfig>>} [config]
 * @returns {Promise<Array<{ index: number, score: number }> | null>} scored
 *   entries best-first, or `null` when reranking is disabled or fails — the
 *   caller then keeps its own order and its own scores.
 */
export async function rerankOrder(query, documents, config = {}) {
  const cfg = resolveRerankConfig(config);
  const base = String(cfg.url || '').trim();
  if (!base) return null;
  if (!Array.isArray(documents) || documents.length < 2) return null;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let response;
  try {
    response = await fetch(`${base.replace(/\/$/, '')}${cfg.path}`, {
      method: 'POST',
      headers,
      // Only the request is clipped; the caller's entries keep their full text.
      body: JSON.stringify({ model: cfg.model, query, documents: clipForRerank(documents, cfg.maxChars) }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (cause) {
    throw new RerankUnavailableError(
      `rerank endpoint unreachable at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RerankUnavailableError(`rerank request failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  const payload = await response.json().catch(() => null);
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (results === null || results.length !== documents.length) {
    throw new RerankUnavailableError(
      `rerank response malformed: expected ${documents.length} results, got ${results?.length ?? 'none'}`,
    );
  }

  // Sort by score, descending. Ties keep their original relative order, which
  // makes the output deterministic for a deterministic server.
  const ordered = results
    .map((entry, position) => ({
      index: Number.isInteger(entry?.index) ? entry.index : position,
      score: Number(entry?.relevance_score ?? entry?.score ?? 0),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < documents.length)
    .sort((a, b) => (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0));

  if (ordered.length !== documents.length) {
    throw new RerankUnavailableError('rerank response did not cover every document');
  }
  return ordered;
}

/**
 * Reorder `entries` by cross-encoder relevance, stamping each with its score.
 *
 * On success every returned entry carries `rerankScore`, so the caller can apply
 * a relevance gate on the cross-encoder's scale instead of the fused one — see
 * the design note at the top of this module for why that is the scale that
 * separates answerable from unanswerable queries. The entry's own `score` field
 * is left alone; the two are kept apart so a caller can tell which scale it is
 * looking at.
 *
 * Returns the input untouched when reranking is disabled or fails, so callers
 * need no branching — but `reranked: false` is a verdict they must act on:
 * the scores are then fused RRF, not cross-encoder logits, and the callers tighten
 * their gates on it rather than reading the fused scale as agreement (see the
 * module note and `rerankAvailable`).
 *
 * @template {{ text: string }} T
 * @param {string} query
 * @param {T[]} entries
 * @param {{ config?: Partial<ReturnType<typeof defaultRerankConfig>>, onFailure?: (error: Error) => void }} [options]
 * @returns {Promise<{ entries: T[], reranked: boolean }>}
 */
export async function rerankEntries(query, entries, options = {}) {
  if (!Array.isArray(entries) || entries.length < 2) return { entries, reranked: false };
  try {
    const order = await rerankOrder(query, entries.map((entry) => String(entry.text ?? '')), options.config);
    if (order === null) return { entries, reranked: false };
    return {
      entries: order.map(({ index, score }) => ({ ...entries[index], rerankScore: score })),
      reranked: true,
    };
  } catch (error) {
    // Reported, not swallowed: silently serving fused order would make a broken
    // reranker look like a reranker that simply did not help.
    options.onFailure?.(error instanceof Error ? error : new Error(String(error)));
    return { entries, reranked: false };
  }
}
