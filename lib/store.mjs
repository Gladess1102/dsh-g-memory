/**
 * Memory index storage and candidate retrieval.
 *
 * Retrieval arms, and why each exists:
 *
 *   vector   int8 cosine over all units, in the configured model's space
 *            (EmbeddingGemma-300M, 768-d, since 2026-09-24; BGE-M3 1024-d before
 *            that). On the original 8-query calibration it scored top-1 4/8,
 *            top-20 7/8.
 *   lexical  bigram-tokenised BM25-ish presence scoring. On the same calibration
 *            top-1 5/8, top-20 7/8 — it beats the vector arm on precise queries.
 *   fused    Reciprocal Rank Fusion of the two. Measured top-20 8/8, and the
 *            gain only appears when chunks are cut at sentence boundaries:
 *            the two arms miss *different* units, so fusion recovers both.
 *
 * Design note: this layer is deliberately optimised for RECALL, not precision.
 * No arm reached 80% top-1 on the corpus, so precision is the LLM synthesis
 * layer's job; the retriever only has to get the right unit into the top-K.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tokenSet } from './tokenizer.mjs';
import { runZstd as runZstdCli, MAX_INDEX_BYTES } from './zstd.mjs';
import { int8Similarity, l2Normalize, unpackVector } from './vector.mjs';

export const INDEX_VERSION = 1;

/**
 * @typedef {object} IndexedUnit
 * @property {string} text
 * @property {'user'|'assistant'|'tool'|'action'} role
 * @property {string} session
 * @property {number} seq
 * @property {number} time
 * @property {string} hash
 * @property {boolean} [orphaned]  the source transcript is no longer on disk
 * @property {Buffer} vector
 */

/**
 * Roles an index row may carry.
 *
 * A whitelist rather than a pass-through, because an unrecognised value is
 * coerced to `tool`: the entry still retrieves, but every read relabels it, and
 * the label is what the synthesis prompt and the injection frame use to say where
 * a memory came from. That is the trap `action` sits next to — it was added to the
 * extractor in the same change as this set, so the failure never shipped, but
 * without the set every `action` unit would have read back as a tool *result*.
 */
const KNOWN_ROLES = new Set(['user', 'assistant', 'tool', 'action']);

/**
 * @typedef {object} MemoryIndex
 * @property {number} version
 * @property {number} dim
 * @property {number} builtAt
 * @property {string} model
 * @property {string} [queryPrefix] instruction the query side was embedded with
 * @property {string} [docPrefix] instruction the stored vectors were built with
 * @property {IndexedUnit[]} units
 */

/**
 * In-memory index with the lexical arm's inverted file built lazily.
 */
export class MemoryIndex {
  /** @param {MemoryIndex} data */
  constructor(data) {
    /** @type {MemoryIndex} */
    this.data = data;
    /** @type {Map<string, Set<number>> | null} */
    this._inverted = null;
    /** @type {Map<string, number> | null} */
    this._df = null;
  }

  get size() {
    return this.data.units.length;
  }

  get dim() {
    return this.data.dim;
  }

  /** Build the inverted file once, on first lexical query. */
  _ensureInverted() {
    if (this._inverted) return;
    /** @type {Map<string, Set<number>>} */
    const inverted = new Map();
    for (let i = 0; i < this.data.units.length; i += 1) {
      for (const token of tokenSet(this.data.units[i].text)) {
        let bucket = inverted.get(token);
        if (!bucket) {
          bucket = new Set();
          inverted.set(token, bucket);
        }
        bucket.add(i);
      }
    }
    this._inverted = inverted;
    /** @type {Map<string, number>} */
    const df = new Map();
    for (const [token, bucket] of inverted) df.set(token, bucket.size);
    this._df = df;
  }

  /**
   * Vector arm: cosine similarity against every unit.
   * @param {Float32Array} queryVector L2-normalised
   * @param {number} k
   * @returns {number[]} unit indices, best first
   */
  searchVector(queryVector, k) {
    const scored = [];
    for (let i = 0; i < this.data.units.length; i += 1) {
      const { codes, scale } = unpackVector(this.data.units[i].vector);
      scored.push([int8Similarity(queryVector, codes, scale), i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map(([, i]) => i);
  }

  /**
   * Lexical arm: idf-weighted token overlap, ignoring very common tokens.
   * @param {string} query
   * @param {number} k
   * @returns {number[]}
   */
  searchLexical(query, k) {
    this._ensureInverted();
    const inverted = /** @type {Map<string, Set<number>>} */ (this._inverted);
    const df = /** @type {Map<string, number>} */ (this._df);
    const total = this.data.units.length;
    const scores = new Map();
    /** @type {Set<string>} */
    const tokens = tokenSet(query);
    for (const token of tokens) {
      const bucket = inverted.get(token);
      if (!bucket) continue;
      const frequency = bucket.size;
      if (frequency > total * 0.3) continue; // too common to discriminate
      const idf = Math.log(1 + total / frequency);
      for (const index of bucket) scores.set(index, (scores.get(index) || 0) + idf);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
  }

  /**
   * Recall candidates by fusing the vector and lexical arms with RRF.
   *
   * RRF needs no score calibration between arms, which matters because the two
   * arms produce incomparable numbers (cosine vs idf sum).
   *
   * @param {Float32Array} queryVector
   * @param {string} query
   * @param {{ k?: number, rrfK?: number }} [options]
   * @returns {{ index: number, score: number }[]}
   */
  recall(queryVector, query, options = {}) {
    const k = options.k ?? 20;
    const rrfK = options.rrfK ?? 60;
    // A dimension mismatch makes the vector arm score NaN. `Array.sort` with a
    // NaN comparator is a no-op, so the arm would silently return the oldest
    // units in index order while still reporting a finite fused score. This
    // happens for real whenever the embedding model changes without a rebuild.
    if (queryVector.length !== this.data.dim) {
      throw new Error(
        `index was built with dim ${this.data.dim} but the embedder returned ${queryVector.length}; `
        + 'rebuild with: dsh-g-memory build',
      );
    }
    const arms = [this.searchVector(queryVector, k), this.searchLexical(query, k)];
    /** @type {Map<number, number>} */
    const fused = new Map();
    for (const arm of arms) {
      arm.forEach((index, rank) => {
        fused.set(index, (fused.get(index) || 0) + 1 / (rrfK + rank + 1));
      });
    }
    return [...fused.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** @param {number} index */
  unit(index) {
    return this.data.units[index];
  }
}

/**
 * Bytes `packVector` prepends to the int8 codes: one little-endian float32
 * scale. A stored vector is therefore `dim + PACKED_VECTOR_OVERHEAD` bytes.
 */
export const PACKED_VECTOR_OVERHEAD = 4;

/** Rank-fusion constant; see {@link MemoryIndex#recall}. */
export const RRF_K = 60;

/**
 * The lowest score a reciprocal-rank-fusion hit can have.
 *
 * RRF scores are quantised, not continuous: a unit found at rank `r` by one arm
 * scores `1/(RRF_K + r + 1)`, and a second arm adds another such term. The
 * *lowest* possible non-zero score is therefore the rank-0 term of a single arm,
 * `1/(RRF_K + 1)` = 0.01639 — and the next band up is a two-arm rank-0 hit at
 * `2/(RRF_K + 1)` = 0.03279. **Nothing can score between those two values.**
 *
 * That gap matters because a "minimum score" threshold is the obvious way to
 * suppress noise, and a threshold placed *inside* the gap discards every unit
 * that only one arm found — which is precisely the case fusion exists to
 * recover, since the two arms miss different units. This function returns the
 * band floor so a threshold can be calibrated against the scale instead of
 * guessed: a value at or below it admits any single-arm hit, and a value in the
 * gap above it admits only hits both arms agree on.
 *
 * @param {number} [rrfK]
 * @returns {number}
 */
export function rrfFloor(rrfK = RRF_K) {
  return 1 / (rrfK + 1);
}

/**
 * Serialise an index to NDJSON, one unit per line with a base64 vector.
 * @param {MemoryIndex} index
 * @returns {string}
 */
export function serializeIndex(index) {
  const lines = [
    JSON.stringify({
      kind: 'header',
      version: index.data.version,
      dim: index.data.dim,
      model: index.data.model,
      // The task prefixes are part of the space, exactly like the model name: the
      // same weights fed "title: none | text: " or bare text produce vectors that
      // are not comparable, at an identical width. Recording them is what lets a
      // rebuild reuse this index — or refuse to.
      queryPrefix: index.data.queryPrefix ?? '',
      docPrefix: index.data.docPrefix ?? '',
      builtAt: index.data.builtAt,
      units: index.data.units.length,
    }),
  ];
  for (const unit of index.data.units) {
    lines.push(JSON.stringify({
      text: unit.text,
      role: unit.role,
      session: unit.session,
      seq: unit.seq,
      time: unit.time,
      hash: unit.hash,
      // Kept so the injection layer can say the source transcript is gone. It was
      // computed at build time and then dropped here, which made the
      // "unverifiable (source deleted)" label unreachable: a memory whose
      // transcript had been deleted was still presented as verbatim and checkable.
      ...unit.orphaned === true ? { orphaned: true } : {},
      vector: unit.vector.toString('base64'),
    }));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} ndjson
 * @returns {MemoryIndex}
 */
export function deserializeIndex(ndjson) {
  const lines = ndjson.split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('dsh-g-memory: index is empty');
  const header = JSON.parse(lines[0]);
  if (header.kind !== 'header') throw new Error('dsh-g-memory: index is missing its header line');
  if (header.version !== INDEX_VERSION) {
    throw new Error(`dsh-g-memory: index version ${header.version} is not supported (expected ${INDEX_VERSION})`);
  }
  /** @type {IndexedUnit[]} */
  const units = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      skipped += 1;
      continue;
    }
    // Coerce rather than trust. A row with a non-string `text` used to make the
    // tool throw `unit.text.slice is not a function`, and a `time` outside the
    // Date range made `toISOString()` throw `RangeError` — one bad row and the
    // whole capability was gone. A vector of the wrong width would silently
    // corrupt ranking, so that row is dropped rather than coerced.
    //
    // The stored layout is `[float32 scale][dim int8 codes]`, i.e. dim + 4 bytes
    // (see `packVector`); comparing against `header.dim` alone rejects every row.
    const vector = Buffer.from(String(row.vector ?? ''), 'base64');
    if (vector.length !== header.dim + PACKED_VECTOR_OVERHEAD) {
      skipped += 1;
      continue;
    }
    const time = Number(row.time);
    units.push({
      text: String(row.text ?? ''),
      role: KNOWN_ROLES.has(row.role) ? row.role : 'tool',
      session: String(row.session ?? 'unknown'),
      seq: Number.isFinite(Number(row.seq)) ? Number(row.seq) : 0,
      // Anything outside the Date range would throw on toISOString(); 8.64e15 is
      // the largest value `new Date()` accepts.
      time: Number.isFinite(time) && time > 0 && time < 8.64e15 ? time : 0,
      hash: String(row.hash ?? ''),
      orphaned: row.orphaned === true,
      vector,
    });
  }
  lastSkippedRows = skipped;
  return new MemoryIndex({
    version: header.version,
    dim: header.dim,
    model: header.model,
    // Absent stays absent, and the difference matters: `undefined` means "written
    // before the fields existed, convention unknown", while `''` means "recorded as
    // the no-prefix convention". Collapsing the first into the second made the
    // readers that tolerate an unknown index unreachable — the live worker would
    // pause on the very upgrade the tolerance exists to survive.
    queryPrefix: header.queryPrefix === undefined ? undefined : String(header.queryPrefix),
    docPrefix: header.docPrefix === undefined ? undefined : String(header.docPrefix),
    builtAt: header.builtAt,
    units,
  });
}

/**
 * Write an index: the zstd-compressed copy, and the raw NDJSON only as a fallback.
 *
 * Both copies used to be written unconditionally, which cost 30.7 MB of the
 * 46 MB the index occupied — for a fallback that a reader only needs when the
 * `zstd` CLI is missing entirely. Measured on 16,769 units: reading the
 * compressed copy is not slower than reading the plain one (0.20 s vs 0.25 s),
 * because decompression runs at GB/s while the extra 15 MB is disk work. So the
 * plain copy is written only when there is no compressed copy to read, and a
 * stale one from an earlier build is removed — `readIndex` prefers the
 * compressed file, but a leftover plain file would serve an older index if the
 * preference ever changed.
 *
 * @param {string} dir
 * @param {MemoryIndex} index
 * @param {{ plain?: boolean }} [options] force the raw copy too (tests, debugging)
 * @returns {Promise<{ rawBytes: number, zstdBytes: number }>}
 */
/**
 * Compression level for the index.
 *
 * Measured on this index (35.6 MB raw): `-19` produced 18.3 MB in 12.5 s, `-9`
 * produced 18.3 MB in 0.45 s. Identical output, 28x the speed — and the write now
 * happens on every live update, so the difference is the whole design.
 */
const INDEX_ZSTD_LEVEL = process.env.DSH_G_MEMORY_INDEX_LEVEL || '-9';

export async function writeIndex(dir, index, options = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ndjson = serializeIndex(index);
  const raw = Buffer.from(ndjson, 'utf8');
  const rawPath = join(dir, 'index.ndjson');
  // The index holds verbatim conversation text, so it is written 0600 — the
  // default 0644 would make it world-readable wherever the home directory is
  // not itself private.
  let compressed = null;
  try {
    compressed = await runZstdCli([INDEX_ZSTD_LEVEL, '-c', '--no-progress'], raw, MAX_INDEX_BYTES);
  } catch {
    // No usable zstd: the plain copy is the only readable form.
    compressed = null;
  }
  // Write-then-rename: a crash mid-write then leaves the previous index intact
  // instead of a truncated file that parses to nothing.
  if (compressed === null) {
    await writeAtomic(rawPath, raw);
    return { rawBytes: raw.length, zstdBytes: 0 };
  }
  await writeAtomic(join(dir, 'index.ndjson.zstd'), compressed);
  if (options.plain === true) await writeAtomic(rawPath, raw);
  else await unlink(rawPath).catch(() => { /* already absent */ });
  return { rawBytes: raw.length, zstdBytes: compressed.length };
}

/** Write via a temp file in the same directory, then rename over the target. */
async function writeAtomic(target, data) {
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Read an index, preferring the compressed copy when the zstd CLI is present.
 * @param {string} dir
 * @returns {Promise<MemoryIndex>}
 */
/**
 * Rows dropped by the most recent {@link deserializeIndex} call.
 *
 * Exposed so a caller can report damage instead of silently serving a smaller
 * index than the one on disk — which is what {@link reportIndexDamage} does.
 */
export let lastSkippedRows = 0;

/**
 * Why the last {@link readIndex} fell back to the uncompressed copy, if it did.
 *
 * The fallback itself is right; doing it silently is not, because the caller then
 * serves an older index (or a slower path) with nothing to explain the change.
 * Reporting it is {@link reportIndexDamage}'s job.
 */
export let lastCompressedError = null;

/** What has already been reported, so a standing condition warns once. */
let reportedSkipped = 0;
let reportedCompressed = null;

/**
 * Warn about index damage, once per distinct condition.
 *
 * Both signals exist because the failure is otherwise invisible: a row that fails
 * validation is dropped, and a compressed copy that fails to decompress is
 * quietly replaced by the raw one. Either way the memory still answers, just with
 * less in it — the kind of degradation that is only ever noticed by missing the
 * thing that is missing.
 *
 * Repeating the warning on every cache refresh would be noise, so it is emitted
 * when the condition appears or changes, not while it persists.
 *
 * @param {{ warn?: (message: string) => void } | undefined} logger
 */
export function reportIndexDamage(logger) {
  if (lastSkippedRows !== reportedSkipped) {
    if (lastSkippedRows > 0) {
      logger?.warn?.(
        `[dsh-g-memory] ${lastSkippedRows} index row(s) failed validation and were dropped; `
        + 'those units are not retrievable until the index is rebuilt',
      );
    }
    reportedSkipped = lastSkippedRows;
  }
  const message = lastCompressedError ? String(lastCompressedError.message ?? lastCompressedError) : null;
  if (message !== reportedCompressed) {
    if (message) {
      logger?.warn?.(
        `[dsh-g-memory] compressed index unusable (${message}); served the uncompressed copy`,
      );
    }
    reportedCompressed = message;
  }
}

/**
 * Read an index, preferring the compressed copy.
 * @param {string} dir
 * @returns {Promise<MemoryIndex>}
 */
export async function readIndex(dir) {
  lastCompressedError = null;
  const rawPath = join(dir, 'index.ndjson');
  const compressedPath = join(dir, 'index.ndjson.zstd');
  if (existsSync(compressedPath)) {
    try {
      const out = await runZstdCli(['-d', '-c', '--no-progress', compressedPath], null, MAX_INDEX_BYTES);
      return deserializeIndex(out.toString('utf8'));
    } catch (error) {
      // Falling back is right; doing it silently is not. Without this the user
      // gets stale or empty memory and no way to learn why.
      lastCompressedError = error;
    }
  }
  if (!existsSync(rawPath)) {
    const why = lastCompressedError ? ` (compressed copy unusable: ${lastCompressedError.message})` : '';
    throw new Error(`no index found in ${dir}${why}; build it with: dsh-g-memory build`);
  }
  return deserializeIndex(await readFile(rawPath, 'utf8'));
}

/**
 * Default on-disk location for the index.
 *
 * `DSH_G_MEMORY_INDEX_DIR` overrides it, and the CLI reports the directory it
 * used so a build and a recall can never silently disagree about which index
 * they mean.
 *
 * @param {string} [home]
 * @returns {string}
 */
export function defaultIndexDir(home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')) {
  if (process.env.DSH_G_MEMORY_INDEX_DIR) return process.env.DSH_G_MEMORY_INDEX_DIR;
  return join(home, 'dsh-g-memory', 'index');
}

/** Normalise a query the same way the embedder sees it. */
export function prepareQueryVector(rawVector) {
  return l2Normalize(rawVector);
}

