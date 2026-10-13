/**
 * Resident memory: the handful of cards a session starts with.
 *
 * Why this layer exists, after everything else was measured (see the attribution
 * report in local-keep):
 *
 *   - the cross-encoder says "not the answer" to every narrative memory
 *     (rerank top1 p50 0.020 over 80 real turns; the gate injected 0 of them);
 *   - the bi-encoder cannot separate the classes either (cosine top1 p50 0.800
 *     for turns that want memory, 0.825 for turns that do not);
 *   - raw n-gram tags are worse than useless (coverage p50 0.023 versus 0.042 --
 *     the turns that do NOT want memory score higher).
 *
 * Every one of those is a retrieval score trying to answer a question about
 * relevance. What is left, and what the industry actually ships (Anthropic's
 * memory tool checks its memory directory before starting a task; Letta has
 * memory blocks; OpenAI moved to background consolidation), is to stop asking
 * scores at session start and put a small, curated, human-readable set of
 * memories in front of the model.
 *
 * Cards are exactly that set: distilled summaries, each with tags, an embedding
 * and a governance state, written by the consolidation loop and editable by hand.
 *
 * The ranking is deliberately dominated by deterministic signals -- a path or
 * project name that appears in both the card and the opening message -- because
 * cosine is the one signal this deployment has already proven it cannot lean on.
 * Its weight is capped so it can never outrank an actual name match.
 *
 * SPDX-License-Identifier: MIT
 */

import { boolEnv, numberEnv } from './env.mjs';
import { cardState } from './governance.mjs';

/** @typedef {import('./cards.mjs').MemoryCard} MemoryCard */

/**
 * @param {Record<string, any>} [overrides]
 */
export function resolveResidentConfig(overrides = {}) {
  return {
    enabled: boolEnv('DSH_G_MEMORY_RESIDENT', false),
    /** Two cards is roughly 400-600 characters: a working set, not a library. */
    limit: numberEnv('DSH_G_MEMORY_RESIDENT_LIMIT', 2, { min: 1, max: 5 }),
    /** Below this a card has no deterministic reason to be here. */
    minScore: numberEnv('DSH_G_MEMORY_RESIDENT_MIN_SCORE', 0.5),
    /** Recency is only a tiebreaker; this is the window that counts as recent. */
    freshDays: numberEnv('DSH_G_MEMORY_RESIDENT_FRESH_DAYS', 7, { min: 0 }),
    ...overrides,
  };
}

/**
 * The words worth matching on: paths, identifiers, and CJK runs.
 *
 * Exported because the tests and the doctor have to agree with it about what
 * counts as a name; two implementations of "which words are names" would drift.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function nameTokens(text) {
  const out = new Set();
  const s = String(text == null ? '' : text);
  // Absolute and home-relative paths, plus their last segment.
  for (const m of s.matchAll(/(?:~|\/)[\w./\-]{3,}/g)) {
    const path = m[0].replace(/[.,;:)\]}"']+$/, '');
    out.add(path.toLowerCase());
    const leaf = path.split('/').filter(Boolean).pop();
    if (leaf && leaf.length >= 3) out.add(leaf.toLowerCase());
  }
  // Identifiers: dsh-g-memory, EmbeddingGemma, run_code, bge-reranker-v2-m3.
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:[.\-_][A-Za-z0-9_]+)+/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g)) out.add(m[0].toLowerCase());
  // CJK runs of 2-6, whole and as 2-grams: a query about 记忆系统 should match 记忆.
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
    const run = m[0];
    out.add(run);
    if (run.length > 3) for (let i = 0; i + 2 <= run.length; i += 2) out.add(run.slice(i, i + 2));
  }
  return out;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'the', 'and', 'for', 'not', 'you', 'are', 'when', 'what', 'how']);
const useful = (token) => token.length >= 2 && !STOP.has(token);

/**
 * Rank cards for the opening of a session.
 *
 * @param {MemoryCard[]} cards
 * @param {{ message?: string, cwd?: string, queryVector?: Float32Array|number[], now?: number, config?: object }} input
 * @returns {Array<{ card: MemoryCard, score: number, why: string[] }>}
 */
export function rankResidentCards(cards, input = {}) {
  const cfg = resolveResidentConfig(input.config || {});
  const now = input.now == null ? Date.now() : input.now;
  const messageTokens = new Set([...nameTokens(input.message)].filter(useful));
  const cwdTokens = new Set([...nameTokens(input.cwd)].filter(useful));
  const query = input.queryVector ? Array.from(input.queryVector) : null;

  const scored = [];
  for (const card of cards) {
    // Belt and braces on purpose: the state field is the contract, but a card
    // that names a successor is not current whatever its status says, and
    // injecting a withdrawn memory as fact is the worst failure this layer has.
    if (cardState(card, now) !== 'active' || card.supersededBy) continue;
    const why = [];
    let score = 0;

    const cardNames = nameTokens(String(card.summary == null ? '' : card.summary) + ' ' + (card.tags || []).join(' '));
    const cardLower = String(card.summary == null ? '' : card.summary).toLowerCase();

    // 1. A name from the opening message that the card also carries. This is the
    //    signal that actually means "this memory is about what we are doing".
    //
    //    Two-gram CJK splits are counted separately and weakly on purpose: the
    //    first version treated "今天天气" and the card's "天气" as a name match,
    //    which pulled an unrelated card about weather into a session about a
    //    memory plugin. A shared Chinese bigram is a hint, not an identity.
    let strongHits = 0;
    let weakHits = 0;
    for (const token of messageTokens) {
      if (!(cardNames.has(token) || cardLower.includes(token))) continue;
      if (token.length >= 3 || /[a-z0-9]/i.test(token)) strongHits += 1;
      else weakHits += 1;
    }
    if (strongHits > 0) { score += 3; why.push('name x' + strongHits); }
    if (weakHits > 0) { score += Math.min(1, weakHits * 0.3); why.push('term x' + weakHits); }

    // 2. The workspace. Weaker: a cwd match says "same project", not "this is
    //    what we are about to do".
    let cwdHits = 0;
    for (const token of cwdTokens) if (cardNames.has(token) || cardLower.includes(token)) cwdHits += 1;
    if (cwdHits > 0) { score += 1.5; why.push('cwd x' + cwdHits); }

    // 3. Cosine, capped. Proven unable to decide on its own; still worth a nudge
    //    when it agrees with everything else.
    if (query && typeof card.vector === 'string') {
      const packed = Buffer.from(card.vector, 'base64');
      if (packed.length >= 5 && packed.length - 4 === query.length) {
        const scale = packed.readFloatLE(0);
        let dot = 0;
        for (let i = 0; i < query.length; i += 1) dot += query[i] * (packed.readInt8(4 + i) * scale);
        if (dot >= 0.6) { score += Math.min(0.8, (dot - 0.6) * 2); why.push('cos ' + dot.toFixed(2)); }
      }
    }

    // 4. A card a human edited outranks a machine distillation of the same age.
    if (card.editedByHuman === true) { score += 0.5; why.push('human'); }

    // 5. Recency, as a tiebreaker only.
    const ageDays = card.time > 0 ? (now - card.time) / 86_400_000 : Infinity;
    if (ageDays <= cfg.freshDays) { score += 0.5; why.push('fresh'); }
    else if (ageDays <= 30) { score += 0.2; why.push('recent'); }

    if (score > 0) scored.push({ card, score: Number(score.toFixed(3)), why });
  }
  scored.sort((a, b) => b.score - a.score || (b.card.time || 0) - (a.card.time || 0));
  return scored;
}

/**
 * The cards a session should start with.
 *
 * @param {MemoryCard[]} cards
 * @param {{ message?: string, cwd?: string, queryVector?: Float32Array|number[], now?: number, config?: object }} input
 * @returns {Array<{ card: MemoryCard, score: number, why: string[] }>}
 */
export function selectResidentCards(cards, input = {}) {
  const cfg = resolveResidentConfig(input.config || {});
  if (!cfg.enabled) return [];
  return rankResidentCards(cards, input)
    // Recency alone is not a reason to put a memory in front of the model: a card
    // has to be *about* something in this session — a name it shares with the
    // opening message or with the workspace. Without that condition the freshest
    // card in the store rides along in every session, which is precisely the
    // confident irrelevance this layer exists to avoid. (The first version of
    // this filter let "fresh" clear a 0.5 floor on its own; the test caught it.)
    .filter((hit) => hit.score >= cfg.minScore
      && hit.why.some((reason) => reason.startsWith('name') || reason.startsWith('cwd')))
    .slice(0, cfg.limit);
}

/**
 * Cards as entries the shared renderer understands.
 *
 * role 'card' and the tags travel with them so the injected block labels them as
 * authored summaries rather than verbatim transcript -- the same distinction the
 * tool path draws, and the reason a card can be quoted where an excerpt cannot.
 *
 * @param {Array<{ card: MemoryCard }>} hits
 */
export function residentEntries(hits) {
  return hits.map(({ card }) => ({
    role: 'card',
    text: String(card.summary == null ? '' : card.summary),
    time: card.time,
    session: card.session,
    seq: null,
    score: 1,
    source: 'card',
    cardId: card.id,
    tags: card.tags || [],
    state: 'active',
  }));
}
