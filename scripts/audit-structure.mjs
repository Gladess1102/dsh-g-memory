#!/usr/bin/env node
/**
 * A lightweight connectivity audit of the two durable layers: cards and units.
 *
 * The review's structural question was whether a retrieved item is connected to
 * anything — a card that shares a tag or a session with other cards is
 * corroborated by them, while a card nothing points at is a claim with no
 * neighbours. VCP's graph pass (its "Ω" idea) uses that connectivity as a
 * ranking bonus; before borrowing it, the corpus has to be measured: if the
 * graph is mostly isolated nodes, a connectivity bonus is noise with a formula.
 *
 * This is the cheap version, not a graph engine:
 *
 *   cards   tag co-occurrence (a shared tag joins two cards) and same-session
 *           grouping; isolated cards have neither. Also, how many card sources
 *           still resolve to a session in the index — an unresolvable source is
 *           the `orphaned` case the injection layer can only label, not verify.
 *   units   sessions represented and their size distribution, so the per-session
 *           neighbourhood a card would be joined to is visible.
 *
 * Read-only: it opens the card store and the index, writes nothing.
 *
 *   node scripts/audit-structure.mjs
 *   node scripts/audit-structure.mjs --json
 *   node scripts/audit-structure.mjs --no-index          # cards only
 *   node scripts/audit-structure.mjs --gate-orphan 0.2   # fail above 20% orphaned
 *
 * SPDX-License-Identifier: MIT
 */

import { readCards, defaultCardPath } from '../lib/cards.mjs';
import { readIndex, defaultIndexDir } from '../lib/store.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};
const asJson = argv.includes('--json');
const withIndex = !argv.includes('--no-index');
const top = Math.max(1, Math.min(50, Number(valueOf('--top', '10'))));
const orphanGate = argv.includes('--gate-orphan') ? Number(valueOf('--gate-orphan', '0.2')) : null;
const cardsPath = valueOf('--cards', defaultCardPath());
const indexDir = valueOf('--index', defaultIndexDir());

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Session identifiers arrive in three shapes: a bare UUID, `session-<uuid>`, and
 * a full log path that contains the UUID. A card written from a note carries a
 * `note/...` key instead; it is not a session and cannot be verified against
 * the index, which is reported separately rather than as a broken reference.
 */
function normalizeSession(value) {
  const text = String(value || '').trim();
  const match = UUID.exec(text);
  if (match) return match[0].toLowerCase();
  return text.replace(/^session-/, '').toLowerCase();
}

const cards = await readCards(cardsPath).catch((error) => {
  console.error('audit-structure: cannot read the card store at ' + cardsPath + ': ' + (error?.message || error));
  process.exit(2);
});

const active = cards.filter((card) => !card.supersededBy && card.status !== 'superseded' && card.status !== 'retired');
const sessions = cards.map((card) => normalizeSession(card.session)).filter(Boolean);
const bySession = new Map();
for (const session of sessions) bySession.set(session, (bySession.get(session) || 0) + 1);
const tagCounts = new Map();
const cardTags = cards.map((card) => {
  const tags = (card.tags || []).map((tag) => String(tag).trim()).filter(Boolean);
  for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  return tags;
});

/** Union-find over cards, joined by a shared tag. */
const parent = cards.map((_, i) => i);
const find = (i) => {
  let root = i;
  while (parent[root] !== root) { parent[root] = parent[parent[root]]; root = parent[root]; }
  return root;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[rb] = ra;
};
const firstCardWithTag = new Map();
cardTags.forEach((tags, index) => {
  for (const tag of tags) {
    if (firstCardWithTag.has(tag)) union(firstCardWithTag.get(tag), index);
    else firstCardWithTag.set(tag, index);
  }
});
const components = new Map();
for (let i = 0; i < cards.length; i += 1) {
  const root = find(i);
  components.set(root, (components.get(root) || 0) + 1);
}
const componentSizes = [...components.values()].sort((a, b) => b - a);

// A card is isolated when it has no tag AND no same-session sibling: nothing in
// the curated layer can corroborate it, and nothing else will be retrieved with it.
const isolated = [];
for (let i = 0; i < cards.length; i += 1) {
  const session = normalizeSession(cards[i].session);
  const needsSession = !session || (bySession.get(session) || 0) <= 1;
  if (cardTags[i].length === 0 && needsSession) isolated.push(cards[i]);
}

let indexStats = null;
let filterable = cards;
let orphaned = [];
if (withIndex) {
  const index = await readIndex(indexDir).catch((error) => {
    console.error('audit-structure: cannot read the index at ' + indexDir + ': ' + (error?.message || error));
    process.exit(2);
  });
  const units = index.data.units;
  const unitSessions = new Map();
  for (const unit of units) {
    const session = normalizeSession(unit?.session);
    if (!session) continue;
    unitSessions.set(session, (unitSessions.get(session) || 0) + 1);
  }
  const sizes = [...unitSessions.values()].filter((value) => value > 0).sort((a, b) => a - b);
  const q = (p) => (sizes.length > 0 ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : null);
  orphaned = cards.filter((card) => {
    const session = normalizeSession(card.session);
    if (session.startsWith('note/')) return false; // not a session; not verifiable, not broken
    return !unitSessions.has(session);
  });
  indexStats = {
    units: units.length,
    sessions: unitSessions.size,
    unitsPerSession: { p50: q(0.5), p90: q(0.9), max: sizes.length > 0 ? sizes[sizes.length - 1] : null },
  };
}

const pct = (part, total) => (total > 0 ? Number((part / total).toFixed(4)) : null);
const result = {
  cardsPath,
  cards: {
    total: cards.length,
    active: active.length,
    tagged: cards.filter((_, i) => cardTags[i].length > 0).length,
    untagged: cards.filter((_, i) => cardTags[i].length === 0).length,
    sessions: bySession.size,
    tags: tagCounts.size,
    tagsPerCard: cards.length > 0 ? Number((cardTags.reduce((sum, tags) => sum + tags.length, 0) / cards.length).toFixed(2)) : null,
    largestSession: bySession.size > 0 ? Math.max(...bySession.values()) : null,
  },
  graph: {
    components: componentSizes.length,
    largestComponent: componentSizes[0] ?? 0,
    largestComponentShare: pct(componentSizes[0] ?? 0, cards.length),
    isolated: isolated.length,
    isolatedShare: pct(isolated.length, cards.length),
    topTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([tag, count]) => ({ tag, count })),
  },
  index: indexStats,
  orphaned: withIndex ? {
    count: orphaned.length,
    share: pct(orphaned.length, cards.length),
    samples: orphaned.slice(0, top).map((card) => ({ id: String(card.id || '').slice(0, 8), session: String(card.session || '').slice(-60), summary: String(card.summary || '').slice(0, 60) })),
  } : null,
  isolatedSamples: isolated.slice(0, top).map((card) => ({ id: String(card.id || '').slice(0, 8), tags: (card.tags || []).length, summary: String(card.summary || '').slice(0, 70) })),
};
result.gatePassed = orphanGate === null ? null : (result.orphaned?.share ?? 0) <= orphanGate;

if (asJson) {
  console.log(JSON.stringify(result, null, 1));
} else {
  const p = (value) => (value === null || value === undefined ? 'n/a' : (value * 100).toFixed(1) + '%');
  console.log('cards       ' + cards.length + ' (' + active.length + ' active, ' + result.cards.tagged + ' tagged, '
    + result.cards.tags + ' tags, ' + result.cards.sessions + ' session(s))');
  console.log('  tags/card ' + (result.cards.tagsPerCard ?? 'n/a') + ', largest session ' + (result.cards.largestSession ?? 'n/a'));
  console.log('  graph     ' + result.graph.components + ' component(s), largest ' + result.graph.largestComponent
    + ' (' + p(result.graph.largestComponentShare) + '); isolated ' + isolated.length + ' (' + p(result.graph.isolatedShare) + ')');
  if (result.graph.topTags.length > 0) {
    console.log('  top tags  ' + result.graph.topTags.slice(0, 8).map((entry) => entry.tag + '×' + entry.count).join(', '));
  }
  if (indexStats) {
    console.log('index       ' + indexStats.units + ' units in ' + indexStats.sessions + ' session(s); '
      + 'units/session p50 ' + indexStats.unitsPerSession.p50 + ', p90 ' + indexStats.unitsPerSession.p90
      + ', max ' + indexStats.unitsPerSession.max);
    console.log('  card sources still in the index: ' + (cards.length - orphaned.length) + '/' + cards.length
      + ' (' + p(1 - (result.orphaned?.share ?? 0)) + '); orphaned ' + orphaned.length);
  }
  if (isolated.length > 0) {
    console.log('');
    console.log('isolated cards (no tag, no same-session sibling — nothing corroborates them):');
    for (const card of result.isolatedSamples) console.log('  ' + card.id + '  ' + card.summary);
  }
  if (orphaned.length > 0) {
    console.log('');
    console.log('orphaned card sources (session no longer in the index; the injection layer can only label these):');
    for (const card of result.orphaned.samples) console.log('  ' + card.id + '  ' + card.session);
  }
  if (orphanGate !== null) {
    console.log('');
    console.log(result.gatePassed
      ? 'structure gate: pass (orphaned ' + p(result.orphaned?.share ?? 0) + ' <= ' + p(orphanGate) + ')'
      : 'structure gate: FAIL (orphaned ' + p(result.orphaned?.share ?? 0) + ' > ' + p(orphanGate) + ')');
  }
}

process.exit(orphanGate !== null && !result.gatePassed ? 1 : 0);
