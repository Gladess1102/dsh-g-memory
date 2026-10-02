/**
 * Locating the DSH installation from inside a plugin.
 *
 * The offline self-checks (`plugincheck`, the two test entry points) validate
 * this package against the Harness's *own* rules — its JSON-schema subset and
 * its module-resolution contract — rather than against a local copy of those
 * rules that could drift. That means finding the installation.
 *
 * It is found by derivation, not by guessing at well-known prefixes: the
 * running Node's own location is the anchor, because a global `npm install -g`
 * puts `lib/node_modules` beside the `bin` directory holding the interpreter.
 * `DSH_CHECKOUT` overrides it for non-standard layouts.
 *
 * SPDX-License-Identifier: MIT
 */

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Candidate directories that may contain a `@deepseek-ai/dsh` package.
 * @returns {string[]}
 */
export function dshRoots() {
  const roots = [];
  if (process.env.DSH_CHECKOUT) roots.push(process.env.DSH_CHECKOUT);

  // `.../bin/node` → `.../lib/node_modules` covers Homebrew, /usr/local and a
  // plain nvm prefix without naming any of them.
  const binDir = dirname(process.execPath);
  roots.push(join(dirname(binDir), 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  roots.push(join(binDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));

  // The profile's shared fallback, where DSH links the installation's
  // dependency closure.
  const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh');
  roots.push(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'));

  // Last resort: a checkout reachable by ordinary resolution from here. Harmless
  // when it fails, which is why it is last.
  try {
    // fileURLToPath, not `.pathname`: on Windows the latter yields `/C:/…`, which
    // no filesystem call accepts.
    roots.push(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))));
  } catch {
    // Not installed as a dependency of this package; the other roots cover it.
  }

  return [...new Set(roots.map((r) => resolve(r)))];
}

/**
 * Find a file inside the DSH installation or one of its bundled dependencies.
 *
 * @param {string[]} relatives paths relative to a candidate root, tried in order
 * @returns {string | undefined} the first existing path
 */
export function findInDsh(relatives) {
  for (const root of dshRoots()) {
    for (const relative of relatives) {
      const candidate = join(root, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The Harness's JSON-schema validator module, if reachable.
 * @returns {string | undefined}
 */
export function findSchemaValidator() {
  return findInDsh([
    join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    'lib/index.js',
  ]);
}

/**
 * The Cordis runtime module, if reachable.
 * @returns {string | undefined}
 */
export function findCordis() {
  return findInDsh([
    join('node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    join('node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  ]);
}
