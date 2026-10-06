/**
 * Card lifecycle: what happens to a memory after it is written.
 *
 * The first version of this plugin only ever *added* cards. Nothing superseded an
 * old fact when a new one replaced it, nothing expired, nothing could be
 * forgotten — so a memory that had been corrected was still retrieved with the
 * same confidence as the correction, and "the embedding is 1024-dim" from three
 * weeks ago sat in the index beside "the embedding is 768-dim" from today. A
 * memory system that cannot revise itself degrades in proportion to how much it
 * remembers.
 *
 * The state is *derived*, not stored, wherever it can be:
 *
 *   active       status absent (or 'active'), and not past `expires`
 *   expired      `expires` has passed — a date is the truth, so no job has to run
 *   superseded   a later card replaced it (`supersededBy` names the successor)
 *   retired      withdrawn by hand, e.g. `memory_forget`; kept as evidence
 *
 * Every function here is pure: it takes cards and returns new cards. Persisting is
 * the caller's business, which keeps the rules testable without touching a disk —
 * and they are the rules most likely to be wrong.
 */

import { int8Similarity, unpackVector } from './vector.mjs';

/**
 * Which of the four states a card is in right now.
 *
 * An explicit `retired` or `superseded` outranks expiry: a card that was withdrawn
 * *and* has lapsed is still withdrawn, and reporting it as expired would lose the
 * reason it is gone.
 *
 * @param {object} card
 * @param {number} [now]
 * @returns {'active'|'expired'|'superseded'|'retired'}
 */
export function cardState(card, now = Date.now()) {
  const status = typeof card?.status === 'string' ? card.status : '';
  if (status === 'retired') return 'retired';
  if (status === 'superseded') return 'superseded';
  const expires = Number(card?.expires);
  if (Number.isFinite(expires) && expires > 0 && expires <= now) return 'expired';
  return 'active';
}

/** True when a card may be injected without a caveat. @param {object} card */
export function isLive(card, now = Date.now()) {
  return cardState(card, now) === 'active';
}

/**
 * A short suffix for one-line views, empty for a live card.
 *
 * `formatCard` is what a human reads, and a superseded memory that looks like any
 * other is worse than no memory at all — so the state has to survive into the
 * human-facing text, not just into the store.
 *
 * @param {object} card
 * @param {number} [now]
 */
export function stateNote(card, now = Date.now()) {
  switch (cardState(card, now)) {
    case 'superseded': {
      const by = typeof card.supersededBy === 'string' && card.supersededBy !== ''
        ? ` → ${card.supersededBy.slice(0, 8)}`
        : '';
      return `⛔superseded${by}`;
    }
    case 'expired': return '⌛expired';
    case 'retired': return '✂retired';
    default: return '';
  }
}

/**
 * Find one card by id, id prefix, or a distinctive fragment of its summary.
 *
 * Ambiguity is reported rather than resolved by guessing: retiring the wrong memory
 * is silent and unrecoverable in a way that failing to retire one is not.
 *
 * @param {object[]} cards
 * @param {string} ref
 * @returns {{ card: object, how: string } | { ambiguous: object[] } | { missing: true }}
 */
export function resolveRef(cards, ref) {
  const needle = String(ref ?? '').trim();
  if (needle === '') return { missing: true };

  const exact = cards.find((card) => card.id === needle);
  if (exact) return { card: exact, how: 'id' };

  // An id prefix is the ergonomic form: nobody reads a 20-character hex string.
  if (/^[0-9a-f]{6,}$/i.test(needle)) {
    const matches = cards.filter((card) => String(card.id).startsWith(needle.toLowerCase()));
    if (matches.length === 1) return { card: matches[0], how: 'id-prefix' };
    if (matches.length > 1) return { ambiguous: matches };
  }

  // A fragment is only useful as a reference when it is distinctive. Length is
  // counted with CJK characters weighted double: four Han characters name a subject
  // about as precisely as eight Latin ones, and this store is mostly Chinese, so a
  // flat character count rejected exactly the references people would type.
  const weight = [...needle].reduce((sum, ch) => sum + (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 2 : 1), 0);
  if (weight >= 8) {
    const lowered = needle.toLowerCase();
    const matches = cards.filter((card) => String(card.summary).toLowerCase().includes(lowered));
    if (matches.length === 1) return { card: matches[0], how: 'summary' };
    if (matches.length > 1) {
      // Prefer the most recent reading of the same text rather than refusing
      // outright: a rewritten card shares most of its wording with its ancestor.
      const sorted = [...matches].sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
      return { ambiguous: sorted };
    }
  }
  return { missing: true };
}

/** Mark one card as replaced by another. Returns a new list. */
export function supersede(cards, oldId, newId, now = Date.now()) {
  return cards.map((card) => (card.id === oldId
    ? { ...card, status: 'superseded', supersededBy: newId, governedAt: now }
    : card));
}

/** Mark one card as withdrawn, keeping it as evidence. Returns a new list. */
export function retire(cards, id, now = Date.now()) {
  return cards.map((card) => (card.id === id
    ? { ...card, status: 'retired', governedAt: now }
    : card));
}

/** Remove one card from the store entirely. Returns a new list. */
export function dropCard(cards, id) {
  return cards.filter((card) => card.id !== id);
}

/** Cards whose `expires` has passed — reported, never mutated. */
export function dueToExpire(cards, now = Date.now()) {
  return cards.filter((card) => cardState(card, now) === 'expired');
}

/** Live cards only, newest first — what should be retrievable without caveats. */
export function liveCards(cards, now = Date.now()) {
  return cards.filter((card) => isLive(card, now))
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
}

/**
 * Active cards that a new memory closely resembles.
 *
 * Used only to *suggest* that a new memory may replace an old one; the decision
 * stays with the writer. An automatic supersede would be unrecoverable and wrong
 * whenever two memories merely resemble each other.
 *
 * @param {object[]} cards
 * @param {Float32Array|number[]} queryVector  L2-normalised, same space as the store
 * @param {{ threshold?: number, limit?: number, now?: number }} [options]
 */
export function overlapSuggestions(cards, queryVector, options = {}) {
  const threshold = options.threshold ?? 0.86;
  const limit = options.limit ?? 3;
  const now = options.now ?? Date.now();
  const hits = [];
  for (const card of liveCards(cards, now)) {
    const encoded = typeof card.vector === 'string' ? card.vector : '';
    if (encoded === '') continue;
    let unpacked;
    try { unpacked = unpackVector(Buffer.from(encoded, 'base64')); } catch { continue; }
    if (unpacked.codes?.length !== queryVector.length) continue;
    const score = int8Similarity(queryVector, unpacked.codes, unpacked.scale);
    if (score >= threshold) hits.push({ card, similarity: score });
  }
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
