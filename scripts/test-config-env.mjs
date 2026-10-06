#!/usr/bin/env node
/**
 * Configuration-surface test: every default is read at call time, from the environment.
 *
 * Why this file exists
 * --------------------
 * `DSH_G_MEMORY_*` is how the CLI, the eval scripts and this suite configure the
 * package, and the plugin reads the same names when a composition does not override
 * them. Those defaults used to be module-level constants, evaluated once at import: a
 * later `process.env` change silently did nothing. 0.9.1 fixed exactly that shape for
 * the embedder after it shipped a dead endpoint (CI ran green while the loop talked to
 * 127.0.0.1:11439 on a machine with no model); the other six modules kept the same bug
 * because nothing asserted the binding.
 *
 * Two rules are pinned here:
 *
 *   1. Structural: the defaults are *functions*. A constant cannot honour an
 *      environment that changes after import, so the shape itself is the guard.
 *   2. Behavioural: each documented variable moves the value it claims to move.
 *
 * Usage: node scripts/test-config-env.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { defaultEmbedConfig } from '../lib/embedder.mjs';
import { defaultRerankConfig, resolveRerankConfig } from '../lib/rerank.mjs';
import { defaultSynthesisConfig } from '../lib/synthesize.mjs';
import { defaultConsolidationConfig } from '../lib/consolidate.mjs';
import { defaultLiveConfig, resolveLiveConfig } from '../lib/live-index.mjs';
import { defaultCacheConfig } from '../lib/cache.mjs';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ✅ ' + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log('  ❌ ' + name + '\n       ' + error.message);
  }
}

/** Run `fn` with one environment variable set, then restore whatever was there. */
function withEnv(name, value, fn) {
  const before = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

// ── 1. the shape: defaults are read per call, not frozen at import ──────────
const factories = [
  ['embedder', 'defaultEmbedConfig', defaultEmbedConfig],
  ['rerank', 'defaultRerankConfig', defaultRerankConfig],
  ['synthesize', 'defaultSynthesisConfig', defaultSynthesisConfig],
  ['consolidate', 'defaultConsolidationConfig', defaultConsolidationConfig],
  ['live-index', 'defaultLiveConfig', defaultLiveConfig],
  ['cache', 'defaultCacheConfig', defaultCacheConfig],
];
for (const [module, name, factory] of factories) {
  await check(module + ': ' + name + '() is a function, so the environment is read per call', () => {
    assert.equal(typeof factory, 'function', name + ' must be a function, not a frozen constant');
    assert.equal(typeof factory(), 'object', name + '() must return the defaults');
  });
}

await check('a variable set after import still moves the value (the 0.9.1 bug shape)', () => {
  const before = defaultRerankConfig().model;
  const after = withEnv('DSH_G_MEMORY_RERANK_MODEL', 'changed-after-import', () => defaultRerankConfig().model);
  assert.notEqual(after, before);
  assert.equal(after, 'changed-after-import');
});

// ── 2. the variables: each documented name moves its own field ──────────────
const cases = [
  ['DSH_G_MEMORY_EMBED_URL', 'http://127.0.0.1:9999', () => defaultEmbedConfig().url],
  ['DSH_G_MEMORY_EMBED_MODEL', 'embed-fixture', () => defaultEmbedConfig().model],
  ['DSH_G_MEMORY_RERANK_URL', 'http://127.0.0.1:9998', () => defaultRerankConfig().url],
  ['DSH_G_MEMORY_RERANK_MODEL', 'rerank-fixture', () => defaultRerankConfig().model],
  ['DSH_G_MEMORY_RERANK_PATH', '/rerank', () => defaultRerankConfig().path],
  ['DSH_G_MEMORY_RERANK_MIN_SCORE', '0.75', () => defaultRerankConfig().minScore],
  ['DSH_G_MEMORY_LLM_URL', 'http://127.0.0.1:9997/v1', () => defaultSynthesisConfig().baseUrl],
  ['DSH_G_MEMORY_LLM_MODEL', 'synthesis-fixture', () => defaultSynthesisConfig().model],
  ['DSH_G_MEMORY_CONSOLIDATE_HOURS', '2', () => defaultConsolidationConfig().minIntervalHours],
  ['DSH_G_MEMORY_CONSOLIDATE_TURNS', '9', () => defaultConsolidationConfig().minTurns],
  ['DSH_G_MEMORY_LIVE_QUIET_MS', '1234', () => defaultLiveConfig().quietMs],
  ['DSH_G_MEMORY_CACHE_TTL_MS', '4321', () => defaultCacheConfig().ttlMs],
];
for (const [env, value, read] of cases) {
  await check(env + ' reaches its default', () => {
    const numeric = /^[0-9.]+$/.test(value);
    const got = withEnv(env, value, read);
    assert.equal(got, numeric ? Number(value) : value, 'expected ' + value + ', got ' + JSON.stringify(got));
  });
}

await check('DSH_G_MEMORY_LLM_HEADERS carries gateway headers as JSON', () => {
  const got = withEnv('DSH_G_MEMORY_LLM_HEADERS', '{"x-opencode-session":"abc123"}', () => defaultSynthesisConfig().headers);
  assert.deepEqual(got, { 'x-opencode-session': 'abc123' });
  assert.deepEqual(withEnv('DSH_G_MEMORY_LLM_HEADERS', 'not json', () => defaultSynthesisConfig().headers), {},
    'a malformed value is dropped, not fatal');
  assert.deepEqual(withEnv('DSH_G_MEMORY_LLM_HEADERS', undefined, () => defaultSynthesisConfig().headers), {});
});

await check('DSH_G_MEMORY_CONSOLIDATE=on enables the loop, and anything else leaves it off', () => {
  assert.equal(withEnv('DSH_G_MEMORY_CONSOLIDATE', 'on', () => defaultConsolidationConfig().enabled), true);
  assert.equal(withEnv('DSH_G_MEMORY_CONSOLIDATE', 'off', () => defaultConsolidationConfig().enabled), false);
});

await check('an unset variable falls back to the documented default', () => {
  assert.equal(withEnv('DSH_G_MEMORY_RERANK_URL', undefined, () => defaultRerankConfig().url), '');
  assert.equal(withEnv('DSH_G_MEMORY_CONSOLIDATE_HOURS', undefined, () => defaultConsolidationConfig().minIntervalHours), 24);
});

await check('composition config still wins over the environment (resolve* merges over defaults)', () => {
  const resolved = withEnv('DSH_G_MEMORY_RERANK_URL', 'http://127.0.0.1:9998', () => resolveRerankConfig({ url: 'http://127.0.0.1:9996' }));
  assert.equal(resolved.url, 'http://127.0.0.1:9996');
});

await check('resolveLiveConfig applies its overrides on top of the call-time defaults', () => {
  const resolved = withEnv('DSH_G_MEMORY_LIVE_QUIET_MS', '1234', () => resolveLiveConfig({ budgetMs: 42 }));
  assert.equal(resolved.quietMs, 1234);
  assert.equal(resolved.budgetMs, 42);
});

console.log('');
const failed = results.filter((r) => !r.ok);
console.log('─'.repeat(70));
console.log((results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length > 0) {
  console.log('  ' + failed.length + ' failed:');
  for (const f of failed) console.log('   - ' + f.name);
  process.exitCode = 1;
}
