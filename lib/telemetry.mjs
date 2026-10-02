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
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 */
export function record(event, detail = {}) {
  const target = process.env.DSH_G_MEMORY_AUTO_STATS || defaultStatsPath();
  if (!target) return;
  try {
    appendFile(target, `${JSON.stringify({ t: Date.now(), event, ...detail })}\n`, { mode: 0o600 })
      .catch(() => {});
  } catch { /* measuring must never break the thing being measured */ }
}
