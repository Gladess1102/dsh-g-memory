/**
 * The plugin's decision log: one JSON line per event, for measuring what the
 * automatic path actually does.
 *
 * Off unless `DSH_G_MEMORY_AUTO_STATS` names a file, but the default is a real
 * path — only the web launcher used to export that variable, so a host launched
 * by the desktop app wrote no telemetry at all, and a plugin with no gate events,
 * no injections and no errors reads exactly like a plugin that is dead.
 *
 * Every write is fire-and-forget: measuring must never affect the thing measured.
 */
import { appendFile } from 'node:fs/promises';
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
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 */
export function record(event, detail = {}) {
  const target = process.env.DSH_G_MEMORY_AUTO_STATS || defaultStatsPath();
  if (!target) return;
  try {
    const cwd = process.cwd();
    const ambient = { cwd, ...(sessionId ? { session: sessionId } : {}) };
    appendFile(target, `${JSON.stringify({ t: Date.now(), event, ...ambient, ...detail })}\n`, { mode: 0o600 })
      .catch(() => {});
  } catch { /* measuring must never break the thing being measured */ }
}
