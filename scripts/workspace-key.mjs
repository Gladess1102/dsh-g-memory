#!/usr/bin/env node
/**
 * Where would DSH keep the sessions of a given workspace?
 *
 * A DSH session is stored at `$DSH_HOME/sessions/<key>/<session id>/session*.jsonl.zst`,
 * where `<key>` is derived from the session's working directory. This prints that
 * key for a directory, and what is already there — the question "are this
 * project's conversations grouped, and does the memory index see them?" answered
 * without reading the harness's source.
 *
 * The rule is transcribed from `dsh-session-persistence-jsonl`'s `projectKey`:
 * separators (`/ \ :`) collapse to `-`, `[A-Za-z0-9._-]` stays as-is, every other
 * code unit becomes `~XXXX` (uppercase hex), leading dashes are dropped, an empty
 * result becomes `root`, and the whole thing is wrapped in `--…--`. Verified
 * against this machine: the derived key equalled the real directory name for
 * **10 of 10** sessions that have a readable log header.
 *
 * Usage:
 *   node scripts/workspace-key.mjs                 # this repository's directory
 *   node scripts/workspace-key.mjs /some/other/dir
 *   node scripts/workspace-key.mjs --sessions DIR  # a different DSH home's sessions
 *
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The project directory key for a working directory.
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Session directories under one project key, newest first. */
function sessionsIn(sessionsRoot, key) {
  const dir = join(sessionsRoot, key);
  if (!existsSync(dir)) return { dir, exists: false, sessions: [] };
  const sessions = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const logs = readdirSync(full).filter((f) => /^session(?:\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
    if (logs.length === 0) continue;
    let mtime = 0;
    for (const log of logs) mtime = Math.max(mtime, statSync(join(full, log)).mtimeMs);
    sessions.push({ name, mtime });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { dir, exists: true, sessions };
}

/** Which of those session directories the memory index already holds units for. */
async function indexedLocators(indexDir) {
  try {
    const { readIndex } = await import('../lib/store.mjs');
    const index = await readIndex(indexDir);
    return new Set(index.data.units.map((u) => u.session));
  } catch {
    return null; // no index yet is not an error here
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let sessionsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  let target = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sessions') { sessionsRoot = resolve(argv[++i] ?? ''); continue; }
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node scripts/workspace-key.mjs [DIR] [--sessions DIR]');
      return;
    }
    target = argv[i];
  }
  const cwd = target === '' ? resolve(import.meta.dirname, '..') : resolve(target);
  const key = projectKey(cwd);
  const { dir, exists, sessions } = sessionsIn(sessionsRoot, key);

  console.log(`workspace    ${cwd}`);
  console.log(`sessions key ${key}`);
  console.log(`store        ${dir}${exists ? '' : '   (does not exist yet: no session has run in this workspace)'}`);
  console.log(`sessions     ${sessions.length}`);
  if (sessions.length > 0) {
    const indexed = await indexedLocators(process.env.DSH_G_MEMORY_INDEX || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-g-memory', 'index'));
    if (indexed === null) {
      console.log('indexed      unknown (no readable index)');
    } else {
      const known = sessions.filter((s) => indexed.has(s.name)).length;
      console.log(`indexed      ${known}/${sessions.length} session directories have units in the memory index`);
      const missing = sessions.filter((s) => !indexed.has(s.name));
      if (missing.length > 0) {
        console.log('             not yet indexed: ' + missing.slice(0, 5).map((s) => s.name).join(', ')
          + (missing.length > 5 ? ` … (+${missing.length - 5})` : ''));
        console.log('             (a session with no units is either empty, too new, or still inside the quiet window)');
      }
    }
  }
  console.log('');
  console.log('To use it: open this directory as the workspace for a new session. Sessions already');
  console.log(`stored elsewhere are not moved by this script; if they are moved into ${key},`);
  console.log('their units stay valid (a locator is the session directory name), and the live index');
  console.log('re-reads them once because its watermarks are keyed by absolute path.');
}

if (import.meta.filename === process.argv[1]) await main();
