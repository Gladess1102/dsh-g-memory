/**
 * The plugin's decision log: one JSON line per event, for measuring what the
 * automatic path actually does.
 *
 * On by default, at `defaultStatsPath()`; `DSH_G_MEMORY_AUTO_STATS` only moves it.
 * It used to be off unless that variable was set, and only the web launcher
 * exported it — so a host launched by the desktop app wrote no telemetry at all,
 * and a plugin with no gate events, no injections and no errors reads exactly like
 * a plugin that is dead. The default path is why the file has a size cap below:
 * one line per model step, on every host, for months.
 *
 * Every write is fire-and-forget: measuring must never affect the thing measured.
 */
import { appendFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the decision log goes when the environment does not name a path. */
export function defaultStatsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-g-memory', 'auto-recall-stats.jsonl');
}

/**
 * Ambient fields every event carries.
 *
 * The log used to be anonymous. `DSH_G_MEMORY_AUTO_STATS` is inherited by every
 * process the launcher starts, so the DSH host, the ZCode host and any CLI all
 * append to one file with nothing to tell their events apart — attribution had
 * to be redone by replaying session logs, which is what the 2026-10-13
 * investigation spent its first hour on. Two cheap fields remove that.
 *
 * Read per call rather than cached: one host can serve several workspaces, and a
 * process started before a session existed still writes afterwards.
 */
let sessionId = '';

/** @param {string} id session/agent id; trimmed to what the log needs */
export function setTelemetrySession(id) {
  sessionId = String(id ?? '').slice(0, 24);
}

/**
 * Cap on the decision log before it is rotated to `<path>.1`.
 *
 * The file is append-only and gets one line per model step from every host, so
 * nothing bounded it: measured 2026-11-04, `auto-recall-stats.jsonl` held 29,382
 * lines / 3.7 MB and was still growing. One previous generation is kept, so the
 * disk cost is at most twice this.
 */
export const MAX_STATS_BYTES = 8 * 1024 * 1024;

/** Bytes appended per log file, seeded from disk on that file's first write. */
const written = new Map();
/** Serialises append and rotate, so a rotation cannot split a write. */
let chain = Promise.resolve();

/**
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 */
export function record(event, detail = {}) {
  const target = process.env.DSH_G_MEMORY_AUTO_STATS || defaultStatsPath();
  if (!target) return;
  try {
    const cwd = process.cwd();
    const ambient = { cwd, ...(sessionId ? { session: sessionId } : {}) };
    const line = `${JSON.stringify({ t: Date.now(), event, ...ambient, ...detail })}\n`;
    chain = chain.then(() => append(target, line)).catch(() => {});
  } catch { /* measuring must never break the thing being measured */ }
}

/**
 * Append one line, rotating the log first when it is past its cap.
 *
 * The size is seeded from the file on this process's first write (several hosts
 * append to one path, and the file outlives any one of them) and tracked in
 * memory afterwards. A rotation replaces the previous generation, `<path>.1`.
 *
 * @param {string} target
 * @param {string} line
 */
async function append(target, line) {
  const bytes = Buffer.byteLength(line);
  if (!written.has(target)) {
    written.set(target, await stat(target).then((info) => info.size).catch(() => 0));
  }
  if (written.get(target) + bytes > MAX_STATS_BYTES) {
    await rename(target, `${target}.1`).catch(() => {});
    written.set(target, 0);
  }
  await appendFile(target, line, { mode: 0o600 });
  written.set(target, written.get(target) + bytes);
}
