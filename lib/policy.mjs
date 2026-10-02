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

/** How the automatic path is allowed to reach the model at all. */
export const RECALL_MODES = ['context', 'tools', 'hybrid'];

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
    // 8 answerable queries while rejecting 6 of 8 unanswerable ones.
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
    maxTotalChars: numberEnv('DSH_G_MEMORY_MAX_TOTAL_CHARS', 1200, { min: INJECTION_MIN_TOTAL_CHARS }),
    // Head-margin floor for the automatic path. 0 = off.
    //
    // The per-candidate floor asks "is this one relevant?". An unanswerable query
    // can still put something above it, because a cross-encoder scores the best
    // of a bad set positively. The margin asks the question the floor cannot:
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
    // floor above rejects it. Measured on this deployment's 15 cards: the 0.35
    // cosine pre-filter that admits a card in the first place lets through 0 of 8
    // unanswerable queries (their best card scores 0.276) while covering 23% of
    // answerable ones. That is a stricter gate than the RRF floor it replaces, so
    // a card that cleared it is admitted even though its score cannot say so.
    cardMinSimilarity: numberEnv('DSH_G_MEMORY_CARD_MIN_SIMILARITY', 0.35, { min: 0, max: 1 }),
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
 * @param {Array<{ text?: string, score?: number, time?: number, [k: string]: unknown }>} entries
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

  const scored = entries.map((entry) => {
    const time = Number(entry.time) || 0;
    const ageDays = time > 0 ? Math.max(0, (now - time) / 86_400_000) : Infinity;
    let score = Number(entry.score ?? 0);
    if (policy.decayDays > 0 && Number.isFinite(ageDays)) {
      const periods = Math.floor(ageDays / policy.decayDays);
      score *= policy.decayFactor ** periods;
    }
    return { entry, score, ageDays };
  });

  /** Cards carry their cosine similarity; on the degraded path that is their gate. */
  const cardEligible = ({ entry }) => policy.cardMinSimilarity > 0
    && Number(entry.similarity ?? 0) >= policy.cardMinSimilarity;

  const eligible = scored.filter(({ entry, score, ageDays }) => (
    options.reranked === false && entry.source === 'card'
      ? cardEligible({ entry })
      : score >= floorForAge(ageDays, policy)
  ));

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
        tier: tierOf(ranked[0].ageDays, policy),
        reason: `head margin ${margin.toFixed(2)} is below ${policy.marginGate}: the top candidates are indistinguishable, which is what an unanswerable query looks like`,
      };
    }
  }

  if (eligible.length === 0) {
    return {
      selected: [],
      dropped: entries.length,
      tier: scored.length > 0 ? tierOf(scored[0].ageDays, policy) : 'none',
      reason: `no entry cleared its age tier's floor (long-term floor ${policy.gate})`,
    };
  }

  eligible.sort((a, b) => b.score - a.score);

  const selected = [];
  let total = 0;
  for (const { entry, score } of eligible) {
    if (selected.length >= limit) break;
    // Two-tier sizing: a marginal candidate gets a signal, not a full preview.
    const cap = score >= policy.briefScore ? policy.fullChars : policy.briefChars;
    const text = String(entry.text ?? '').slice(0, cap);
    if (total + text.length > policy.maxTotalChars) break;
    selected.push({ ...entry, score, text });
    total += text.length;
  }

  return {
    selected,
    dropped: entries.length - selected.length,
    tier: tierOf(eligible[0].ageDays, policy),
  };
}

/** Human-readable tier name, for logs and the decision record. */
function tierOf(ageDays, policy) {
  if (ageDays <= policy.recentDays) return 'recent';
  if (ageDays <= policy.midDays) return 'mid';
  return 'long';
}
