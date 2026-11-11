/**
 * Recall policy: which past is allowed into view, and how much of it.
 *
 * This module exists because the gate on the automatic path was a no-op. It read
 * a fused RRF score with a floor of 1/61, and measured over 8 answerable and 8
 * unanswerable queries those two sets occupy one overlapping band
 * (0.0159-0.0315 against 0.0145-0.0298) — a query hitting a single arm at a low
 * rank lands near the floor however irrelevant it is. The practical effect was an
 * injection on 100% of user turns.
 *
 * The shape here is borrowed from VCPToolBox, which states the principle this
 * plugin was violating: "主动" means the context organises the past, "并不表示
 * 系统应无条件注入全部历史" — topic gating, dynamic K, Truncate and Rerank
 * together decide what qualifies. Concretely, from `docs/VCP记忆管理系统.md`:
 *
 *   - `::Truncate0.4`  — hard filter on the *final* score, after reranking.
 *   - `::TimeDecay`    — decay older results rather than filtering by date.
 *   - dynamic K        — a multiplier, not a fixed count.
 *   - gated vs ungated — `《《本》》` gates, `[[本]]` does not; the docs recommend
 *                        the gated form for anything mounted long-term because
 *                        "它能减少无关检索和上下文污染".
 *   - time-scale tiers — OneRing (recent raw) / OneRingMemo (days) / TimeLine
 *                        (months) / diary (long-term), each with its own budget.
 *
 * The tiering is the part this plugin most needed. A single 13k-unit index makes
 * a message from two hours ago compete on equal terms with one from six months
 * ago; VCP separates them by construction. Here the same separation is applied
 * to one index by scoring age: the recent tier is effectively ungated (it is
 * small and almost always relevant), and the threshold tightens with age.
 *
 * SPDX-License-Identifier: MIT
 */

import { numberEnv } from './env.mjs';
// The injection frame is not negotiable text, and a budget below it means "never
// inject anything" rather than "inject less". Importing the measured floor keeps
// the two numbers from drifting apart.
import { INJECTION_MIN_TOTAL_CHARS } from './inject.mjs';
// Text quality and the degraded card rule are about content, not about ranking, so
// they live in one module both paths import rather than being reimplemented here.
// `quality.mjs` imports neither this module nor `inject.mjs`: no cycle.
import { contentRejectReason, pickDegradedCards } from './quality.mjs';

/** How the automatic path is allowed to reach the model at all. */
export const RECALL_MODES = ['context', 'tools', 'hybrid'];

/**
 * Reasons that mean "this candidate was not content at all", as opposed to "this
 * candidate was content but too old, too weak, or a card that lost a coin flip".
 *
 * The distinction is what an empty recall's reason string is *for*. A pool emptied by
 * the content filter needs a different repair (a threshold calibrated for the wrong
 * language, a fixture, an extraction shape) from a pool emptied by the age floor
 * (a gate calibration). Reporting the floor for both sent an operator — and this
 * file's own author — to a number that had never been read, on 23 recorded turns.
 * These are the keys `contentRejectReason` can return; see lib/quality.mjs.
 */
const CONTENT_REJECTIONS = new Set(['too-short', 'json', 'tool-fragment', 'path-only', 'log-dump', 'too-long']);

/**
 * @typedef {object} RecallPolicy
 * @property {number} gate               final-score floor for the long-term tier
 * @property {number} recentDays         age (days) still counted as the recent tier
 * @property {number} recentGate         floor for the recent tier; -Infinity disables it
 * @property {number} midDays            age (days) still counted as the mid tier
 * @property {number} midGate            floor for the mid tier
 * @property {number} decayDays          decay period in days; 0 disables
 * @property {number} decayFactor        score multiplier removed per decay period
 * @property {number} kMultiplier        candidate-count multiplier (VCP's dynamic K)
 * @property {number} briefScore         score at or above which a candidate is "full"
 * @property {number} briefChars         preview size for a below-`briefScore` candidate
 * @property {number} fullChars          preview size for an at-or-above candidate
 * @property {number} maxEntries         hard cap on injected entries
 * @property {number} maxTotalChars      hard cap on the whole injected block, frame included
 * @property {string} mode               one of {@link RECALL_MODES}
 * @property {number} synthesisMargin    head-margin below which a recall is
 *                                       treated as needing assembly (see
 *                                       needsSynthesis); 0 never synthesises
 * @property {number} cardMinSimilarity  card eligibility on the *degraded* path
 *                                       (no reranker), where a card has no score
 *                                       on the gate's scale; 0 disables the rule
 * @property {number} cardMargin         lead the top card must have over the next
 *                                       one on that path; 0 disables the rule
 * @property {number} minContentChars    shortest entry worth injecting; a shorter
 *                                       one is a fragment, not a memory
 * @property {number} maxEntryChars      longest entry worth injecting; a longer one
 *                                       is dropped whole rather than clipped
 * @property {number} marginGate         head-margin floor for the automatic path;
 *                                       0 disables it (see {@link selectByPolicy})
 */

/**
 * What each field accepts, so an override cannot set a value the env path would
 * have rejected. Kept beside the defaults rather than in a schema library: this
 * module has no dependencies.
 */
const FIELD_SPECS = {
  gate: { kind: 'number' },
  recentDays: { kind: 'number', min: 0 },
  recentGate: { kind: 'number' },
  midDays: { kind: 'number', min: 0 },
  midGate: { kind: 'number' },
  decayDays: { kind: 'number', min: 0 },
  decayFactor: { kind: 'number', min: 0, max: 1 },
  kMultiplier: { kind: 'number', min: 0.1, max: 10 },
  briefScore: { kind: 'number' },
  briefChars: { kind: 'number', min: 40 },
  fullChars: { kind: 'number', min: 40 },
  maxEntries: { kind: 'number', min: 1, max: 10 },
  maxTotalChars: { kind: 'number', min: INJECTION_MIN_TOTAL_CHARS },
  marginGate: { kind: 'number', min: 0 },
  cardMinSimilarity: { kind: 'number', min: 0, max: 1 },
  cardMargin: { kind: 'number', min: 0, max: 1 },
  minContentChars: { kind: 'number', min: 0 },
  maxEntryChars: { kind: 'number', min: 100 },
  synthesisMargin: { kind: 'number', min: 0 },
  mode: { kind: 'mode' },
};

/**
 * Apply composition overrides on top of the environment defaults.
 *
 * `overrides` used to be accepted and ignored: the parameter existed, nothing
 * read it, and `config.policy` — which `lib/config.mjs` declares and documents —
 * therefore had no effect at all. Only environment variables ever moved a
 * threshold, while the composition appeared to configure one. Same defect class
 * as `options.rerank` never reaching `AutoRecall`: configuration that is
 * silently discarded rather than rejected.
 *
 * Invalid values are dropped, not coerced: a threshold that cannot be parsed is
 * a configuration mistake, and the env default is the safe thing to keep.
 */
function applyOverrides(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const out = { ...base };
  for (const [key, spec] of Object.entries(FIELD_SPECS)) {
    const raw = overrides[key];
    if (raw === undefined || raw === null) continue;
    if (spec.kind === 'number') {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) continue;
      if (spec.min !== undefined && value < spec.min) continue;
      if (spec.max !== undefined && value > spec.max) continue;
      out[key] = value;
      continue;
    }
    if (spec.kind === 'mode') {
      const value = String(raw).trim().toLowerCase();
      if (RECALL_MODES.includes(value)) out[key] = value;
    }
  }
  return out;
}

/** @returns {RecallPolicy} */
export function resolvePolicy(overrides = {}) {
  const base = {
    // `::Truncate` — the final-score floor. 0 is the cross-encoder's own decision
    // boundary (relevant pairs score positive), and it was measured to keep 8 of
    // 8 answerable queries while rejecting 6 of 8 unanswerable ones — on the model
    // and prompts of that measurement, which is not necessarily the one you ship.
    // Re-measured on 2026-10-08 (31 answerable + 13 unanswerable, EmbeddingGemma 2,
    // 800-character clipping): 0 keeps all 13 negatives, while 3 keeps 2/13 and
    // still keeps every answerable query. scripts/margin-gate-eval.mjs prints both
    // sweeps; use it rather than these numbers.
    gate: numberEnv('DSH_G_MEMORY_GATE', 0),
    // Time-scale tiers, **off by default**, and the first version of this file
    // got it wrong in a way worth recording. VCP's recent tier (OneRing) is a
    // separate, small layer — the last few cross-window messages — which is why
    // it can be ungated. Applying the same exemption by *age* over one 13k-unit
    // index exempts almost everything, because an active corpus has most of its
    // units inside the last two days. Measured with `recentDays: 2`, the gate let
    // 8 of 8 unanswerable queries through — the exact failure it was added to
    // prevent. A deployment that mounts a genuinely small recent layer should
    // raise this; the default must not assume one exists.
    recentDays: numberEnv('DSH_G_MEMORY_RECENT_DAYS', 0, { min: 0 }),
    recentGate: numberEnv('DSH_G_MEMORY_RECENT_GATE', Number.NEGATIVE_INFINITY),
    midDays: numberEnv('DSH_G_MEMORY_MID_DAYS', 7, { min: 0 }),
    midGate: numberEnv('DSH_G_MEMORY_MID_GATE', -1),
    // `::TimeDecay` — VCP: suits "近期状态更重要" memory, and should NOT be applied
    // indiscriminately. Off by default for that reason.
    decayDays: numberEnv('DSH_G_MEMORY_DECAY_DAYS', 0, { min: 0 }),
    decayFactor: numberEnv('DSH_G_MEMORY_DECAY_FACTOR', 0.5, { min: 0, max: 1 }),
    // Dynamic K: a multiplier on the requested count, not a fixed number.
    kMultiplier: numberEnv('DSH_G_MEMORY_K_MULTIPLIER', 1, { min: 0.1, max: 10 }),
    // Two-tier payload. A candidate that only just cleared the gate is worth a
    // signal, not 400 characters of context it has to compete for.
    briefScore: numberEnv('DSH_G_MEMORY_BRIEF_SCORE', 2),
    briefChars: numberEnv('DSH_G_MEMORY_BRIEF_CHARS', 200, { min: 40 }),
    fullChars: numberEnv('DSH_G_MEMORY_FULL_CHARS', 400, { min: 40 }),
    maxEntries: numberEnv('DSH_G_MEMORY_MAX_ENTRIES', 3, { min: 1, max: 10 }),
    // 2400, not 1200: `renderRecall` spends 792 characters on the untrusted-notice
    // frame before the first entry, so a 1200 budget leaves 408 — less than one full
    // entry (a 400-character slice plus a ~60-character provenance prefix). Measured
    // 2026-11-11 on 22 labelled cases: 1200 injected 7/22 and covered 4/22; 2400
    // injected 22/22 and covered 12/22. The two numbers must agree with
    // INJECTION_LIMITS.maxTotalChars in lib/inject.mjs, or this one selects entries
    // the renderer then throws away.
    maxTotalChars: numberEnv('DSH_G_MEMORY_MAX_TOTAL_CHARS', 2400, { min: INJECTION_MIN_TOTAL_CHARS }),
    // Head-margin floor for the automatic path. 0 = off.
    //
    // The per-candidate floor asks "is this one relevant?". An unanswerable query
    // can still put something above it, because a cross-encoder scores the best
    // of a bad set positively. **Re-measure this for the deployment you ship**: on
    // 2026-10-08 the same corpus produced AUC 0.347 (clean negatives, one run) and
    // AUC 0.000 (the next run, same settings) for this statistic — a difference of
    // noisy score gaps, not of retrieval. The absolute floor (`gate`) separated
    // the same classes at AUC 0.988-1.000 and is what the local deployment uses.
    // The margin asks the question the floor cannot:
    // "is the winner actually separated from the rest?" — for an unanswerable
    // query the top few scores are indistinguishable.
    //
    // Measured on the deployment's corpus (134 answerable, 8 unanswerable, scores
    // from bge-reranker-v2-m3, margin = score[0] − score[2] after reranking):
    // AUC 0.786, median margin 2.80 answerable against 0.83 unanswerable. At
    // 1.18 the negatives admitted fall 8/8 → 2/8, and the price is explicit in
    // that same measurement: **24% of answerable turns would lose their memory**.
    // That is the trade this plugin says it prefers ("err toward missing a memory
    // rather than inventing one"), but 8 negatives is a thin basis for a
    // threshold, so it is off by default and enabled per deployment.
    marginGate: numberEnv('DSH_G_MEMORY_MARGIN_GATE', 0, { min: 0 }),
    // Cards, on the path where the gate has no scale to read them on.
    //
    // A card enters the pool with `score: 0` — it is not an RRF hit — so every
    // floor above rejects it. The 0.35 cosine pre-filter that used to stand in was
    // re-measured on 2026-10-24 and is nearly always true in the current embedding
    // space (EmbeddingGemma 2): 8 of 8 random tokens cleared it, and the cosine
    // lower bound over the corpus is about 0.58, so it admitted a card for queries
    // that have none. The replacement is relative, not absolute: a card must clear
    // 0.68 *and* lead the next card by `cardMargin`, and at most one card is
    // admitted, marked unverified. scripts/eval-card-gate.mjs prints the pass rates
    // behind these two numbers; use it rather than these numbers when the
    // embedding model or the card store changes.
    cardMinSimilarity: numberEnv('DSH_G_MEMORY_CARD_MIN_SIMILARITY', 0.68, { min: 0, max: 1 }),
    cardMargin: numberEnv('DSH_G_MEMORY_CARD_MARGIN', 0.02, { min: 0, max: 1 }),
    // Text quality. The score gate answers "is this relevant", and a JSON tool-call
    // fragment, a bare path or a log dump can be relevant and still not be a memory.
    // Measured on 425 injected blocks: 23-27% of entries were under 80 characters.
    // 60 is the point below which an entry is a fragment; an entry above
    // `maxEntryChars` is dropped whole rather than clipped, because a memory cut
    // mid-sentence is read as complete and that is the failure this plugin ranks
    // worst. See lib/quality.mjs.
    minContentChars: numberEnv('DSH_G_MEMORY_MIN_CONTENT_CHARS', 60, { min: 0 }),
    maxEntryChars: numberEnv('DSH_G_MEMORY_MAX_ENTRY_CHARS', 1200, { min: 100 }),
    // Synthesis is for answers that must be assembled, not for answers that are
    // already sitting in one entry. Measured on 134 labelled cases: the label was
    // present in the injected set for 111 of them, and in **the top entry alone for
    // 103 of those 111 (92.8%)** — a paraphrase could only lose detail there. The
    // margin separates the two groups (p50 1.26 when one entry suffices, 0.30 when
    // several must be combined), and 0.2 is the value that classifies best (82%).
    //
    // The threshold is biased towards *not* synthesising on purpose: a needless
    // synthesis replaces verbatim text with a 2B model's prose, while a skipped one
    // still delivers every entry for the caller to combine.
    synthesisMargin: numberEnv('DSH_G_MEMORY_SYNTHESIS_MARGIN', 0.2, { min: 0 }),
    mode: (process.env.DSH_G_MEMORY_RECALL_MODE || 'hybrid').trim().toLowerCase(),
  };
  return applyOverrides(base, overrides);
}

/** Whether the automatic path may inject at all, by mode. */
export function autoInjectEnabled(policy, injectionEnabled) {
  if (!injectionEnabled) return false;
  if (policy.mode === 'tools') return false;
  return policy.mode === 'context' || policy.mode === 'hybrid';
}

/**
 * The score floor that applies to a candidate of a given age.
 *
 * @param {number} ageDays
 * @param {RecallPolicy} policy
 * @returns {number}
 */
export function floorForAge(ageDays, policy) {
  if (ageDays <= policy.recentDays) return policy.recentGate;
  if (ageDays <= policy.midDays) return policy.midGate;
  return policy.gate;
}

/**
 * Select what to inject, and how much of each, from reranked candidates.
 *
 * Every entry is expected to carry `score` on the cross-encoder's scale and
 * `time` in epoch milliseconds — the same pair the tool path uses, so the two
 * paths cannot disagree about what counts as a memory.
 *
 * @param {Array<{ text?: string, role?: string, score?: number, time?: number, [k: string]: unknown }>} entries
 * @param {{ policy?: Partial<RecallPolicy>, limit?: number, now?: number, reranked?: boolean }} [options]
 *   `reranked: false` means the scores are fused RRF, not cross-encoder logits —
 *   the one case where a card is judged by its own similarity instead.
 * @returns {{ selected: Array<Record<string, unknown>>, dropped: number, reason?: string, tier: string }}
 */
/**
 * Whether a recall needs a model to write the answer, or the entries already are it.
 *
 * Returns false for a single entry (nothing to assemble) and for a clear leader
 * among several. See `synthesisMargin` for the measurement behind the threshold.
 *
 * @param {{ score?: number }[]} entries already gated and ordered
 * @param {RecallPolicy} [policy]
 * @returns {boolean}
 */
export function needsSynthesis(entries, policy = resolvePolicy()) {
  if (policy.synthesisMargin <= 0) return false;
  if (!Array.isArray(entries) || entries.length < 2) return false;
  const scores = entries.map((e) => Number(e.score ?? 0)).sort((a, b) => b - a);
  return scores[0] - scores[1] < policy.synthesisMargin;
}

export function selectByPolicy(entries, options = {}) {
  const policy = resolvePolicy(options.policy);
  const now = options.now ?? Date.now();
  const limit = Math.min(options.limit ?? policy.maxEntries, policy.maxEntries);

  /** @type {Record<string, number>} */
  const droppedReasons = {};
  const reject = (why) => { droppedReasons[why] = (droppedReasons[why] ?? 0) + 1; };
  const summarise = () => Object.entries(droppedReasons).map(([key, n]) => `${key}×${n}`).join(', ');

  // Content first, on every path. A score answers "is this relevant"; it cannot
  // answer "is this a memory". The fragments that made up 23-27% of injected entries
  // were all *relevant* — they were a path, a tool call, a log line. See
  // lib/quality.mjs for the shapes rejected and why the order is what it is.
  //
  // The whole entry goes in, not just its text: `role` decides whether the length
  // rule applies at all (a user message is context, not an answer) and the other
  // shape rules read nothing from it.
  const usable = [];
  for (const entry of entries) {
    const why = contentRejectReason(entry, {
      minContentChars: policy.minContentChars,
      maxEntryChars: policy.maxEntryChars,
    });
    if (why) reject(why);
    else usable.push(entry);
  }

  // Degraded path: a card is not an RRF hit, so its score is 0 and every floor above
  // rejects it. The old answer was to exempt it from the floor on a 0.35 similarity
  // pre-filter, which measured nearly vacuous. The answer now is relative: at most
  // one card, above 0.68, and clearly ahead of the next card — marked unverified,
  // because nothing on this path compared it with the question.
  let pickedCards = [];
  const pool = [];
  const cardPool = [];
  for (const entry of usable) {
    if (options.reranked === false && entry.source === 'card') cardPool.push(entry);
    else pool.push(entry);
  }
  if (cardPool.length > 0) {
    const pick = pickDegradedCards(cardPool, {
      cardMinSimilarity: policy.cardMinSimilarity,
      cardMargin: policy.cardMargin,
    });
    pickedCards = pick.entries;
    if (pickedCards.length === 0) {
      // Which rule rejected them is what an operator would change: the floor is a
      // calibration, the margin is an unrelated query whose top cards are
      // interchangeable. `pick.reason` carries the numbers.
      const best = cardPool.reduce((max, entry) => Math.max(max, Number(entry.similarity ?? 0)), Number.NEGATIVE_INFINITY);
      const why = best < policy.cardMinSimilarity ? 'card-low-similarity' : 'card-margin';
      for (let i = 0; i < cardPool.length; i += 1) reject(why);
    } else {
      for (let i = 0; i < pick.dropped; i += 1) reject('card-not-top1');
    }
  }

  const scored = pool.map((entry) => {
    const time = Number(entry.time) || 0;
    const ageDays = time > 0 ? Math.max(0, (now - time) / 86_400_000) : Infinity;
    let score = Number(entry.score ?? 0);
    if (policy.decayDays > 0 && Number.isFinite(ageDays)) {
      const periods = Math.floor(ageDays / policy.decayDays);
      score *= policy.decayFactor ** periods;
    }
    return { entry, score, ageDays };
  });

  const eligible = scored.filter(({ score, ageDays }) => score >= floorForAge(ageDays, policy));

  // Head-margin gate. It runs before the floors, on the ranking as handed over,
  // because it is a property of the ranking rather than of eligibility.
  //
  // Skipped when fewer than three candidates were scored: the margin is then
  // undefined rather than small, and a two-candidate pool means retrieval already
  // narrowed hard — dropping it would lose an exact match to a rule that has
  // nothing to say about it.
  if (policy.marginGate > 0 && scored.length >= 3) {
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    const margin = ranked[0].score - ranked[2].score;
    if (margin < policy.marginGate) {
      return {
        selected: [],
        dropped: entries.length,
        droppedReasons,
        tier: tierOf(ranked[0].ageDays, policy),
        reason: `head margin ${margin.toFixed(2)} is below ${policy.marginGate}: the top candidates are indistinguishable, which is what an unanswerable query looks like`,
      };
    }
  }

  if (eligible.length === 0 && pickedCards.length === 0) {
    // Which gate emptied the pool is the one number an operator should look at.
    // The floor was blamed unconditionally, so a pool the content filter had
    // emptied was logged as "no entry cleared its age tier's floor" — 23 recorded
    // turns pointed the reader at a threshold that was never consulted. When the
    // content filter is the cause it is named first; when every drop was a score or
    // card decision the floor is still the cause and keeps the old wording. The
    // floor value is in both forms because existing greps read it, and the return
    // shape is unchanged.
    const rejections = Object.entries(droppedReasons);
    const summary = summarise();
    const contentDropped = rejections
      .filter(([why]) => CONTENT_REJECTIONS.has(why))
      .reduce((total, [, count]) => total + count, 0);
    const reason = contentDropped > 0
      ? `content filter dropped ${contentDropped} candidate(s) (${summary}): nothing left cleared the floor (long-term floor ${policy.gate})`
      : `no entry cleared its age tier's floor (long-term floor ${policy.gate})`
        + (rejections.length > 0 ? ` (dropped ${summary})` : '');
    return {
      selected: [],
      dropped: entries.length,
      droppedReasons,
      tier: scored.length > 0 ? tierOf(scored[0].ageDays, policy) : 'none',
      reason,
    };
  }

  eligible.sort((a, b) => b.score - a.score);

  const selected = [];
  let total = 0;
  const push = (entry, score) => {
    // Two-tier sizing: a marginal candidate gets a signal, not a full preview. When
    // sizing actually cuts the entry it is marked, so the renderer can say so: an
    // unmarked half-sentence reads as complete, which is the defect this pair of
    // functions exists to stop.
    const cap = score >= policy.briefScore ? policy.fullChars : policy.briefChars;
    const whole = String(entry.text ?? '');
    const text = whole.slice(0, cap);
    if (total + text.length > policy.maxTotalChars) { reject('budget'); return; }
    if (text.length < whole.length) selected.push({ ...entry, score, text, truncated: true });
    else selected.push({ ...entry, score, text });
    total += text.length;
  };

  // Curated cards lead on the path with no reranker: a card's score is 0 there, so
  // sorting would put the most valuable entry last.
  for (const card of pickedCards) {
    if (selected.length >= limit) break;
    push(card, 0);
  }
  for (const { entry, score } of eligible) {
    if (selected.length >= limit) break;
    push(entry, score);
  }

  const firstTime = Number(selected[0]?.time) || 0;
  const tier = selected.length > 0
    ? tierOf(firstTime > 0 ? Math.max(0, (now - firstTime) / 86_400_000) : Infinity, policy)
    : (scored.length > 0 ? tierOf(scored[0].ageDays, policy) : 'none');

  return {
    selected,
    dropped: entries.length - selected.length,
    droppedReasons,
    tier,
  };
}

/** Human-readable tier name, for logs and the decision record. */
function tierOf(ageDays, policy) {
  if (ageDays <= policy.recentDays) return 'recent';
  if (ageDays <= policy.midDays) return 'mid';
  return 'long';
}
