#!/usr/bin/env node
/**
 * CLI defaults read from the deployment's profile.
 *
 * The failure this guards is quiet and expensive: the host runs the profile's
 * embedding model, the CLI resolves the package default, and `build` then treats
 * the name change as a different embedding space — re-embedding the corpus and
 * writing a header the host's live index refuses. Measured 2026-11-01: profile
 * `embeddinggemma-2`, package default `embed-gemma`.
 *
 * Hermetic: a temporary DSH_HOME, no network.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfileDefaults, embedBlock, readProfileEmbedDefaults } from '../lib/profile.mjs';
import { resolveConfig } from '../lib/embedder.mjs';

const home = mkdtempSync(join(tmpdir(), 'gm-profile-'));
function profile(name, text) {
  mkdirSync(join(home, 'profiles', name), { recursive: true });
  writeFileSync(join(home, 'profiles', name, 'cordis.patch.yml'), text);
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (error?.message || error));
  }
}

const ENTRY = [
  '- id: other-plugin',
  '  config:',
  '    embed:',
  '      model: not-ours',
  '# a comment between entries',
  '- id: dsh-g-memory',
  '  config:',
  '    # this deployment documents its measurements inline',
  '    embed:',
  '      url: http://127.0.0.1:11439',
  '      model: embeddinggemma-2',
  '      timeoutMs: 90000',
  '      queryPrefix: "task: question answering | query: "',
  '      docPrefix: "title: none | text: "',
  '    rerank:',
  '      url: http://127.0.0.1:11436',
  '- id: after',
  '  config: {}',
  '',
].join('\n');

await check('the entry is located and its embed block parsed', () => {
  const block = embedBlock(ENTRY);
  assert.ok(block, 'no block');
  assert.equal(block.model, 'embeddinggemma-2');
  assert.equal(block.url, 'http://127.0.0.1:11439');
  assert.equal(block.queryPrefix, 'task: question answering | query: ');
  assert.equal(block.docPrefix, 'title: none | text: ');
  assert.equal(block.model, 'embeddinggemma-2', 'another plugin\'s model must not win');
});

await check('a nested list inside the entry does not end it early', () => {
  const text = [
    '- id: dsh-g-memory',
    '  config:',
    '    sources:',
    '      - a',
    '    embed:',
    '      model: x',
    '',
  ].join('\n');
  assert.equal(embedBlock(text)?.model, 'x');
});

await check('a profile without the entry yields nothing', () => {
  assert.equal(embedBlock('- id: something-else\n  config: {}\n'), null);
});

profile('desktop', ENTRY);
profile('web', ENTRY.replace('embeddinggemma-2', 'should-not-win'));

await check('the first profile in name order wins', () => {
  const found = readProfileEmbedDefaults(home);
  assert.equal(found?.profile, 'desktop');
  assert.equal(found?.model, 'embeddinggemma-2');
});

await check('an absent profiles directory is not an error', () => {
  const empty = mkdtempSync(join(tmpdir(), 'gm-profile-empty-'));
  assert.equal(readProfileEmbedDefaults(empty), null);
  rmSync(empty, { recursive: true, force: true });
});

await check('the profile fills the package default', () => {
  const cfg = applyProfileDefaults(resolveConfig(), { home });
  assert.equal(cfg.model, 'embeddinggemma-2');
  assert.equal(cfg.queryPrefix, 'task: question answering | query: ');
});

await check('an environment override beats the profile', () => {
  process.env.DSH_G_MEMORY_EMBED_MODEL = 'from-env';
  try {
    const cfg = applyProfileDefaults(resolveConfig(), { home });
    assert.equal(cfg.model, 'from-env');
  } finally {
    delete process.env.DSH_G_MEMORY_EMBED_MODEL;
  }
});

await check('an explicit override beats the profile', () => {
  const cfg = applyProfileDefaults(resolveConfig({ model: 'explicit' }), { overrides: { model: 'explicit' }, home });
  assert.equal(cfg.model, 'explicit');
});

await check('a field the profile omits keeps the package default', () => {
  const thin = mkdtempSync(join(tmpdir(), 'gm-profile-thin-'));
  mkdirSync(join(thin, 'profiles', 'p'), { recursive: true });
  writeFileSync(join(thin, 'profiles', 'p', 'cordis.patch.yml'), '- id: dsh-g-memory\n  config:\n    embed:\n      model: only-model\n');
  const cfg = applyProfileDefaults(resolveConfig(), { home: thin });
  assert.equal(cfg.model, 'only-model');
  assert.equal(cfg.url, 'http://127.0.0.1:11439', 'url must stay at the default');
  rmSync(thin, { recursive: true, force: true });
});

if (failures > 0) {
  console.log('\nprofile: ' + failures + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nprofile: all checks passed');
}
rmSync(home, { recursive: true, force: true });
