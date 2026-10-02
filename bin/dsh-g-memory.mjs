#!/usr/bin/env node
/**
 * dsh-g-memory CLI — build, inspect and query the cross-session memory index.
 *
 * Usage:
 *   dsh-g-memory build   [--out DIR] [--no-tool] [--limit N]
 *   dsh-g-memory stats   [--out DIR]
 *   dsh-g-memory recall  "query" [--top N] [--out DIR]
 *   dsh-g-memory selfcheck
 *   dsh-g-memory plugincheck
 *
 * SPDX-License-Identifier: MIT
 */

import { open, readdir, stat, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Write a checkpoint header atomically.
 *
 * The header records the model and dimension, because a checkpoint is a cache of
 * vectors and a vector only means something in the space that produced it. Written
 * through a temp file so a crash cannot leave a half-written header behind — the
 * rest of the file is append-only, so a torn line costs one vector and no more.
 */
async function writeCheckpointHeader(path, model, dim) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ kind: 'checkpoint', model, dim })}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractUnits, decompressZstdFile } from '../lib/session-source.mjs';
import { embedAdaptive, embedBatch, probe, resolveConfig } from '../lib/embedder.mjs';
import { l2Normalize, quantizeInt8, packVector } from '../lib/vector.mjs';
import { findSchemaValidator } from '../lib/harness.mjs';
import { parseCard, readCards, writeCards, withVector, formatCard, tagIndex, defaultCardPath } from '../lib/cards.mjs';
import { DEFAULT_SYNTHESIS } from '../lib/synthesize.mjs';
import {
  INDEX_VERSION, MemoryIndex, defaultIndexDir, readIndex, writeIndex, prepareQueryVector,
} from '../lib/store.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..');

function parseArgs(argv) {
  const args = { _: [] };
  /**
   * Read the value that follows a flag.
   *
   * It used to be `argv[++i]` with no check, so `stats --out --fresh` consumed
   * `--fresh` as the output directory (and a `build` would have written a 30 MB
   * index into a directory literally named `--fresh`, silently losing the flag).
   * A flag is never a value.
   */
  const value = (flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    i += 1;
    return next;
  };
  /** A count, rejected rather than coerced to NaN — NaN reaches `.slice()` as an
   *  empty result and exit code 0, which is indistinguishable from "no matches". */
  const count = (flag) => {
    const raw = value(flag);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got "${raw}"`);
    return Math.floor(n);
  };
  // Declared outside the loop so `value`/`count` can advance it; block-scoped in
  // the `for` header they were invisible to the closures and every flag threw
  // "i is not defined".
  let i = 0;
  for (; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--no-tool') args.noTool = true;
    else if (token === '--fresh') args.fresh = true;
    else if (token === '--out') args.out = value('--out');
    else if (token === '--limit') args.limit = count('--limit');
    else if (token === '--top') args.top = count('--top');
    // `distill` documented these three and read them, but nothing parsed them, so
    // the error message told the operator to pass a `--url` that could not work.
    else if (token === '--recent') args.recent = count('--recent');
    else if (token === '--model') args.model = value('--model');
    else if (token === '--url') args.url = value('--url');
    else if (token === '--help' || token === '-h') args.help = true;
    else args._.push(token);
  }
  return args;
}

function usage() {
  console.log(`dsh-g-memory — cross-session semantic memory for DeepSeek Harness

  build        Build the index from DSH session logs
               --out DIR   index directory (default: $DSH_HOME/dsh-g-memory/index)
               --no-tool   index conversation only (skips tool results)
               --limit N   index at most N session logs
               --fresh     ignore the previous index and checkpoint; re-embed everything
  stats        Show index composition and on-disk size
  recall       Query the index:  recall "your question" [--top 5] [--out DIR]
  selfcheck    Verify the embedding endpoint and report its dimension
  plugincheck  Load the Host half through a strict fake registry, without
               restarting DSH. Fails when the tool definition is one the real
               registry would reject, which is how memory_recall silently
               disappears from an otherwise healthy harness.

  Environment: DSH_G_MEMORY_* (see README). Index directory can also be set
  with DSH_G_MEMORY_INDEX_DIR.
`);
}

/** Recursively collect session log paths under a root. */


/** One card-writing call. Returns the payload and the text; never throws. */
async function askModel(baseUrl, model, system, user) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.7, top_p: 0.95,
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 1200,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const payload = await res.json();
    return { payload, text: String(payload?.choices?.[0]?.message?.content ?? '') };
  } catch (error) {
    console.error(`     request failed: ${error.message}`);
    return { payload: null, text: '' };
  }
}

/** Session logs, newest first — distillation cares about recency, not path order. */
async function listSessions() {
  const found = await findSessionLogs(sessionsRoot());
  const stamped = [];
  for (const file of found) {
    try { stamped.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.map((s) => s.file);
}

/** The plain text of one session, via the same extractor the index build uses. */
async function sessionText(log) {
  const jsonl = await decompressZstdFile(log);
  const { units } = extractUnits(jsonl, { includeToolResults: true });
  return units.map((u) => u.text).join('\n\n');
}

/**
 * Session logs are versioned, and the version is not decoration: DSH 0.1.7
 * migrates a conversation to `session.v4.jsonl.zstd` on its next write and
 * leaves the old `session.v3.jsonl.zstd` frozen beside it. Matching a fixed
 * name would therefore freeze the memory at the upgrade date — every later
 * conversation stays invisible — while matching both would index the same
 * conversation twice, since the older file is a prefix of the newer one. So a
 * directory contributes exactly its newest log.
 */
const SESSION_LOG = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

async function findSessionLogs(root, limit) {
  /** @type {string[]} */
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4 || (limit && found.length >= limit)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    /** @type {string|null} */
    let newest = null;
    let newestVersion = -1;
    for (const entry of entries) {
      if (limit && found.length >= limit) break;
      const full = join(dir, entry.name);
      // A symlink is not followed: this walker is meant to index this DSH home,
      // and a link can point anywhere.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const match = SESSION_LOG.exec(entry.name);
      if (!match) continue;
      const version = match[1] === undefined ? 0 : Number(match[1]);
      if (version > newestVersion) {
        newestVersion = version;
        newest = full;
      }
    }
    if (newest) found.push(newest);
  }
  await walk(root, 0);
  return found;
}

function sessionsRoot() {
  const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh');
  return join(home, 'sessions');
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function cmdBuild(args) {
  const outDir = args.out ? resolve(args.out) : defaultIndexDir();
  const root = sessionsRoot();
  if (!existsSync(root)) {
    console.error(`no session directory at ${root}`);
    process.exitCode = 1;
    return;
  }

  const cfg = resolveConfig();
  const health = await probe(cfg);
  if (!health.ok) {
    console.error(`embedding endpoint unavailable (${cfg.url}): ${health.error}`);
    console.error('start the local BGE-M3 server, or set DSH_G_MEMORY_EMBED_URL.');
    process.exitCode = 1;
    return;
  }
  console.log(`[embed] ${cfg.url} model=${cfg.model} dim=${health.dim}`);

  const logs = await findSessionLogs(root, args.limit);
  console.log(`[scan] ${logs.length} session log(s) under ${root}`);

  /** @type {Map<string, import('../lib/session-source.mjs').MemoryUnit>} */
  const byHash = new Map();
  const totals = { records: 0, userUnits: 0, assistantUnits: 0, toolUnits: 0, toolSkipped: 0, deduped: 0, chars: 0, fillerSkipped: 0, unparsable: 0 };
  let read = 0;

  for (const log of logs) {
    let jsonl;
    try {
      jsonl = await decompressZstdFile(log);
    } catch (error) {
      console.warn(`[warn] ${log}: ${error.message}`);
      continue;
    }
    // Pass the directory name: it is what a reader can actually open, and it does
    // not vary with the log's format version the way the embedded id does.
    const { units, stats } = extractUnits(jsonl, {
      includeToolResults: !args.noTool,
      session: basename(dirname(log)),
    });
    for (const unit of units) if (!byHash.has(unit.hash)) byHash.set(unit.hash, unit);
    for (const key of Object.keys(totals)) totals[key] += stats[key] || 0;
    read += 1;
    if (read % 10 === 0) console.log(`  read ${read}/${logs.length}, units ${byHash.size}`);
  }

  // Carry over units whose source session no longer exists.
  //
  // `build` used to *replace* the index with whatever the session directory
  // currently holds. Deleting a session therefore deleted its memory on the next
  // build, silently — the run reported `reused` and `embedded` and never
  // mentioned what it had dropped. Under disk pressure, pruning old sessions is
  // the most natural thing a user does, which makes that the likeliest way to
  // lose a memory store without noticing.
  //
  // The units are kept and marked `orphaned`. They are still retrievable and
  // still self-contained (a unit carries its own text), but their `session#seq`
  // locator now points at a file that is gone, so injection must label them as
  // unverifiable rather than implying the original can be re-read.
  let orphaned = 0;
  if (!args.fresh) {
    try {
      const previous = await readIndex(outDir);
      for (const unit of previous.data.units) {
        if (byHash.has(unit.hash)) continue;
        byHash.set(unit.hash, { ...unit, orphaned: true });
        orphaned += 1;
      }
    } catch { /* no previous index, or unreadable: nothing to carry over */ }
  }
  if (orphaned > 0) {
    console.warn(`[orphan] ${orphaned} units kept from sessions that no longer exist on disk`);
    console.warn('         they remain searchable, but their transcripts cannot be re-read');
  }

  const units = [...byHash.values()].sort((a, b) => a.time - b.time);
  // Count roles from the final deduplicated set, not from per-log tallies:
  // identical text can occur in more than one log, so per-log sums overcount.
  const roleCounts = { user: 0, assistant: 0, tool: 0 };
  let chars = 0;
  for (const unit of units) {
    roleCounts[unit.role] = (roleCounts[unit.role] || 0) + 1;
    chars += unit.text.length;
  }
  console.log(`[extract] ${units.length} unique units ` +
    `(user ${roleCounts.user}, assistant ${roleCounts.assistant}, tool ${roleCounts.tool}, ` +
    `tool-skipped ${totals.toolSkipped}, deduped ${totals.deduped}, filler ${totals.fillerSkipped}, ` +
    `unparsable ${totals.unparsable})`);
  console.log(`  composition: ${totals.userUnits} user / ${totals.assistantUnits} assistant / ${totals.toolUnits} tool`);
  console.log(`[extract] ${chars.toLocaleString()} chars`);

  console.log('[embed] embedding units…');
  const started = Date.now();
  // Checkpoint so an interrupted run (endpoint hiccup, bad unit, Ctrl-C) does not
  // discard every embedding computed so far. Keyed by content hash, which also
  // makes the step idempotent across re-runs.
  //
  // It carries the model and dimension that produced it, and a mismatch discards
  // it. A checkpoint is a cache of *vectors*, and a vector is only meaningful in
  // the space that produced it: after a model change at the same width
  // (EmbeddingGemma-768 → nomic-embed-text-768, both listed in the README) an
  // unguarded resume mixes two spaces into one index, and at a different width it
  // silently drops units. The neighbouring "reuse the previous index" path has had
  // this guard from the start; this one did not, and a checkpoint survives any
  // interrupted build because it is only deleted after a successful one.
  const checkpointPath = join(outDir, '.embed-checkpoint.json');
  /** Lookup of already-computed vectors, keyed by content hash. */
  /** @type {Map<string, string>} */
  let known = new Map();
  let checkpointResumed = false;
  if (!args.fresh && existsSync(checkpointPath)) {
    try {
      // Format: a header line, then one `{h,v}` per vector, appended in batches.
      // Line-oriented rather than one JSON document because rewriting the whole
      // file every 250 units is quadratic — ~435 MB written for a 14k-unit build,
      // and ~40 GB at 100k.
      const lines = (await readFile(checkpointPath, 'utf8')).split('\n').filter(Boolean);
      const header = JSON.parse(lines[0]);
      if (header.kind !== 'checkpoint') throw new Error('unrecognised checkpoint format');
      if (header.model !== cfg.model || header.dim !== health.dim) {
        console.warn(
          `[resume] checkpoint was built with ${header.model ?? 'an unknown model'}/${header.dim ?? '?'}d `
          + `but the embedder is ${cfg.model}/${health.dim}d — ignoring it`,
        );
      } else {
        for (const line of lines.slice(1)) {
          try {
            const row = JSON.parse(line);
            if (row && typeof row.h === 'string' && typeof row.v === 'string') known.set(row.h, row.v);
          } catch { /* a torn append costs one vector, not the batch */ }
        }
        checkpointResumed = true;
        console.log(`[resume] checkpoint holds ${known.size} vectors`);
      }
    } catch (error) {
      console.warn(`[resume] checkpoint unreadable (${error.message}), starting fresh`);
    }
  }

  // Seed reuse from the previous index.
  //
  // The index already stores every vector from the last build, in exactly the
  // representation the checkpoint uses — base64 of `[float32 scale][int8 codes]`
  // — so a rebuild only has to embed what is genuinely new. Without this, the
  // checkpoint (deleted after every successful run, by design) was the only
  // reuse source and a corpus that grew by 4% cost a full re-embed: 12,037
  // units, ~27 minutes, for ~1,200 new ones.
  //
  // Reuse is only sound while the vectors are comparable, so the previous index
  // is consulted solely when its model and dimension match the current embedder.
  // After a model change the old vectors mean something else entirely, and
  // recomputing is the only correct answer — which is why the header records
  // both fields.
  let carriedOver = 0;
  if (!args.fresh) {
    try {
      const previous = await readIndex(outDir);
      if (previous.data.model !== cfg.model || previous.dim !== health.dim) {
        console.warn(
          `[reuse] previous index is ${previous.data.model}/${previous.dim}d but the embedder is `
          + `${cfg.model}/${health.dim}d — re-embedding everything`,
        );
        // The model name is a *label*, not the weights: the endpoint ignores it, so
        // renaming an engine (or passing a different string for the same model)
        // lands here and costs a full rebuild. Said out loud because the mistake is
        // silent otherwise, and the fix is one word in the configuration.
        console.warn(
          '  (the name is what the index recorded, not proof of a different model — '
          + 'if the weights are unchanged, build once with the configured name to relabel it)',
        );
      } else {
        for (const unit of previous.data.units) {
          if (unit.hash && !known.has(unit.hash)) {
            known.set(unit.hash, unit.vector.toString('base64'));
            carriedOver += 1;
          }
        }
        console.log(`[reuse] ${carriedOver} vectors carried over from the previous index`);
      }
    } catch (error) {
      // A missing index is the first build; an unreadable one is worth saying out
      // loud, because silently re-embedding is a slow surprise rather than a bug.
      if (existsSync(join(outDir, 'index.ndjson.zstd')) || existsSync(join(outDir, 'index.ndjson'))) {
        console.warn(`[reuse] previous index unreadable (${error.message}); re-embedding everything`);
      }
    }
  }
  /** Only vectors computed in THIS run are persisted to the checkpoint, so the
   *  file stays proportional to the new work rather than to the whole corpus. */
  /** @type {Map<string, string>} */
  const fresh = new Map();

  /** @type {import('../lib/store.mjs').IndexedUnit[]} */
  const indexed = [];
  let reused = 0;
  let sinceSave = 0;
  /** Checkpoint lines accumulated since the last append. */
  /** @type {string[]} */
  const pending = [];

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const cached = known.get(unit.hash);
    if (cached) {
      indexed.push({ ...unit, vector: Buffer.from(cached, 'base64') });
      reused += 1;
    } else {
      const raw = await embedAdaptive(unit.text, cfg);
      if (raw.length !== health.dim) throw new Error(`dimension drift: got ${raw.length}, expected ${health.dim}`);
      const { codes, scale } = quantizeInt8(l2Normalize(raw));
      const packed = packVector(codes, scale);
      indexed.push({ ...unit, vector: packed });
      const encoded = packed.toString('base64');
      known.set(unit.hash, encoded);
      // Only vectors computed in THIS run are persisted, so the checkpoint file
      // stays proportional to the new work rather than to the whole corpus.
      fresh.set(unit.hash, encoded);
      pending.push(JSON.stringify({ h: unit.hash, v: encoded }));
      sinceSave += 1;
      if (sinceSave >= 250) {
        await mkdir(outDir, { recursive: true });
        if (!checkpointResumed) {
          // Header first, written atomically: a checkpoint without a trustworthy
          // header is one the next run has to throw away.
          await writeCheckpointHeader(checkpointPath, cfg.model, health.dim);
          checkpointResumed = true;
        }
        // Appended, not rewritten: the file grows with the new work instead of
        // being rebuilt on every batch.
        await appendFile(checkpointPath, `${pending.join('\n')}\n`, { mode: 0o600 });
        pending.length = 0;
        sinceSave = 0;
      }
    }
    if (i > 0 && i % 200 === 0) {
      const rate = i / ((Date.now() - started) / 1000);
      // `i` is zero-based, so the count processed so far is `i + 1`.
      console.log(`  ${i + 1}/${units.length} (${rate.toFixed(1)} units/s, reused ${reused}, embedded ${i + 1 - reused})`);
    }
  }
  // Flush the tail. Without this, an interruption after the last full batch
  // discards up to 249 freshly computed vectors — the exact loss the checkpoint
  // exists to prevent.
  if (pending.length > 0) {
    try {
      await mkdir(outDir, { recursive: true });
      if (!checkpointResumed) await writeCheckpointHeader(checkpointPath, cfg.model, health.dim);
      await appendFile(checkpointPath, `${pending.join('\n')}\n`, { mode: 0o600 });
      pending.length = 0;
    } catch (error) {
      console.warn(`[resume] could not write the checkpoint tail: ${error.message}`);
    }
  }

  const seconds = (Date.now() - started) / 1000;
  const embedded = units.length - reused;
  console.log(`[embed] done in ${seconds.toFixed(1)}s `
    + `(${(units.length / seconds).toFixed(1)} units/s)`);
  console.log(`  reused ${reused} (${carriedOver} from the previous index, `
    + `${reused - carriedOver} from the resume checkpoint); embedded ${embedded}`);

  const index = new MemoryIndex({
    version: INDEX_VERSION,
    dim: health.dim,
    model: cfg.model,
    builtAt: Date.now(),
    units: indexed,
  });

  // The live worker writes the same files, so both take the same lock. Its pass is
  // bounded to a budget; wait for it rather than racing it.
  const lockPath = join(outDir, '.index.lock');
  for (let waited = 0; ; waited += 1000) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch {
      if (waited >= 60_000) {
        console.error('  ⚠️  另一个索引写入者持有锁（超过 60 秒），仍继续');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  let rawBytes;
  let zstdBytes;
  try {
    ({ rawBytes, zstdBytes } = await writeIndex(outDir, index));
  } finally {
    await rm(lockPath, { force: true });
  }
  await rm(checkpointPath, { force: true });
  console.log(`[write] ${outDir}`);
  console.log(`  index.ndjson       ${fmtBytes(rawBytes)}`);
  console.log(`  index.ndjson.zstd  ${fmtBytes(zstdBytes)} (${(rawBytes / zstdBytes).toFixed(2)}x)`);
  console.log(`  per unit           ${(zstdBytes / indexed.length).toFixed(0)} B`);
}

async function cmdStats(args) {
  const dir = args.out ? resolve(args.out) : defaultIndexDir();
  const index = await readIndex(dir);
  const byRole = { user: 0, assistant: 0, tool: 0 };
  let chars = 0;
  /** @type {Set<string>} */
  const sessions = new Set();
  for (const unit of index.data.units) {
    byRole[unit.role] = (byRole[unit.role] || 0) + 1;
    chars += unit.text.length;
    sessions.add(unit.session);
  }
  const zstdPath = join(dir, 'index.ndjson.zstd');
  const rawPath = join(dir, 'index.ndjson');
  let disk = 0;
  let rawDisk = 0;
  try { disk = (await stat(zstdPath)).size; } catch { /* optional */ }
  try { rawDisk = (await stat(rawPath)).size; } catch { /* optional */ }

  console.log(`index        ${dir}`);
  console.log(`version      ${index.data.version}`);
  console.log(`model        ${index.data.model}`);
  console.log(`dimension    ${index.dim}`);
  console.log(`built        ${new Date(index.data.builtAt).toISOString()}`);
  console.log(`units        ${index.size}`);
  console.log(`  user       ${byRole.user}`);
  console.log(`  assistant  ${byRole.assistant}`);
  console.log(`  tool       ${byRole.tool}`);
  console.log(`sessions     ${sessions.size}`);
  console.log(`chars        ${chars.toLocaleString()}`);
  // Report the space the directory actually consumes, not just the compressed
  // half: the uncompressed fallback copy is roughly twice the compressed size,
  // so quoting only the latter understates the footprint by more than 3x.
  console.log(`disk (zstd)  ${fmtBytes(disk)}`);
  if (rawDisk > 0) {
    console.log(`disk (raw)   ${fmtBytes(rawDisk)}`);
    console.log(`disk (total) ${fmtBytes(disk + rawDisk)}`);
  }
}

async function cmdRecall(args) {
  const query = args._.join(' ').trim();
  if (!query) { usage(); process.exitCode = 1; return; }
  const dir = args.out ? resolve(args.out) : defaultIndexDir();
  const top = args.top ?? 5;
  const cfg = resolveConfig();

  const index = await readIndex(dir);
  console.log(`[index] ${index.size} units, dim ${index.dim}, from ${dir}`);
  console.log(`[query] ${query}\n`);

  const [raw] = await embedBatch([query], cfg);
  const results = index.recall(prepareQueryVector(raw), query, { k: top });
  for (const { index: i, score } of results) {
    const unit = index.unit(i);
    const when = unit.time ? new Date(unit.time).toISOString().slice(0, 16).replace('T', ' ') : '?';
    console.log(`── rrf ${score.toFixed(4)}  [${unit.role}] ${when}  session ${unit.session.slice(0, 20)}`);
    console.log(`   ${unit.text.slice(0, 400)}`);
    console.log();
  }
}

async function cmdSelfcheck() {
  const cfg = resolveConfig();
  console.log(`package      ${pkgRoot}`);
  console.log(`embed url    ${cfg.url}`);
  console.log(`embed model  ${cfg.model}`);
  const health = await probe(cfg);
  if (health.ok) {
    console.log(`endpoint     OK, dim ${health.dim}`);
  } else {
    console.log(`endpoint     UNAVAILABLE: ${health.error}`);
    process.exitCode = 1;
  }
  const dir = defaultIndexDir();
  console.log(`index dir    ${dir}${existsSync(join(dir, 'index.ndjson.zstd')) ? ' (present)' : ' (not built yet)'}`);
}

/**
 * Load the Host half exactly as the Harness would, against a fake registry that
 * enforces the registry's real preconditions.
 *
 * This exists because the failure it catches is invisible: `apply()` throwing
 * while the plugin loads costs the tool and nothing else — no conversation
 * breaks, no message appears — so a broken mount looks like a healthy harness
 * until someone notices the tool is simply not in the list. Checking here costs
 * a second and needs no restart.
 */
async function loadHarnessValidator() {
  const file = findSchemaValidator();
  if (file === undefined) return null;
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.assertSupportedJsonSchema !== 'function') return null;
    return { assertSupportedJsonSchema: mod.assertSupportedJsonSchema, from: file };
  } catch {
    return null;
  }
}

async function cmdPluginCheck() {
  const harness = await loadHarnessValidator();
  console.log(`package      ${pkgRoot}`);
  console.log(`validator    ${harness === null ? 'NOT FOUND (schema subset unenforced)' : harness.from}`);

  const registered = [];
  const ctx = {
    // Mirrors what an INSTALLED profile plugin can reach: the `tools` SERVICE —
    // not the `harness` builtin, which only the dynamic-plugin evaluator sees.
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        register(tool) {
          const output = tool?.output;
          if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
            throw new TypeError(`tool "${tool?.name}" must declare output { schema, render }`);
          }
          if (harness !== null) {
            harness.assertSupportedJsonSchema(tool.parameters);
            harness.assertSupportedJsonSchema(output.schema);
          }
          registered.push(tool);
          return () => {};
        },
      };
    },
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  };

  const mod = await import(pathToFileURL(join(pkgRoot, 'lib/index.js')).href);
  // `auto: false` keeps this a pure definition check: no listeners, no network.
  mod.apply(ctx, { auto: false });

  const tool = registered.find((t) => t.name === 'memory_recall');
  if (tool === undefined) {
    console.error('result       FAIL — apply() finished but registered no memory_recall');
    process.exitCode = 1;
    return;
  }
  console.log(`plugin       ${mod.name ?? '(unnamed)'}`);
  console.log(`tool         ${tool.name} (timeout ${tool.timeoutMs}ms)`);
  if (harness === null) {
    console.log('result       PARTIAL — tool shape is valid; schema subset unverified');
    process.exitCode = 1;
    return;
  }
  console.log('result       OK — the registry accepts this definition');
}

/**
 * Argument errors are usage errors, not crashes: report them the way every other
 * failure is reported and exit 1, rather than letting the stack trace escape the
 * `try` below (which only wraps the commands).
 */
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const command = args._.shift();

/**
 * Write durable memory cards for sessions.
 *
 * The one thing this plugin could not do before: remember a session after its
 * transcript is gone. Everything else it stored was a slice of a log file, so
 * the memory was only as durable as the log. A card is self-contained — see
 * lib/cards.mjs for why that is a difference in kind, not degree.
 *
 * This runs the summary through whatever synthesis model is configured, which in
 * a deployment is the *session's own model* at the end of a turn whose context
 * already holds the transcript. Here it is a standalone pass, so the numbers it
 * reports are the pessimistic ones (full input cost, no cache).
 */
async function cmdDistill(args) {
  const limit = Number(args.recent ?? 1);
  const model = args.model || DEFAULT_SYNTHESIS.model;
  const baseUrl = args.url || DEFAULT_SYNTHESIS.baseUrl;
  if (!baseUrl) {
    console.error('distill: no synthesis endpoint configured (set DSH_G_MEMORY_LLM_URL or pass --url)');
    process.exitCode = 1; return;
  }

  const logs = await listSessions();
  const picked = logs.slice(0, limit);
  if (picked.length === 0) { console.error('distill: no sessions found'); process.exitCode = 1; return; }

  const system = [
    '你在为一个编程助手的长期记忆系统写一份**自足**的会话记忆卡。',
    '要求：',
    '1. 只写事实：做了什么、得出什么结论、关键数值/路径/端口/版本/命令、未决问题。',
    '2. 不要客套、不要过程叙述、不要"用户要求…然后我…"。',
    '3. **不要出现"上文/前面/刚才/该会话"这类指代** —— 这张卡脱离原文必须能独立读懂。',
    '4. 正文控制在 400 字以内。',
    '5. 最后单独一行输出 `Tag: ` 加 3-6 个稳定标签，用逗号分隔；标签要能被复用，'
      + '不要为每次会话发明新词。',
  ].join('\n');

  const cards = [];
  for (const log of picked) {
    const text = await sessionText(log);
    if (text.length < 200) { console.log(`  skip ${log.slice(0, 12)}: too short`); continue; }
    const t0 = Date.now();
    let payload = null;
    // Retry with a smaller transcript before giving up. A 2B stand-in returns an
    // empty completion — not an error — on a transcript longer than it can hold,
    // so a single attempt reports "nothing usable" for a session that is merely
    // long. In a deployment this pass belongs to the session's own model, which
    // already holds the transcript and pays output tokens only.
    for (const budget of [24_000, 10_000, 4_000]) {
      const attempt = await askModel(baseUrl, model, system, `会话原文：\n\n${text.slice(0, budget)}`);
      if (attempt.text.trim() !== '') { payload = attempt.payload; break; }
      if (text.length <= budget) break;
      console.log(`     empty at ${budget} chars, retrying smaller`);
    }
    if (payload === null) {
      console.error(`  ✗ ${log.slice(0, 16)}: model returned nothing usable`);
      continue;
    }
    const answer = payload?.choices?.[0]?.message?.content;
    const card = parseCard(answer, { session: log, time: Date.now(), model });
    if (card === null) {
      console.error(`  ✗ ${log.slice(0, 12)}: model returned nothing usable `
        + `(${payload?.usage?.completion_tokens ?? 0} tokens)`);
      continue;
    }
    const [vec] = await embedBatch([card.summary], resolveConfig());
    cards.push(withVector(card, vec));
    const u = payload.usage ?? {};
    console.log(`  ✓ ${log.slice(0, 16)}  ${text.length}→${card.summary.length} 字符  `
      + `in ${u.prompt_tokens ?? '?'} / out ${u.completion_tokens ?? '?'} tok  `
      + `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log(`     ${formatCard(card)}`);
  }

  if (cards.length === 0) { console.error('distill: nothing stored'); process.exitCode = 1; return; }
  const { total, added } = await writeCards(cards);
  console.log(`\n  card store ${defaultCardPath()}: +${added} → ${total} cards`);
  const tags = tagIndex(await readCards()).slice(0, 12);
  if (tags.length) console.log(`  top tags: ${tags.map(([t, n]) => `${t}(${n})`).join(' ')}`);
}

if (args.help) { usage(); process.exit(0); }
if (!command) {
  // No command is a usage error, so it exits non-zero exactly as an unknown
  // command does. `--help` is the explicit way to ask for usage and succeed.
  usage();
  process.exitCode = 1;
} else try {
  if (command === 'build') await cmdBuild(args);
  else if (command === 'stats') await cmdStats(args);
  else if (command === 'recall') await cmdRecall(args);
  else if (command === 'distill') await cmdDistill(args);
  else if (command === 'selfcheck') await cmdSelfcheck();
  else if (command === 'plugincheck') await cmdPluginCheck();
  else { usage(); process.exitCode = 1; }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
