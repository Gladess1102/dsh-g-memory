/**
 * Live index updates: keep the transcript layer current without a manual build.
 *
 * Why this exists. The index used to be refreshed only by `bin build`, and a week
 * of real use showed the cost: nobody runs a command, and the transcript layer
 * silently goes stale — measured 2026-10-02, seven days without a build left 19
 * sessions / 17 MB unindexed while every health signal stayed green. Recall kept
 * "working" from an index that had stopped growing.
 *
 * What the references do, read rather than guessed:
 *   - VCP (upstream `KnowledgeBaseManager.js`): `chokidar` watchers, a 1s batch
 *     window, a per-path *generation* so only strictly newer events are accepted,
 *     deferred index saves, a catch-up refresh shortly after startup, and a full
 *     rebuild only when the native engine's artifact signature changes. Nothing
 *     runs a periodic rebuild.
 *   - The DSH plugin ecosystem (`dsh-mnemon`, `dsh-mnemosyne`,
 *     `@openviking/dsh-memory-plugin`, `dsh-experience-memory`): capture on
 *     `session/event`, finalize on `agent/turn-stopping` / `session/disposed`,
 *     recall on `agent/pre-step`, with the expensive work debounced.
 *
 * So the shape here is: session events mark it dirty (cheap, no I/O), a debounced
 * tick does the work, and only sessions whose logs actually changed are re-read —
 * plus only the events after the stored watermark. That last part is what makes it
 * affordable: a no-change rebuild of this index measured 33s (20s of it CPU)
 * because it re-reads and re-parses every session log. A full rebuild on a timer
 * is therefore not an option, and a delta-file format is not needed either, now
 * that the index compresses at level 9 (same size as level 19, 28x faster:
 * 18.3 MB in 0.45s instead of 12.5s).
 *
 * It never throws into a turn: every failure is logged and left for the next pass.
 * It never fights a manual build: both take the same lock file.
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryIndex, defaultIndexDir, readIndex, writeIndex } from './store.mjs';
import { decompressZstdFile, extractUnits, EXTRACTOR_VERSION } from './session-source.mjs';
import { embedBatch, resolveConfig } from './embedder.mjs';
import { l2Normalize, packVector, quantizeInt8 } from './vector.mjs';
import { boolEnv, numberEnv } from './env.mjs';
import { record } from './telemetry.mjs';

/** Defaults, each one justified by the measurement in the header. */
/**
 * Defaults, read at call time.
 *
 * This used to be a module-level constant, which froze whatever the environment
 * held at import. `DSH_G_MEMORY_*` is how the CLI, the eval scripts and the
 * tests configure the package, so a later `process.env` change — a test
 * stubbing an endpoint, a shell that exports a different URL — silently did
 * nothing. That is the same shape that shipped a dead embedding endpoint in
 * 0.9.1; the embedder was fixed then, the rest of the config surface was not.
 *
 * @returns the defaults for this call, environment included.
 */
export function defaultLiveConfig() {
  return {
    enabled: boolEnv('DSH_G_MEMORY_LIVE', true),
    debounceMs: numberEnv('DSH_G_MEMORY_LIVE_DEBOUNCE_MS', 30_000, { min: 5_000 }),
    quietMs: numberEnv('DSH_G_MEMORY_LIVE_QUIET_MS', 90_000, { min: 0 }),
    maxUnitsPerTick: numberEnv('DSH_G_MEMORY_LIVE_MAX_UNITS', 400, { min: 10, max: 5_000 }),
    budgetMs: numberEnv('DSH_G_MEMORY_LIVE_BUDGET_MS', 20_000, { min: 1_000 }),
    startupDelayMs: numberEnv('DSH_G_MEMORY_LIVE_STARTUP_MS', 15_000, { min: 0 }),
    batch: numberEnv('DSH_G_MEMORY_LIVE_BATCH', 32, { min: 1, max: 256 }),
    };
}

/** @param {Partial<ReturnType<typeof defaultLiveConfig>>} [overrides] */
export function resolveLiveConfig(overrides = {}) {
  const cfg = { ...defaultLiveConfig() };
  for (const key of Object.keys(defaultLiveConfig())) {
    const value = overrides?.[key];
    if (value === undefined || value === null) continue;
    if (typeof defaultLiveConfig()[key] === 'boolean') cfg[key] = value !== false;
    else if (Number.isFinite(Number(value))) cfg[key] = Number(value);
  }
  return cfg;
}

const PROGRESS_FILE = '.live-progress.json';
/**
 * Which extractor revision the watermarks belong to. Its own file on purpose —
 * see `#readExtractorRevision`.
 */
const EXTRACTOR_FILE = '.live-extractor.json';
const LOCK_FILE = '.index.lock';
/** A lock older than this belonged to a process that died mid-write. */
const STALE_LOCK_MS = 15 * 60_000;

/**
 * Every session log under a DSH home, newest version per directory.
 *
 * Mirrors the builder's rule: a directory holding both `session.v3` and
 * `session.v4` yields the v4 file only, because the older one is a prefix of it.
 *
 * @param {string} root
 * @param {{ limit?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function listSessionLogs(root, options = {}) {
  const limit = options.limit ?? 0;
  /** @type {string[]} */
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4 || (limit && found.length >= limit)) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    /** @type {{ file: string, version: number } | null} */
    let newest = null;
    for (const entry of entries) {
      if (limit && found.length >= limit) break;
      // A symlink is not followed, for the same reason the CLI's walker does not
      // follow one: this is meant to read this DSH home and nothing else, and a
      // link can point anywhere. The rule was dropped when this walker was written
      // and restored when a review asked what `transcriptFor` had lost by switching
      // to it — the old inline implementation had skipped links explicitly.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name);
      if (!match) continue;
      const version = Number(match[1] ?? 0);
      if (newest === null || version > newest.version) newest = { file: full, version };
    }
    if (newest) found.push(newest.file);
  }
  await walk(root, 0);
  return found;
}

/** Read a session log, compressed or not (tests write plain JSONL). */
async function readLog(file) {
  return file.endsWith('.zstd') ? decompressZstdFile(file) : readFile(file, 'utf8');
}

export class LiveIndex {
  /**
   * @param {{ on: Function, logger?: { debug?: Function, warn?: Function } }} ctx
   * @param {{ indexDir?: string, embed?: object, liveIndex?: object, home?: string,
   *           embedFn?: (texts: string[]) => Promise<number[][]> }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.cfg = resolveLiveConfig(options.liveIndex);
    this.indexDir = options.indexDir || defaultIndexDir();
    this.sessionsRoot = join(
      options.home || process.env.DSH_HOME || join(homedir(), '.dsh'),
      'sessions',
    );
    this.embedConfig = options.embed;
    this.embedFn = options.embedFn ?? null;
    this.progressPath = join(this.indexDir, PROGRESS_FILE);
    this.extractorPath = join(this.indexDir, EXTRACTOR_FILE);
    this.lockPath = join(this.indexDir, LOCK_FILE);
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.busy = false;
    this.dirty = false;
    /** @type {string[]} */
    this.disposers = [];
    /** Warnings that should not repeat every pass. @type {Set<string>} */
    this.warned = new Set();
  }

  /** Register the listeners and the debounced worker. @returns {() => void} */
  attach() {
    const onEvent = (session, event) => {
      // The hot path decides only whether a later pass is worth running: no I/O,
      // no parsing, no state beyond one boolean.
      if (event && event.type === 'turn/end') this.dirty = true;
    };
    const onDisposed = () => { this.dirty = true; };

    this.disposers.push(
      this.ctx.on('session/event', onEvent),
      this.ctx.on('session/disposed', onDisposed),
    );

    this.timer = setInterval(() => { void this.runOnce(); }, this.cfg.debounceMs);
    this.timer.unref?.();

    // Catch up shortly after startup, the way VCP refreshes derived data once its
    // engine is up: a host that was off for a day is current within seconds of
    // coming back, not at the next manual build.
    const kick = setTimeout(() => { void this.runOnce(); }, this.cfg.startupDelayMs);
    kick.unref?.();
    this.disposers.push(() => clearTimeout(kick));

    return () => this.dispose();
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose?.(); } catch { /* teardown must not throw */ }
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger?.warn?.(`[dsh-g-memory] ${message}`);
  }

  async #acquireLock() {
    try {
      const handle = await open(this.lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return this.lockPath;
    } catch {
      try {
        const info = await stat(this.lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await unlink(this.lockPath);
          return this.#acquireLock();
        }
      } catch { /* vanished between the open and the stat: try once more below */ }
      return null;
    }
  }

  async #readProgress(index) {
    const empty = { version: 1, model: index.data.model, dim: index.dim, sessions: {} };
    try {
      const parsed = JSON.parse(await readFile(this.progressPath, 'utf8'));
      if (parsed?.model !== index.data.model || parsed?.dim !== index.dim) return empty;
      return { ...empty, sessions: parsed.sessions ?? {} };
    } catch {
      return empty;
    }
  }

  /**
   * Which extractor revision wrote the current watermarks, from its own file.
   *
   * Deliberately *not* a field in the progress file. The progress file is
   * read-modify-written by whatever process is running — including a process
   * started before this concept existed, whose writer rebuilds the object from the
   * fields it knows and drops the rest. Measured on this machine while an older
   * host was still running: the marker was stripped every ~30 s, the next pass saw
   * "unknown revision", and every pass re-read all 107 logs (3.1 s each, silently —
   * a pass that adds nothing writes no telemetry). A file only this code writes has
   * no such failure mode.
   *
   * @returns {Promise<number|null>} the revision, or null when unknown
   */
  async #readExtractorRevision() {
    try {
      const parsed = JSON.parse(await readFile(this.extractorPath, 'utf8'));
      return Number.isInteger(parsed?.extractor) ? parsed.extractor : null;
    } catch {
      return null; // absent is the same as unknown: re-read once, then record it
    }
  }

  async #writeExtractorRevision() {
    const tmp = `${this.extractorPath}.tmp-${process.pid}`;
    await mkdir(this.indexDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify({ extractor: EXTRACTOR_VERSION })}\n`, { mode: 0o600 });
    await rename(tmp, this.extractorPath);
  }

  /**
   * Watermarks that force a full re-read of every log.
   *
   * `mtimeMs: 0` and `lastSeq: 0` both point at the beginning: the mtime check
   * cannot skip the log, and extraction starts from the first event. Used when the
   * extractor's rules change, because a watermark is only valid for the rule that
   * set it.
   *
   * @param {MemoryIndex} index
   * @param {string[]} logs
   */
  async #seedForRescan(index, logs) {
    /** @type {Record<string, { mtimeMs: number, lastSeq: number }>} */
    const sessions = {};
    for (const log of logs) sessions[log] = { mtimeMs: 0, lastSeq: 0 };
    this.ctx.logger?.debug?.(
      `[dsh-g-memory] live index: extractor revision changed to ${EXTRACTOR_VERSION}; `
      + `re-reading ${logs.length} session log(s) from the start (already-indexed text is skipped by hash)`,
    );
    return { version: 1, model: index.data.model, dim: index.dim, sessions };
  }

  /**
   * Watermarks for a machine that has an index but no progress file yet.
   *
   * `mtimeMs` is seeded with the index's own build time: a log not touched since
   * the build cannot hold anything the index is missing, and one touched since is
   * read from the last seq that *is* indexed (not from zero), so a stale index
   * heals without re-embedding what it already has.
   */
  async #seedFromIndex(index, logs) {
    const lastSeqByLabel = new Map();
    for (const unit of index.data.units) {
      const label = unit.session;
      const seq = Number(unit.seq) || 0;
      if (!label || !seq) continue;
      if (seq > (lastSeqByLabel.get(label) ?? 0)) lastSeqByLabel.set(label, seq);
    }
    const sessions = {};
    const builtAt = Number(index.data.builtAt) || 0;
    for (const log of logs) {
      const label = basename(join(log, '..'));
      sessions[log] = { mtimeMs: builtAt, lastSeq: lastSeqByLabel.get(label) ?? 0 };
    }
    this.ctx.logger?.debug?.(`[dsh-g-memory] live index: seeded ${logs.length} session watermark(s) from the index built at ${new Date(builtAt).toISOString()}`);
    return { version: 1, model: index.data.model, dim: index.dim, sessions };
  }

  async #writeProgress(progress) {
    const tmp = `${this.progressPath}.tmp-${process.pid}`;
    await mkdir(this.indexDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(progress)}\n`, { mode: 0o600 });
    await rename(tmp, this.progressPath);
  }

  async #embed(texts) {
    if (this.embedFn) return this.embedFn(texts);
    const config = resolveConfig(this.embedConfig);
    /** @type {number[][]} */
    const out = [];
    for (let i = 0; i < texts.length; i += this.cfg.batch) {
      const slice = texts.slice(i, i + this.cfg.batch);
      out.push(...(await embedBatch(slice, config)));
    }
    return out;
  }

  /**
   * One bounded pass. Safe to call at any time; overlapping calls are ignored.
   *
   * @param {{ force?: boolean }} [options] force ignores the quiet window (tests, CLI)
   * @returns {Promise<{ skipped?: string, sessions?: number, units?: number, relabelled?: number, ms?: number }>}
   */
  async runOnce(options = {}) {
    if (!this.cfg.enabled) return { skipped: 'disabled' };
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    const startedAt = Date.now();
    let held = null;
    try {
      held = await this.#acquireLock();
      // A manual build holds the same lock; whichever starts second waits its turn.
      if (!held) return { skipped: 'locked' };

      const index = await readIndex(this.indexDir).catch((error) => {
        this.#warnOnce('read', `live index paused: cannot read the index (${error?.message || error})`);
        return null;
      });
      if (!index) return { skipped: 'no-index' };

      const embedModel = resolveConfig(this.embedConfig).model;
      if (index.data.model !== embedModel) {
        this.#warnOnce('model', `live index paused: index holds ${index.data.model}, configured ${embedModel} — run a full build`);
        return { skipped: 'model-mismatch' };
      }

      let progress = await this.#readProgress(index);
      const logs = await listSessionLogs(this.sessionsRoot);
      // First pass after this feature lands: seed from the index that is already
      // there rather than re-reading a corpus that was just built. Each log's
      // watermark starts at the build time and at the highest seq the index holds
      // for it, so only what arrived *after* the build is read — and a log the build
      // never saw (mtime newer than builtAt) is read from its own last indexed seq.
      // Watermarks are only valid for the rule that set them, so an unknown or
      // different revision re-reads every log from zero — see `#seedForRescan`.
      // Dedup by content hash makes that a re-read rather than a re-embed.
      const revision = await this.#readExtractorRevision();
      if (revision !== EXTRACTOR_VERSION) {
        progress = await this.#seedForRescan(index, logs);
      } else if (Object.keys(progress.sessions).length === 0) {
        progress = await this.#seedFromIndex(index, logs);
      }
      /**
       * Indexed units by content hash.
       *
       * A Set of hashes answered "have I seen this text?" but not "…and is it
       * labelled the same?", and the difference is a permanent defect rather than a
       * cosmetic one: dedup is by `contentHash(text)` alone, so once a unit's role
       * has been stored wrongly, every later re-read skips it and the wrong role
       * survives every rebuild. That is not hypothetical — an index written by a
       * version whose role whitelist did not know `action` reads back with those
       * units relabelled `tool`, and the label is exactly what tells the model
       * whether it is looking at a past tool call or at conversation.
       *
       * @type {Map<string, { role: string }>}
       */
      const byHash = new Map();
      for (const unit of index.data.units) if (!byHash.has(unit.hash)) byHash.set(unit.hash, unit);
      /** Roles corrected on this pass, counted separately from new units. */
      let relabelled = 0;
      /** @type {{ text: string, role: string, session: string, seq: number, time: number, hash: string }[]} */
      const fresh = [];
      /** @type {object[]} */
      const pending = [];
      let scanned = 0;

      for (const log of logs) {
        if (Date.now() - startedAt > this.cfg.budgetMs) break;
        if (pending.length >= this.cfg.maxUnitsPerTick) break;
        let info;
        try { info = await stat(log); } catch { continue; }
        const seen = progress.sessions[log];
        if (!options.force) {
          if (seen && info.mtimeMs <= seen.mtimeMs) continue;         // unchanged since last pass
          if (Date.now() - info.mtimeMs < this.cfg.quietMs) continue;  // still being written
        }
        scanned += 1;
        let jsonl;
        try { jsonl = await readLog(log); } catch (error) {
          this.#warnOnce(`read:${log}`, `cannot read ${basename(log)}: ${error?.message || error}`);
          continue;
        }
        const { units, stats } = extractUnits(jsonl, {
          session: basename(join(log, '..')),
          fromSeq: seen?.lastSeq ?? 0,
        });
        // The per-tick cap can fall inside a single log, and the log's own `lastSeq`
        // is past units this pass did not take. Advancing to it anyway — which is
        // what this did — marked those units as processed while dropping them: the
        // mtime moved too, so no later pass would look again, and the loss was
        // silent and permanent. Measured with three 4-unit logs and a cap of 2, the
        // index settled at 4 of 12 units and never converged.
        //
        // So a truncated log keeps its old watermark *and* its old mtime: the
        // watermark sits at the last unit actually taken, and the mtime stays
        // behind the file so the next pass reads the rest.
        let truncated = false;
        let taken = 0;
        for (const unit of units) {
          if (fresh.length >= this.cfg.maxUnitsPerTick) { truncated = true; break; }
          const existing = byHash.get(unit.hash);
          if (existing !== undefined) {
            // The text is already indexed; its role can still be wrong. The log is
            // the authority on what a unit *is*, so a re-read corrects the row in
            // place. Counting it separately matters: a pass that only repairs roles
            // must still write the index, and must not look like "0 units" in the
            // telemetry while having changed 1,700 rows.
            if (existing.role !== unit.role) {
              existing.role = unit.role;
              relabelled += 1;
            }
            continue;
          }
          byHash.set(unit.hash, unit);
          fresh.push(unit);
          taken = Math.max(taken, Number(unit.seq) || 0);
        }
        pending.push(truncated
          ? { log, mtimeMs: seen?.mtimeMs ?? 0, lastSeq: Math.max(seen?.lastSeq ?? 0, taken) }
          : { log, mtimeMs: info.mtimeMs, lastSeq: Math.max(seen?.lastSeq ?? 0, stats.lastSeq ?? 0) });
      }

      // Vectors for the new units only; the existing ones are already in the index.
      if (fresh.length > 0) {
        const vectors = await this.#embed(fresh.map((unit) => unit.text));
        if (vectors.length !== fresh.length) throw new Error(`embedder returned ${vectors.length} vectors for ${fresh.length} units`);
        for (let i = 0; i < fresh.length; i += 1) {
          const raw = vectors[i];
          if (raw.length !== index.dim) throw new Error(`dimension drift: got ${raw.length}, expected ${index.dim}`);
          const { codes, scale } = quantizeInt8(l2Normalize(Float32Array.from(raw)));
          fresh[i].vector = packVector(codes, scale);
        }
      }

      const sorted = [...index.data.units, ...fresh]
        .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
      // A pass that only corrected roles still has to be written: the correction
      // lives in the same rows, and skipping the write would drop it while the
      // watermark advanced past the log that produced it.
      if (fresh.length > 0 || relabelled > 0) {
        await writeIndex(this.indexDir, new MemoryIndex({ ...index.data, builtAt: Date.now(), units: sorted }));
      }

      for (const entry of pending) {
        progress.sessions[entry.log] = { mtimeMs: entry.mtimeMs, lastSeq: entry.lastSeq };
      }
      progress.model = index.data.model;
      progress.dim = index.dim;
      await this.#writeProgress(progress);
      // Written on every pass, so it exists as soon as this version has run once.
      // A failure here must not lose the pass: the worst case is one more re-read.
      await this.#writeExtractorRevision().catch((error) => {
        this.#warnOnce('extractor', `could not record the extractor revision: ${error?.message || error}`);
      });

      if (fresh.length > 0 || relabelled > 0) {
        record('live-index', { sessions: scanned, units: fresh.length, relabelled, total: sorted.length, ms: Date.now() - startedAt });
        this.ctx.logger?.debug?.(
          `[dsh-g-memory] live index: +${fresh.length} units, ${relabelled} role(s) corrected `
          + `from ${scanned} session(s) in ${Date.now() - startedAt}ms`,
        );
      }
      this.dirty = false;
      return { sessions: scanned, units: fresh.length, relabelled, ms: Date.now() - startedAt };
    } catch (error) {
      // A failure here must never reach a turn; the next pass retries.
      this.#warnOnce(`run:${error?.message || error}`, `live index pass failed: ${error?.message || error}`);
      record('live-index-error', { message: String(error?.message || error).slice(0, 200) });
      return { skipped: 'error' };
    } finally {
      if (held) await unlink(held).catch(() => {});
      this.busy = false;
    }
  }
}

/** Where the live worker keeps its per-log watermarks; exported for tests. */
export function progressPathFor(indexDir) {
  return join(indexDir, PROGRESS_FILE);
}

/** Where the extractor revision is recorded; exported for tests. */
export function extractorPathFor(indexDir) {
  return join(indexDir, EXTRACTOR_FILE);
}


