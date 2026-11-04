/**
 * The memory index layer: one line per durable memory, in the system prompt.
 *
 * Why this exists. Recall in this plugin is a *waterfall* event: a recall has to
 * be judged worth doing, retrieved, gated, and then injected before a step, so
 * "does the model know what it remembers" depends on four things going right on
 * that turn. dsh-auto-memory's author makes the opposite trade (2026-09-25, DSH
 * discussion 7790): the index of memory names rides the system prompt every
 * request, so the model opens every turn knowing what is there and the text is
 * fetched only when wanted. Measured on this deployment before this layer
 * existed: 65% of sessions (54 of 83) never injected a single memory, and the
 * resident card block covered at most two of 267 cards.
 *
 * What is here is that idea with this plugin's budgets: a bounded block of
 * one-line summaries (id, first line, age), rendered from the card store and
 * appended to the assembled system prompt. It is not full text - the body still
 * arrives through `memory_recall` - so the cost is a few hundred bytes per
 * request, paid whether or not anything is recalled.
 *
 * Two rules from the rest of the package carry over unchanged:
 *   - the block is a *map*, not an answer: it says "these memories exist", never
 *     that any of them apply to the current question;
 *   - it is untrusted background like every other memory surface, so it is
 *     framed as data and every summary is neutralised before it is written.
 *
 * SPDX-License-Identifier: MIT
 */

import { stat } from 'node:fs/promises';
import { readCards, defaultCardPath } from './cards.mjs';
import { boolEnv, numberEnv } from './env.mjs';
import { cardState, stateNote } from './governance.mjs';
import { neutralize } from './inject.mjs';

/** Hard caps on what the index layer may put in a prompt. */
export const INDEX_LAYER_LIMITS = {
  /**
   * Total characters for the rendered block, framing included.
   *
   * 1600 rather than 1200 as of 2026-11-03. The cost is measured, not guessed: the
   * block rides every system prompt, and an active day on this machine is 1,073
   * model steps (2026-11-03), so +400 characters is roughly 150 tokens per step —
   * about ¥1-2 a month at current prices, and zero bytes of storage. What it buys
   * is coverage: 13 entries become ~19 out of a 289-card store.
   */
  maxChars: 1_600,
  /** One line per card, newest first. */
  maxCards: 40,
  /** A summary is cut to this many characters for its line. */
  lineChars: 72,
  /**
   * A card with no reads and no updates for this long is left out of the index
   * (see `staleCard`). It stays recallable - this is a visibility rule, not a
   * deletion - so the cost of getting it wrong is a memory that has to be asked
   * for by name.
   */
  staleAfterDays: 90,
};

/**
 * Is this card too old and too unread to spend a line on?
 *
 * The signal is deliberately weak: `readCount` only advances when a memory is
 * actually injected, so "unread" means "never reached a model", not "not useful".
 * That is why the window is three months and why the card is hidden rather than
 * removed - dsh-auto-memory uses the same shape (`staleAfterDays` soft-hides
 * zero-read memories) and the same justification: a store that never forgets
 * degrades in proportion to how much it remembers.
 *
 * @param {object} card
 * @param {{ now?: number, staleAfterDays?: number }} [options]
 * @returns {boolean}
 */
export function staleCard(card, options = {}) {
  const days = Number(options.staleAfterDays ?? INDEX_LAYER_LIMITS.staleAfterDays);
  if (!(days > 0)) return false;
  const reads = Number(card?.readCount ?? 0);
  if (reads > 0) return false;
  const touched = Number(card?.lastReadAt ?? 0) || Number(card?.time ?? card?.createdAt ?? 0);
  if (!(touched > 0)) return false;
  return (options.now ?? Date.now()) - touched > days * 86_400_000;
}

/** One line of the index: id prefix, a summary cut to fit, and an age. */
function indexLine(card, options = {}) {
  const limit = Number(options.lineChars ?? INDEX_LAYER_LIMITS.lineChars);
  // Six hex characters: still unique in a 288-card store (collision odds ~1 in
  // 10^6 by birthday bound) and two characters cheaper on every line. The
  // index is a map, not an addressing scheme — a prefix that narrows it down is
  // enough, because `memory_recall` takes the question, not the id.
  const id = String(card?.id ?? '').slice(0, 6);
  // Escaped, not merely neutralised: a summary is user content, and `<` in it
  // could otherwise forge or close a wrapper tag the model is reading. This is
  // the same rule inject.mjs applies to recalled text (DSH's own
  // `<referenced-sessions>` block uses it too).
  const summary = neutralize(String(card?.summary ?? '').replace(/\s+/g, ' ').trim()).replaceAll('<', '\\u003c');
  if (summary.length === 0) return '';
  const cut = summary.length > limit ? summary.slice(0, limit).replace(/[，。；、,;:\s]+$/, '') + '…' : summary;
  // No date on the line. It was measured on this deployment 2026-11-03: the
  // month tail cost 10 characters of a 94-character line for information the
  // summary almost always carries itself ("2026-11-02 大图作业 …"), and the
  // budget is what decides how many memories the index can name at all.
  const note = stateNote(card, options.now ?? Date.now());
  return '- ' + id + ' ' + cut + (note ? ' ' + note : '');
}

/**
 * Render the block text for a set of cards.
 *
 * Returns `''` when nothing passes the filters, and the caller then adds no
 * section at all - an empty "memory index" heading is worse than no heading,
 * because it claims the store is empty rather than that it was not consulted.
 *
 * @param {object[]} cards
 * @param {{ maxChars?: number, maxCards?: number, lineChars?: number, staleAfterDays?: number, now?: number }} [options]
 * @returns {{ text: string, shown: number, hidden: number, chars: number }}
 */
export function renderIndexBlock(cards, options = {}) {
  const now = options.now ?? Date.now();
  const maxChars = Number(options.maxChars ?? INDEX_LAYER_LIMITS.maxChars);
  const maxCards = Number(options.maxCards ?? INDEX_LAYER_LIMITS.maxCards);
  const lines = [];
  let hidden = 0;
  // Most recently *touched* first, where "touched" is the later of "written" and
  // "read". Newest-first alone was measured 2026-11-03: all nine visible entries
  // came from the same two projects and four of them were near-duplicates, while
  // the store's most-read card (7 reads) never appeared at all because it was old.
  // An index that only shows yesterday's work is a changelog, not a map.
  const touchedAt = (card) => Math.max(Number(card?.time) || 0, Number(card?.lastReadAt) || 0);
  const ordered = [...cards].sort((a, b) => touchedAt(b) - touchedAt(a));
  for (const card of ordered) {
    if (lines.length >= maxCards) break;
    if (cardState(card, now) !== 'active') continue;
    if (staleCard(card, { now, staleAfterDays: options.staleAfterDays })) { hidden += 1; continue; }
    const line = indexLine(card, { lineChars: options.lineChars ?? INDEX_LAYER_LIMITS.lineChars, now });
    if (line === '') continue;
    lines.push(line);
  }
  if (lines.length === 0) return { text: '', shown: 0, hidden, chars: 0 };

  // The header is 88 characters, down from 221. It said the same thing three
  // times over (what this is, that it is untrusted, how to read the full text);
  // on a 1200-character budget that prose was costing three memories.
  const header = 'Memory index (titles only, untrusted; call memory_recall to read one):';
  // The footer is the one line that says the index is *incomplete*, which is the
  // difference between "you have nine memories" and "you have nine of 288". It
  // used to be computed for the budget and then dropped from the output — the
  // cap reserved its characters and nothing was written there.
  // The cap is applied while building: a block that ends mid-line would read as
  // a truncated fact, which is the failure this module exists to avoid.
  //
  // The footer is budgeted by its worst case before the body is known, then
  // written with the real count. Reserving the *rendered* footer is what made an
  // earlier version claim "40 shown" while 13 lines were visible: it counted the
  // candidates it had collected, not the ones that fit.
  const FOOTER_RESERVE = 48;
  let body = '';
  let shown = 0;
  for (const line of lines) {
    const next = body === '' ? line : body + '\n' + line;
    const projected = header.length + 1 + next.length + 1 + FOOTER_RESERVE;
    if (projected > maxChars && shown > 0) break;
    body = next;
    shown += 1;
  }
  const footer = '(' + shown + ' shown; ' + ordered.length + ' total, the rest by asking.)';
  const text = header + '\n' + body + '\n' + footer;
  return { text, shown, hidden, chars: text.length };
}

/** Defaults, read at call time so an environment set after import still counts. */
export function defaultIndexLayerConfig() {
  return {
    enabled: boolEnv('DSH_G_MEMORY_INDEX_LAYER', true),
    maxChars: numberEnv('DSH_G_MEMORY_INDEX_LAYER_MAX_CHARS', INDEX_LAYER_LIMITS.maxChars, { min: 200 }),
    maxCards: numberEnv('DSH_G_MEMORY_INDEX_LAYER_MAX_CARDS', INDEX_LAYER_LIMITS.maxCards, { min: 1, max: 400 }),
    lineChars: numberEnv('DSH_G_MEMORY_INDEX_LAYER_LINE_CHARS', INDEX_LAYER_LIMITS.lineChars, { min: 20, max: 240 }),
    staleAfterDays: numberEnv('DSH_G_MEMORY_INDEX_LAYER_STALE_DAYS', INDEX_LAYER_LIMITS.staleAfterDays, { min: 0 }),
  };
}

/** Composition values win over the environment; both win over the module defaults. */
export function resolveIndexLayerConfig(overrides = {}) {
  const cfg = { ...defaultIndexLayerConfig() };
  for (const key of Object.keys(defaultIndexLayerConfig())) {
    const value = overrides?.[key];
    if (value === undefined || value === null) continue;
    if (typeof defaultIndexLayerConfig()[key] === 'boolean') cfg[key] = value !== false;
    else if (Number.isFinite(Number(value))) cfg[key] = Number(value);
  }
  return cfg;
}

/**
 * A cached reader for the card store, shaped for the assemble waterfall.
 *
 * The waterfall runs on every model step, so this must not read a 550 KB store
 * per step. Cards are cached against the file's mtime and re-read only when it
 * moves; `stat` per step is the only I/O in the steady state, and a failed
 * stat/read degrades to the last good block rather than to an exception inside
 * prompt assembly.
 *
 * @param {{ cardsPath?: string, logger?: any, now?: () => number }} [options]
 */
export function createIndexLayer(options = {}) {
  const cardsPath = options.cardsPath ?? defaultCardPath();
  const now = options.now ?? Date.now;
  /** @type {{ mtimeMs: number, cards: object[] } | null} */
  let cached = null;
  /** @type {{ text: string, shown: number, hidden: number, chars: number, at: number } | null} */
  let last = null;

  /**
   * @param {{ maxChars?: number, maxCards?: number, lineChars?: number, staleAfterDays?: number }} [config]
   * @returns {Promise<{ text: string, shown: number, hidden: number, chars: number }>}
   */
  async function read(config = {}) {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(cardsPath)).mtimeMs;
    } catch {
      // A missing store is an empty store: no section, and no warning per step.
      return { text: '', shown: 0, hidden: 0, chars: 0 };
    }
    if (cached === null || cached.mtimeMs !== mtimeMs) {
      try {
        cached = { mtimeMs, cards: await readCards(cardsPath) };
      } catch (error) {
        options.logger?.debug?.('[dsh-g-memory] index layer skipped: ' + (error?.message || error));
        return last === null ? { text: '', shown: 0, hidden: 0, chars: 0 } : last;
      }
    }
    const rendered = renderIndexBlock(cached.cards, { ...config, now: now() });
    last = { ...rendered, at: now() };
    return rendered;
  }

  return { read, cardsPath, limits: INDEX_LAYER_LIMITS };
}
