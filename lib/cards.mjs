/**
 * Durable memory cards: the layer that survives losing the transcript.
 *
 * ## Why this exists
 *
 * Everything this plugin indexed before this module was a *slice of a session
 * log*: `text` fields are fragments of a transcript that lives somewhere else,
 * and the `session#seq` locator points back into that file. Measured, those
 * fragments carry about **23.5%** of the source text. So the architecture had a
 * dependency it never declared: **the memory was only as durable as the
 * transcript**, and deleting `~/.dsh/sessions` silently degraded it — a rebuild
 * enumerates sessions from disk, so units whose file was gone simply vanished,
 * with no warning.
 *
 * That is the one place this design and every extraction-based memory differ in
 * kind rather than degree. Mem0, claude-mem, Letta and VCP's diary tiers all
 * *author* their memory: the transcript is disposable input and losing it costs
 * nothing. VCP states the layering explicitly — OneRing is transcript-coupled
 * and small, while OneRingMemo, VCPTimeLine and the diaries are written down and
 * therefore outlive it. This plugin had only the first kind.
 *
 * A card is the second kind, at the smallest size that works: one self-contained
 * paragraph per session, plus tags, written while the session is still in the
 * model's context (so the marginal cost is output tokens, not a re-read), and
 * stored with its own vector so it is retrievable like anything else.
 *
 * ## What a card is not
 *
 * It is not a fact extractor. It does not try to decompose a session into
 * entities and relations, which is what buys the governance burden — write
 * approval, TTL, conflict resolution — that this plugin has so far avoided. A
 * card is a *summary with tags*, and its worst failure is being vague rather
 * than being wrong about a specific claim.
 *
 * SPDX-License-Identifier: MIT
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { l2Normalize, quantizeInt8, packVector } from './vector.mjs';
// The synthesiser's refusal classifier, reused rather than re-implemented so the
// two cannot disagree about what counts as a memory. It is a pure predicate; the
// import is acyclic (synthesize.mjs depends only on env.mjs).
import { isRefusal } from './synthesize.mjs';

/** Unique temp suffix, so two writers in one process cannot collide. */
let tempCounter = 0;

/** Write 0600 through a unique temp file, then rename over the target. */
async function atomicReplace(target, body) {
  const tmp = `${target}.tmp-${process.pid}-${(tempCounter += 1)}`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, target);
}

/** Cards live beside the index but are never rebuilt from it. */
export function defaultCardPath(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return process.env.DSH_G_MEMORY_CARDS || join(home, 'dsh-g-memory', 'cards.ndjson');
}

/** A card is a summary; these bounds keep it one. */
export const CARD_LIMITS = {
  maxChars: 600,
  maxTags: 8,
  tagMaxChars: 24,
};

/**
 * @typedef {object} MemoryCard
 * @property {string} id            stable, derived from session + summary
 * @property {string} session       source session id (a locator, not a dependency)
 * @property {number} time          epoch ms the card was written
 * @property {string} summary       self-contained text; readable with the session gone
 * @property {string[]} tags        VCP-style trailing tags, for filtering and display
 * @property {string} hash          content hash, for dedup across re-distillation
 * @property {string} [vector]      base64 packed int8, same space as the index
 */

/** Stable id so re-distilling a session replaces its card instead of duplicating it. */
function cardId(session, summary) {
  return createHash('sha1').update(`${session}\u0000${summary}`).digest('hex').slice(0, 20);
}

/**
 * Normalise a model's answer into a card body.
 *
 * Models wrap summaries in fences, prefix them with "摘要：", and emit the tag
 * line in half a dozen shapes. Normalising here keeps every caller from
 * re-deriving the same rules, and keeps a malformed card out of the store.
 *
 * @param {string} raw
 * @param {{ session?: string, time?: number, model?: string }} [meta]
 * @returns {MemoryCard | null} null when there is nothing worth storing
 */
export function parseCard(raw, meta = {}) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;

  // Tags: the last `Tag:` / `标签:` line, comma/、-separated. VCP's diary format
  // puts a stable tag line last, and that convention is what makes a tag index
  // possible at all.
  let body = text;
  const tags = [];
  const tagLine = text.match(/^[ \t>*-]*(?:tags?|标签)\s*[:：]\s*(.+)$/im);
  if (tagLine) {
    body = text.replace(tagLine[0], '').trim();
    for (const t of tagLine[1].split(/[,，、;；]+/)) {
      const tag = t.trim().replace(/^#/, '').slice(0, CARD_LIMITS.tagMaxChars);
      if (tag && !tags.includes(tag) && tags.length < CARD_LIMITS.maxTags) tags.push(tag);
    }
  }

  body = body
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .replace(/^[ \t]*(?:摘要|summary)\s*[:：]\s*/i, '')
    .replace(/[ \t]+$/gm, '')
    .trim();

  // Refusals and boilerplate are not memories. The synthesiser's own classifier
  // is reused rather than re-implemented, so the two cannot disagree.
  if (body.length < 30) return null;

  const summary = body.slice(0, CARD_LIMITS.maxChars);
  const session = String(meta.session ?? '');
  return {
    id: cardId(session, summary),
    session,
    time: Number(meta.time) || Date.now(),
    summary,
    tags,
    hash: createHash('sha1').update(summary).digest('hex').slice(0, 24),
    ...meta.model ? { model: meta.model } : {},
  };
}


/**
 * Mirrored, human-readable copy of the store.
 *
 * dsh-mneme's most useful decision, adopted here: memory should be a Markdown
 * file you can open, read and edit. It costs nothing to produce — the cards are
 * already self-contained text — and it changes what the store *is*: auditable
 * rather than opaque, and correctable by the person who owns it.
 *
 * Human edits win. On read, a mirror card whose body differs from the stored
 * JSON replaces it, so editing the `.md` is a supported way to fix a bad
 * summary without touching JSON. The store stays authoritative in format, the
 * human stays authoritative in content.
 *
 * @param {MemoryCard[]} cards
 * @param {string} storePath
 */
async function writeMirror(cards, storePath) {
  if (process.env.DSH_G_MEMORY_CARD_MIRROR === 'off') return;
  const dir = join(dirname(storePath), 'cards');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lines = [
    '# 记忆卡',
    '',
    '> 本文件由 dsh-g-memory 生成，但**人工编辑会被优先尊重** ——',
    '> 直接改正文即可修正一条记忆，下次读取时以本文件为准。',
    '',
  ];
  for (const card of cards) {
    const when = card.time ? new Date(card.time).toISOString().slice(0, 16).replace('T', ' ') : '';
    lines.push(`## ${when}  \`${card.id}\``, '');
    if (card.session) lines.push(`来源会话：\`${card.session}\``, '');
    lines.push(card.summary, '');
    if (card.tags?.length) lines.push(`Tag: ${card.tags.join(', ')}`, '');
    lines.push('---', '');
  }
  await atomicReplace(join(dir, 'MEMORY.md'), lines.join('\n'));
}

/**
 * Apply human edits from the mirror back onto the store.
 *
 * Section-keyed by card id, so edits survive reordering and new cards. A section
 * whose body is unchanged is ignored; only real differences are applied.
 *
 * @param {MemoryCard[]} cards
 * @param {string} storePath
 */
export async function applyMirrorEdits(cards, storePath) {
  // The switch has to gate reading too. It used to gate only the write, so
  // turning the mirror off left a stale `MEMORY.md` still overriding the store —
  // the setting appeared to do nothing, which is worse than not having it.
  if (process.env.DSH_G_MEMORY_CARD_MIRROR === 'off') return { edited: 0 };
  const mirrorPath = join(dirname(storePath), 'cards', 'MEMORY.md');
  let text = '';
  try { text = await readFile(mirrorPath, 'utf8'); } catch { return { edited: 0 }; }

  const sections = new Map();
  for (const block of text.split(/^## /m).slice(1)) {
    // Take the backticked token from the heading line rather than guessing at
    // field positions: the heading carries a date *and* a time before the id.
    const id = block.split('\n')[0].match(/`([^`]+)`/)?.[1];
    if (!id) continue;
    const body = block
      .replace(/^[^\n]*\n/, '')
      .replace(/^来源会话：.*$/m, '')
      .split(/^---$/m)[0]
      .split('\n')
      .filter((l) => !/^Tag:\s*/.test(l))
      .join('\n')
      .trim();
    if (body) sections.set(id, body);
  }

  let edited = 0;
  for (const card of cards) {
    const human = sections.get(card.id);
    if (human === undefined || human === card.summary) continue;
    card.summary = human.slice(0, CARD_LIMITS.maxChars);
    // The hash follows the content, so the edited card is a distinct memory
    // rather than a silent overwrite of the machine's version.
    card.hash = createHash('sha1').update(card.summary).digest('hex').slice(0, 24);
    card.editedByHuman = true;
    edited += 1;
  }
  return { edited };
}

/**
 * Card rows dropped by the most recent {@link readCards}.
 *
 * Counted rather than ignored: the next write serialises what was parsed, so an
 * uncounted skip becomes a permanent deletion on the following write.
 */
export let lastSkippedCards = 0;

/** Read the card store. A missing file is an empty store, not an error. */
export async function readCards(path = defaultCardPath()) {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { lastSkippedCards = 0; return []; }
    throw error;
  }
  const cards = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const card = JSON.parse(line);
      // Coerced on the way in for the same reason the index coerces: one
      // malformed row must not be able to take down a recall.
      if (card && typeof card.summary === 'string' && card.summary.length > 0) cards.push(card);
      else skipped += 1;
    } catch { skipped += 1; /* keep the rest, count the damage */ }
  }
  lastSkippedCards = skipped;
  // Human edits win, at read time, so every consumer — retrieval, the CLI, the
  // plugin — sees the corrected memory without having to know about the mirror.
  if (cards.length > 0) await applyMirrorEdits(cards, path).catch(() => {});
  return cards;
}

/**
 * Per-store write chains.
 *
 * Two writers in the same process used to collide twice over: both built a temp
 * path from `process.pid` (so the first `rename` moved the file out from under
 * the second, which then threw ENOENT), and both merged onto the same snapshot of
 * the store (so whichever finished last silently dropped the other's card). Both
 * are reachable from the plugin — two `memory_note` calls in one turn, or a
 * consolidation write landing while the user records something.
 *
 * Serialising per path fixes the lost update; the unique temp name below fixes
 * the ENOENT for writers that are not routed through here.
 */
const writeChains = new Map();

function serializeWrites(key, task) {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // The chain must survive a failed write, or every later write inherits it.
  writeChains.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * Write cards, replacing any existing card with the same id.
 *
 * Rewrite-then-rename: a card store that is half-written is worse than one that
 * is a version behind, because the loss is silent and the file parses fine.
 *
 * @param {MemoryCard[]} incoming
 * @param {string} [path]
 */
export async function writeCards(incoming, path = defaultCardPath()) {
  return serializeWrites(path, () => writeCardsLocked(incoming, path));
}

async function writeCardsLocked(incoming, path = defaultCardPath()) {
  // A refusal is not a memory. The store used to accept anything long enough,
  // which is how "未找到相关记忆" ended up as a retrievable card with a vector.
  const accepted = incoming.filter((card) => !isRefusal(String(card.summary ?? '')));
  const refused = incoming.length - accepted.length;

  const current = await readCards(path).catch(() => []);
  const byId = new Map(current.map((c) => [c.id, c]));
  // Content dedup, which the `hash` field has always carried and nothing ever
  // read. The id is `sha1(session + summary)`, so the same fact recorded on two
  // different days became two cards — the duplicate the hash exists to catch.
  const knownHashes = new Set(current.map((c) => c.hash).filter(Boolean));
  let duplicates = 0;
  let added = 0;
  for (const card of accepted) {
    if (!byId.has(card.id) && card.hash && knownHashes.has(card.hash)) {
      duplicates += 1;
      continue;
    }
    byId.set(card.id, card);
    if (card.hash) knownHashes.add(card.hash);
    added += 1;
  }
  const merged = [...byId.values()].sort((a, b) => a.time - b.time);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Preserve the unparseable rows before the rewrite erases them: `readCards`
  // skips them, and the next write serialises only what it could parse, so the
  // damaged line survives exactly one write without this.
  if (lastSkippedCards > 0) {
    await copyFile(path, `${path}.damaged-${Date.now()}`).catch(() => {});
  }
  // Store first, mirror second. The mirror is a view, and it takes precedence on
  // read, so writing it first meant a failed store write left the mirror showing a
  // card the store did not have — and the next successful write would drop it.
  await atomicReplace(path, `${merged.map((c) => JSON.stringify(c)).join('\n')}\n`);
  await writeMirror(merged, path);
  return { total: merged.length, added, refused, duplicates };
}

/** Attach a packed vector to a card, in the same space as the memory index. */
export function withVector(card, rawVector) {
  const { codes, scale } = quantizeInt8(l2Normalize(rawVector));
  return { ...card, vector: packVector(codes, scale).toString('base64') };
}

/**
 * Rank cards against a query vector.
 *
 * Cards share the index's vector space (same embedder, same 1024 dimensions, same
 * int8 packing), so a single query embedding searches both. That is the whole
 * reason this is cheap: no second model, no second index format.
 *
 * @param {MemoryCard[]} cards
 * @param {Float32Array | number[]} queryVector already L2-normalised
 * @param {{ limit?: number }} [options]
 */
export function searchCards(cards, queryVector, options = {}) {
  const q = l2Normalize(queryVector);
  const scored = [];
  for (const card of cards) {
    if (typeof card.vector !== 'string') continue;
    const packed = Buffer.from(card.vector, 'base64');
    if (packed.length < 5) continue;
    const scale = packed.readFloatLE(0);
    const dim = packed.length - 4;
    if (dim !== q.length) continue; // a card from another embedding model is not comparable
    let dot = 0;
    for (let i = 0; i < dim; i += 1) {
      // int8 codes are signed; the vector was L2-normalised before quantising, so
      // the dot product is the cosine similarity directly.
      dot += q[i] * (packed.readInt8(4 + i) * scale);
    }
    scored.push({ card, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, options.limit ?? 5);
}

/** Human line for a card, used by the CLI and by `/recall --cards`. */
export function formatCard(card) {
  const when = card.time ? new Date(card.time).toISOString().slice(0, 16).replace('T', ' ') : '';
  const tags = card.tags?.length ? `  [${card.tags.join(', ')}]` : '';
  return `${when}  ${card.summary}${tags}`;
}

/** Tag frequency across the store — the cheapest useful view of what is remembered. */
export function tagIndex(cards) {
  const counts = new Map();
  for (const card of cards) {
    for (const tag of card.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}


/**
 * Cards as retrieval candidates, in the same shape the index produces.
 *
 * Deliberately *not* scored separately. A card is a document like any other, so
 * it goes into the same pool, through the same cross-encoder, against the same
 * gate. Giving cards their own threshold would mean two relevance scales that
 * could disagree — which is exactly how the tool path and the automatic path
 * drifted apart before §2.23.
 *
 * `source: 'card'` travels with the entry so injection can say where it came
 * from. That label is not cosmetic: a card is an authored summary and a fragment
 * is verbatim transcript, so they carry different kinds of certainty.
 *
 * @param {MemoryCard[]} cards
 * @param {Float32Array | number[]} queryVector
 * @param {{ limit?: number, minSimilarity?: number }} [options]
 */
export function cardEntries(cards, queryVector, options = {}) {
  const minSimilarity = options.minSimilarity ?? 0.35;
  return searchCards(cards, queryVector, { limit: options.limit ?? 8 })
    // A cheap pre-filter only. The cross-encoder decides what is actually
    // relevant; this just keeps obviously unrelated cards out of its batch.
    .filter((hit) => hit.score >= minSimilarity)
    .map((hit) => ({
      text: hit.card.summary,
      role: 'card',
      time: hit.card.time,
      session: hit.card.session,
      seq: null,
      score: 0,
      // The cosine that admitted it. `score` stays 0 because a card is not an RRF
      // hit and the reranker, when there is one, overwrites `score` with its own
      // reading; on the degraded path this is what the gate has to judge it by.
      similarity: hit.score,
      source: 'card',
      cardId: hit.card.id,
      tags: hit.card.tags ?? [],
      editedByHuman: hit.card.editedByHuman === true,
    }));
}
