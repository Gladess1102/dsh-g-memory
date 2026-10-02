/**
 * Session log extraction.
 *
 * DSH persists each session as an append-only zstd-compressed JSONL log
 * (`session.jsonl.zstd`, multiple zstd frames). This module turns those logs
 * into indexable memory units.
 *
 * What is kept, and why:
 *
 *   user/message       real human turns only — messages whose `source.kind` is
 *                      `plugin` are runtime injections (system-prompt snapshots,
 *                      reminders) and are not memory.
 *   assistant/message  the model's durable prose. Streaming fragment events
 *                      (the `chunk` event families, 84.6% of all events on this
 *                      machine) are discarded.
 *   tool/result        SELECTIVELY. Measurements and error text are the most
 *                      fact-dense content in the whole log, and they exist
 *                      nowhere else: on this corpus the strings `5.95`,
 *                      `-0.000033` and `512 token` appear ZERO times in
 *                      user+assistant prose. Indexing only prose yields a
 *                      memory that can recall "what we discussed" but never
 *                      "what we measured". File reads and blob JSON are
 *                      skipped instead — they are re-readable on demand and
 *                      pollute retrieval.
 *
 * SPDX-License-Identifier: MIT
 */

import { chunkBySentence, CHUNK_CHARS_TOOL, MIN_CHUNK_CHARS, normalizeWhitespace, sanitizeText, isLowInformation } from './chunker.mjs';
import { runZstd, MAX_LOG_BYTES } from './zstd.mjs';
import { contentHash } from './vector.mjs';

/**
 * Decompress a possibly multi-frame zstd file to text.
 *
 * `node:zlib`'s decompressor aborts on this file layout ("Unknown frame
 * descriptor") because the log is written as a sequence of independently
 * flushed frames, so the zstd CLI is used instead. It concatenates frames by
 * default, which is exactly the behaviour required.
 *
 * The contract is a **string**, because every caller parses the result as JSONL
 * text. The shared runner deals in bytes, so the decode belongs here at the
 * boundary. It previously leaked a `Buffer` through this function while the
 * JSDoc still promised a string, which broke `build` with "jsonl.split is not a
 * function" — nothing tested the path, so nothing caught it. The regression
 * check now lives in `scripts/test-plugin.mjs`.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function decompressZstdFile(file) {
  const bytes = await runZstd(['-d', '-c', '--no-progress', file], null, MAX_LOG_BYTES);
  return bytes.toString('utf8');
}

/**
 * @typedef {object} MemoryUnit
 * @property {string} text       chunk content
 * @property {'user'|'assistant'|'tool'} role
 * @property {string} session    session id
 * @property {number} seq        event sequence number
 * @property {number} time       event timestamp (epoch ms)
 * @property {string} hash       content hash (dedup / idempotency)
 */

/**
 * Concatenate the `text` blocks of a message content array.
 * @param {any[]} [content]
 * @returns {string}
 */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/**
 * `tool/result` content nests one level deeper than chat messages.
 * @param {any[]} [content]
 * @returns {string}
 */
function toolResultText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block) continue;
    if (typeof block.text === 'string') out += block.text;
    if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && typeof inner.text === 'string') out += inner.text;
      }
    }
  }
  return out;
}

/**
 * Runtime-injected user messages (prompt snapshots, reminders, plugin notices)
 * are not memory and would otherwise dominate the index.
 * @param {any} source
 * @returns {boolean}
 */
function isInjected(source) {
  const kind = source && typeof source === 'object' ? source.kind : undefined;
  // v4 producer-owned kinds look like `plugin:<pkg>`; the bare `'plugin'`
  // wrapper only survives in pre-migration transcripts.
  return kind === 'plugin' || kind === 'system' || kind === 'reminder' || (typeof kind === 'string' && kind.startsWith('plugin:'));
}

/** Source-code / document file extensions used to recognise file-read dumps. */
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|less|html|vue|svelte|yml|yaml|toml|ini|conf|md|mdx|txt|json|jsonc|xml|gradle|lock|mod|sum)\b/i;

/**
 * Classify a tool result so blob-like output can be excluded.
 *
 * The categories mirror the design decision recorded above; `file-read` and
 * `json` are dropped, everything else is indexed.
 *
 * @param {string} text
 * @returns {'file-read'|'json'|'error'|'measure'|'other'}
 */
export function classifyToolResult(text) {
  const head = text.slice(0, 600);

  if (/^\s*[[{]/.test(head) && text.length > 400) return 'json';

  // Read tool output is a header line followed by numbered source lines.
  if (/^\s*\d+[\t|]/.test(text.slice(0, 40)) || /^\s*\d+→/.test(text.slice(0, 40))) return 'file-read';
  if (FILE_EXT.test(head) && /(?:^|\n)\s*\d+[\t|:]/.test(head)) return 'file-read';
  if (/\(End of file|total \d+ lines\)/.test(text.slice(0, 400))) return 'file-read';

  if (/\b(?:Error|ERROR|error:|failed|FAILED|ENOENT|EACCES|Traceback|panic:|Exception)\b/.test(head)) {
    return 'error';
  }
  if (/\d+(?:\.\d+)?\s*(?:MiB|MB|KiB|KB|B\/unit|ms\b|s\b|%|×|tokens?|chars?|units?\/s)/.test(text)) {
    return 'measure';
  }
  return 'other';
}

/** Tool categories that are worth remembering. */
const INDEXED_TOOL_KINDS = new Set(['error', 'measure', 'other']);

/**
 * Extract memory units from decompressed session JSONL.
 *
 * @param {string} jsonl
 * @param {{ includeToolResults?: boolean, maxToolChars?: number, session?: string }} [options]
 * @returns {{ units: MemoryUnit[], stats: Record<string, number> }}
 */
export function extractUnits(jsonl, options = {}) {
  const includeToolResults = options.includeToolResults !== false;
  const maxToolChars = options.maxToolChars ?? 4000;
  /**
   * The locator written onto every unit.
   *
   * Best supplied by the caller, which knows which *file* it just read. Deriving
   * it from the log's own contents instead produced three shapes in one index —
   * `session-<uuid>` from event-level fields, a bare `<uuid>` from the header
   * record, and the occasional stray — because logs written by different versions
   * carry different fields. A locator is a path, not a field: `$session#$seq` is
   * what a reader follows to re-read the source, so it has to name the thing that
   * was actually read.
   */
  const sessionOverride = typeof options.session === 'string' && options.session !== ''
    ? options.session
    : '';
  /** Only events after this seq are considered (0 = all of them). */
  const fromSeq = Number(options.fromSeq) || 0;
  let lastSeq = fromSeq;

  /** @type {MemoryUnit[]} */
  const units = [];
  const seen = new Set();
  const sessions = new Set();
  /** Captured from the session header record; see the note in the loop. */
  let sessionId = '';
  const stats = {
    records: 0, userUnits: 0, assistantUnits: 0, toolUnits: 0,
    toolSkipped: 0, deduped: 0, chars: 0,
    // Declared here, not created on first use: the caller accumulates only the
    // keys it already knows, so a key born mid-parse was counted and then dropped.
    fillerSkipped: 0,
    unparsable: 0,
  };

  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Counted, not ignored. A truncated or corrupted log otherwise looks exactly
      // like a short one, and "this session contributed 40 units instead of 400"
      // is not something an operator can notice from the outside.
      stats.unparsable += 1;
      continue;
    }
    stats.records += 1;

    // The log's first record is the session header (`type: "session"`) and it is
    // the only one carrying the id. Every later record omits it, so the id is
    // captured once here and stamped onto the units that follow.
    if (event.type === 'session' && typeof event.id === 'string') {
      sessionId = event.id;
      continue;
    }

    const data = event.data || {};
    const session = sessionOverride || String(event.sessionId || data.sessionId || sessionId || '');
    const seq = Number(event.seq) || 0;
    const time = Number(event.time) || 0;
    // Incremental reads: a live update re-reads the whole log but only wants the
    // events that arrived since the last pass. `seq` is monotonic per session, so
    // the watermark is exact rather than a guess based on file size.
    if (fromSeq > 0 && seq <= fromSeq) continue;
    // Reported back so an incremental reader can move its watermark past events
    // that produced no units (headers, step markers) instead of re-reading them.
    if (seq > lastSeq) lastSeq = seq;
    if (session) sessions.add(session);

    /** @type {'user'|'assistant'|'tool'|null} */
    let role = null;
    let text = '';
    let chunkChars;

    if (event.type === 'user/message') {
      if (isInjected(data.source)) continue;
      role = 'user';
      text = textOf(data.content);
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      text = textOf(data.message && data.message.content);
    } else if (event.type === 'tool/result' && includeToolResults) {
      const raw = toolResultText(data.message && data.message.content);
      if (raw.length < MIN_CHUNK_CHARS) continue;
      // Drop filler before it costs a vector. See isLowInformation for why this
      // is safe to do here and not at retrieval time.
      if (isLowInformation(raw)) { stats.fillerSkipped = (stats.fillerSkipped || 0) + 1; continue; }
      const kind = classifyToolResult(raw);
      if (!INDEXED_TOOL_KINDS.has(kind)) {
        stats.toolSkipped += 1;
        continue;
      }
      role = 'tool';
      // Command output is fact-dense but often very long; keep head and tail.
      text = raw.length > maxToolChars
        ? `${raw.slice(0, maxToolChars / 2)}\n…\n${raw.slice(-maxToolChars / 2)}`
        : raw;
      chunkChars = CHUNK_CHARS_TOOL;
    } else {
      continue;
    }

    const normalized = normalizeWhitespace(sanitizeText(text));
    if (normalized.length < MIN_CHUNK_CHARS) continue;

    for (const part of chunkBySentence(normalized, chunkChars ?? undefined)) {
      const hash = contentHash(part);
      if (seen.has(hash)) {
        stats.deduped += 1;
        continue;
      }
      seen.add(hash);
      units.push({ text: part, role, session, seq, time, hash });
      stats.chars += part.length;
      if (role === 'user') stats.userUnits += 1;
      else if (role === 'assistant') stats.assistantUnits += 1;
      else stats.toolUnits += 1;
    }
  }

  stats.sessions = sessions.size;
  stats.lastSeq = lastSeq;
  return { units, stats };
}
