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
 *   tool/call          WHEN IT NAMES A FILE. An authoring call (`write`, `edit`,
 *                      the same call under another name) carries a path plus the
 *                      text it put there, and that text is the only record of a
 *                      file's *history*: the disk keeps the latest state, so what
 *                      was overwritten or deleted exists nowhere else.
 *
 *                      Measured on this corpus (the logs the index actually reads:
 *                      the newest version per session directory) before the rule
 *                      existed: 1,004 authoring calls holding 2.45 MiB, of which a
 *                      mean of **6.7%** of sampled 60-character windows could be
 *                      found anywhere in the index, and **71% of the calls could be
 *                      found nowhere at all** — the plugin could not answer "which
 *                      file did we put that in". After it: **97.1%** and **1%**.
 *                      That is +1,752
 *                      units and +1.58 MiB of searchable text on an 11.30 MiB index
 *                      (+15.4%), and it turned two governance cases recorded as
 *                      "structurally unanswerable" into two passes.
 *
 *                      The measurement needed three attempts, and the two failures
 *                      are worth remembering: a shingle set built at one stride and
 *                      probed at another cannot match (a unit verbatim in the index
 *                      scored 0.096), and a probe that re-implements the rendering
 *                      instead of calling it disagrees with it the moment the two
 *                      drift (the `- `/`+ ` diff prefixes were missing, so every
 *                      edit looked absent).
 *
 *                      Shell commands and `run_code` bodies are deliberately NOT
 *                      indexed: they total +4.0 MiB and +6.9 MiB and are mostly
 *                      re-runnable noise, while a file write is a durable artefact.
 *                      `cordis_define` is out too — it carries code but names no
 *                      file, so a unit from it could not say what it was about.
 *
 * SPDX-License-Identifier: MIT
 */

import { chunkBySentence, CHUNK_CHARS_TOOL, MIN_CHUNK_CHARS, normalizeWhitespace, sanitizeText, isLowInformation } from './chunker.mjs';
import { runZstd, MAX_LOG_BYTES } from './zstd.mjs';
import { contentHash } from './vector.mjs';

/**
 * Which extractor revision produced the units in an index.
 *
 * Bumped whenever this module starts producing units it did not produce before.
 * The live index keeps a per-log `seq` watermark and only reads events *after* it,
 * so a rule that newly admits an event type would never see the older events
 * again: the new units would be missing from every session that had already been
 * processed, silently and permanently. The watermark store records this number
 * and re-reads from zero when it changes — cheap, because units are deduplicated
 * by content hash, so only genuinely new text is embedded.
 */
export const EXTRACTOR_VERSION = 4;

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
 * @property {'user'|'assistant'|'tool'|'action'} role
 *                               `action` is a tool the agent *issued* (an authoring
 *                               call), as opposed to `tool`, which is what a tool
 *                               returned. They are different evidence: one is what
 *                               was decided, the other is what came back.
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
/**
 * The only `source.kind` that is a human turn.
 *
 * This was a denylist — `plugin`, `system`, `reminder`, `plugin:*` — and a denylist
 * cannot hold this line: the set of producer kinds grows with the runtime, and every
 * addition is invisible here by construction. Measured on this machine's own index
 * (2026-10-17): **1,729 of 3,529 rows labelled \`user\`** came from kinds the
 * denylist had never heard of — `agent-instructions` (384), `agent-message` (393),
 * `subagent-settled` (316), `compact-checkpoint` (176), `tool-jobs` (168),
 * `ptc-mode` (117), `team-message` (59), `skill-catalog` (40), plus
 * `runtime-context`, `goal`, `tool-goal`, `model-selection`, `time-context`,
 * `repeat-tool-reminder`. Every one of those is the harness talking to itself, and
 * every one was retrievable as something the user had said.
 *
 * The harness tags every `user/message` it produces, and it tags human turns too
 * (measured: 2,615 events, zero without a kind), so the rule inverts safely — a
 * kind this version does not recognise is an injection, not a human.
 */
const HUMAN_SOURCE_KIND = 'user';

/**
 * Is this `user/message` a runtime injection rather than something the user said?
 *
 * Two rules, and the asymmetry between their failure modes is the reason for both:
 *
 *   A labelled message is human only if its kind is `user`; every other kind is an
 *   injection. Measured over this machine's logs (207 sessions, 2,615 user/message
 *   events) the harness labels all of them, injections included — so a kind that
 *   this version does not recognise is a producer talking, not a person.
 *
 *   An *unlabelled* message is treated as human. That is the deliberate half. The
 *   measurement above says unlabelled turns do not occur in practice, so the choice
 *   only decides what happens when something unexpected appears — and the two
 *   mistakes are not symmetric. Refusing a human turn deletes a memory that can
 *   never be recovered; admitting an unlabelled injection is countable by
 *   `scripts/audit-index-sources.mjs` (such rows carry no kind) and removable by
 *   `scripts/prune-injected-rows.mjs`. One is silent data loss, the other is a
 *   number on a report.
 *
 * @param {any} source
 * @returns {boolean}
 */
function isInjected(source) {
  const kind = sourceKindOf(source);
  if (kind === null) return false;
  return kind !== HUMAN_SOURCE_KIND;
}

/**
 * The \`source.kind\` an event carried, or null.
 *
 * Kept per unit so the index can be audited for content that should never have been
 * admitted. The extractor filters injected turns by construction, and a filter that
 * silently stops working leaves no trace at all — the neighbouring memory project in
 * this space shipped 83,464 injected slices (71% of its "user" text) and only found
 * out months later. A stored field is what turns that class of failure into something
 * a script can answer, instead of something an accident reveals.
 *
 * @param {any} source
 * @returns {string|null}
 */
function sourceKindOf(source) {
  if (source === null || source === undefined) return null;
  if (typeof source === 'string') return source === '' ? null : source;
  if (typeof source === 'object' && typeof source.kind === 'string' && source.kind !== '') return source.kind;
  return null;
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
 * Argument fields that name the artifact a tool call wrote to.
 *
 * The rule is shape-based rather than a list of tool names, because the name is
 * the harness's business (`write`, `create_file`, a `str_replace_editor` on
 * another machine) while the shape is the meaning: a path plus text to put there.
 * Measured over 13,227 tool calls on this corpus, it admits exactly three: `edit`
 * (669), `write` (306) and `str_replace_editor` (32) — 1,007 calls, of which 1,004
 * are long enough to index. The other 12,220 are excluded, correctly: `read` has a
 * path but no text, `run_code` and `cordis_define` have text but no path, and
 * `present` nests its paths inside an array.
 */
const AUTHORING_PATH_FIELDS = ['file_path', 'path'];
/** Argument fields carrying text the call added. */
const AUTHORING_NEW_FIELDS = ['content', 'file_text', 'new_string', 'new_str'];
/** Argument fields carrying the text being replaced. */
const AUTHORING_OLD_FIELDS = ['old_string', 'old_str'];

/** Prefix every line, so a multi-line edit reads as a diff rather than prose. */
function prefixLines(text, sign) {
  return text.split('\n').map((line) => `${sign} ${line}`).join('\n');
}

/**
 * Render an authoring call as a memory unit, or `''` when the call is not one.
 *
 * The tool name is kept verbatim as the label: it is what the operator will see
 * in the session log, and translating it would make the unit harder to trace back.
 *
 * @param {unknown} name
 * @param {unknown} args parsed tool arguments
 * @returns {string} a unit body, or `''` when this is not an authoring call
 */
export function renderAuthoringCall(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = /** @type {Record<string, unknown>} */ (args);
  const pick = (fields) => fields
    .map((field) => record[field])
    .find((value) => typeof value === 'string' && value !== '');
  // A path with a newline in it is a rendering artifact, not a file name, and a
  // unit whose header is 2 KB of something else retrieves nothing.
  const path = AUTHORING_PATH_FIELDS
    .map((field) => record[field])
    .find((value) => typeof value === 'string' && value.trim() !== '' && !value.includes('\n'));
  if (typeof path !== 'string') return '';
  const added = pick(AUTHORING_NEW_FIELDS);
  const removed = pick(AUTHORING_OLD_FIELDS);
  if (added === undefined && removed === undefined) return '';

  const parts = [`[${String(name || 'tool')}] ${path.trim()}`];
  if (typeof removed === 'string') parts.push(prefixLines(removed, '-'));
  if (typeof added === 'string') parts.push(prefixLines(added, '+'));
  return parts.join('\n');
}

/**
 * Extract memory units from decompressed session JSONL.
 *
 * @param {string} jsonl
 * @param {{ includeToolResults?: boolean, includeToolCalls?: boolean, maxToolChars?: number,
 *           maxAuthoringChars?: number, session?: string, fromSeq?: number }} [options]
 * @returns {{ units: MemoryUnit[], stats: Record<string, number> }}
 */
export function extractUnits(jsonl, options = {}) {
  const includeToolResults = options.includeToolResults !== false;
  const includeToolCalls = options.includeToolCalls !== false;
  const maxToolChars = options.maxToolChars ?? 4000;
  /**
   * Ceiling for one authoring call.
   *
   * Measured over 1,004 real calls (rendered length): median 1,618 characters, p90
   * 5,858, max 22,412. At 8,000 the index keeps 2.31 MiB of the 2.45 MiB total
   * (94%) and truncates 45 calls, so the cut is nearly free at that size. It exists
   * for the tail that is not: a minified bundle written to disk would otherwise
   * enter the index at its full size, and the index is the layer that has to be
   * stingy (see isLowInformation).
   */
  const maxAuthoringChars = options.maxAuthoringChars ?? 8000;
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
    records: 0, userUnits: 0, assistantUnits: 0, toolUnits: 0, actionUnits: 0,
    toolSkipped: 0, deduped: 0, chars: 0,
    // Declared here, not created on first use: the caller accumulates only the
    // keys it already knows, so a key born mid-parse was counted and then dropped.
    fillerSkipped: 0,
    unparsable: 0,
    // Authoring calls whose `arguments` did not parse. Counted for the same reason
    // as `unparsable`: a log full of truncated calls otherwise looks like a log
    // that simply contained no writes.
    authoringUnparsable: 0,
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

    /** @type {'user'|'assistant'|'tool'|'action'|null} */
    let role = null;
    let text = '';
    let chunkChars;
    const sourceKind = sourceKindOf(data.source);

    if (event.type === 'user/message') {
      // `includeInjected` exists for the audit path only. A filter can only ever be
      // checked against itself if the auditor cannot see what it refused: the source
      // audit has to re-derive the refused rows to answer "is this index clean?"
      // rather than "does the filter agree with the filter?". Nothing in the
      // indexing path passes it.
      if (!options.includeInjected && isInjected(data.source)) continue;
      role = 'user';
      text = textOf(data.content);
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      text = textOf(data.message && data.message.content);
    } else if (event.type === 'tool/call' && includeToolCalls) {
      // The call's arguments, not its result: see the header note. Rendered only
      // when the call names a file, which is what makes it an authoring record.
      const raw = typeof data.arguments === 'string'
        ? data.arguments
        : (data.arguments === undefined ? '' : JSON.stringify(data.arguments));
      if (raw.length < MIN_CHUNK_CHARS) continue;
      let args;
      try {
        args = JSON.parse(raw);
      } catch {
        stats.authoringUnparsable += 1;
        continue;
      }
      const rendered = renderAuthoringCall(data.name, args);
      if (rendered === '') continue;
      role = 'action';
      // Head and tail, like command output: a file's opening lines name it and its
      // closing lines usually hold the export or the entry point. `maxAuthoringChars`
      // keeps 94% of real calls whole. A body whose *first* line is longer than a
      // chunk could in principle separate the `[write] /path` header from the
      // content; measured over 1,004 real calls, zero have such a line, so no
      // machinery is spent on it.
      text = rendered.length > maxAuthoringChars
        ? `${rendered.slice(0, maxAuthoringChars / 2)}\n…\n${rendered.slice(-maxAuthoringChars / 2)}`
        : rendered;
      chunkChars = CHUNK_CHARS_TOOL;
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
      units.push({ text: part, role, session, seq, time, hash, sourceKind });
      stats.chars += part.length;
      if (role === 'user') stats.userUnits += 1;
      else if (role === 'assistant') stats.assistantUnits += 1;
      else if (role === 'action') stats.actionUnits += 1;
      else stats.toolUnits += 1;
    }
  }

  stats.sessions = sessions.size;
  stats.lastSeq = lastSeq;
  return { units, stats };
}
