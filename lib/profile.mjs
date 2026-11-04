/**
 * Deployment defaults for the CLI, read from the DSH profiles.
 *
 * Why this exists. The plugin is configured from the composition
 * (`~/.dsh/profiles/<profile>/cordis.patch.yml`), and the installed copy is a
 * symlink to this package, so the host runs whatever the profile says. The CLI
 * reads only the environment and then the package default — measured 2026-11-01:
 * the profile says `model: embeddinggemma-2`, the index header says
 * `embeddinggemma-2`, and `dsh-g-memory selfcheck` in a plain shell reported
 * `embed-gemma`. The mismatch is not cosmetic: `build` treats a model-name
 * change as a different embedding space and re-embeds the whole corpus, and the
 * header it writes then no longer matches the profile, so the host's live index
 * refuses to run (`model-mismatch`) until someone rebuilds by hand.
 *
 * So the CLI resolves the same way the host does: environment first (an override
 * the operator typed must win), then the profile, then the package default.
 * Deliberately narrow — it reads only the `embed` block of the
 * `dsh-g-memory` entry, with a line scanner rather than a YAML parser, because
 * this package has no runtime dependencies and a wrong guess here must be a
 * missing default, never a broken build.
 *
 * SPDX-License-Identifier: MIT
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the DSH home lives, resolved per call like every other environment read. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

/**
 * The `embed` block of the first `- id: dsh-g-memory` entry found, if any.
 *
 * Profiles are visited in name order so the answer is stable; the first profile
 * that declares an embedding model wins. A profile without the entry is skipped,
 * which is what makes the CLI work on a machine that only has `web` configured.
 *
 * @param {string} [home]
 * @returns {{ url?: string, model?: string, queryPrefix?: string, docPrefix?: string, profile?: string } | null}
 */
export function readProfileEmbedDefaults(home = dshHome()) {
  let entries;
  try {
    entries = readdirSync(join(home, 'profiles'), { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(home, 'profiles', name, 'cordis.patch.yml'), 'utf8');
    } catch {
      continue;
    }
    const block = embedBlock(text);
    if (block !== null && block.model) return { ...block, profile: name };
  }
  return null;
}

/**
 * Locate the `embed:` sub-block of the dsh-g-memory entry and read its scalars.
 *
 * The scanner is indentation-based on purpose: compositions are hand-written, a
 * full YAML parser is a dependency this package does not take, and every field
 * read here is a plain `key: value` line. Anything it cannot parse is absent
 * rather than invented.
 *
 * @param {string} text
 * @returns {{ url?: string, model?: string, queryPrefix?: string, docPrefix?: string } | null}
 */
export function embedBlock(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let dashIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)-\s*id:\s*["']?dsh-g-memory["']?\s*$/.exec(lines[i]);
    if (match !== null) {
      start = i + 1;
      dashIndent = match[1].length;
      break;
    }
  }
  if (start < 0) return null;

  // The entry ends at the next sibling list item (same indent, `- `) or at a
  // line less indented than the item itself.
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= dashIndent && /^\s*-\s/.test(line)) { end = i; break; }
    if (indent < dashIndent) { end = i; break; }
  }

  let embedIndent = -1;
  let embedStart = -1;
  for (let i = start; i < end; i += 1) {
    const match = /^(\s*)embed:\s*$/.exec(lines[i]);
    if (match !== null) {
      embedIndent = match[1].length;
      embedStart = i + 1;
      break;
    }
  }
  if (embedStart < 0) return null;

  const out = {};
  for (let i = embedStart; i < end; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      // Comments inside the block are ordinary — the deployment documents its
      // measurements inline — and they must not end it.
      if (line.trim() === '') continue;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= embedIndent) break;
    const match = /^\s*([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    out[match[1]] = unquote(match[2]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Strip one layer of matching quotes and trailing comments from a scalar. */
function unquote(value) {
  let text = String(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  const hash = text.indexOf(' #');
  if (hash >= 0) text = text.slice(0, hash).trim();
  return text;
}

/** The environment variables that override each field, in the same order as the merge. */
const ENV_FOR = {
  url: 'DSH_G_MEMORY_EMBED_URL',
  model: 'DSH_G_MEMORY_EMBED_MODEL',
  queryPrefix: 'DSH_G_MEMORY_EMBED_QUERY_PREFIX',
  docPrefix: 'DSH_G_MEMORY_EMBED_DOC_PREFIX',
};

/**
 * Fill a resolved embedding config from the deployment's profile.
 *
 * Environment wins over the profile (an operator typing `DSH_G_MEMORY_EMBED_MODEL`
 * means it), and an explicit `overrides` value wins over both. Only fields the
 * profile actually declares are touched, so a profile that sets only the model
 * leaves the URL at the package default.
 *
 * @param {Record<string, any>} cfg resolved config, mutated and returned
 * @param {{ overrides?: Record<string, any>, home?: string }} [options]
 * @returns {Record<string, any>}
 */
export function applyProfileDefaults(cfg, options = {}) {
  const profile = readProfileEmbedDefaults(options.home);
  if (profile === null) return cfg;
  const overrides = options.overrides || {};
  for (const field of Object.keys(ENV_FOR)) {
    if (!(field in profile) || profile[field] === undefined || profile[field] === '') continue;
    if (overrides[field] !== undefined) continue;
    if (process.env[ENV_FOR[field]]) continue;
    cfg[field] = profile[field];
  }
  return cfg;
}
