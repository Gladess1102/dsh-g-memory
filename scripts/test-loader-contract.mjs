#!/usr/bin/env node
/**
 * Loader-contract test for the DSH Host half of dsh-g-memory.
 *
 * Why this file exists
 * --------------------
 * `scripts/test-plugin.mjs` calls `apply()` directly with a hand-built context.
 * That verifies the tool *definition* but says nothing about whether the Loader
 * will ever reach the registration line — and that gap hid a total failure for
 * three deployments. The plugin mounted, reported `fiberPhase: "active"`, and
 * registered nothing at all.
 *
 * Two independent Loader rules caused it, and neither is visible from `apply()`:
 *
 *   1. A service is only reachable if the plugin *declares* it. The Loader
 *      derives each fiber's epoch from the plugin's `inject` list, so an
 *      undeclared dependency is undefined inside `apply()` even when its
 *      provider mounted first. The failure is silent: `apply()` returns, the
 *      fiber goes active, and the capability is simply absent.
 *   2. `unwrapExports` resolves a module to `exports.default ?? exports`. A
 *      `export default { name, apply }` therefore discards every named export —
 *      `inject` included — so adding `inject` while keeping a default export
 *      changes nothing.
 *
 * This test drives the real `cordis` package through the real rules, so both
 * mistakes fail here in a second instead of costing a restart each. It reproduces
 * both load orders (provider first, provider last) because neither ordering
 * rescues a missing `inject`.
 *
 * Usage: node scripts/test-loader-contract.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findCordis } from '../lib/harness.mjs';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  ❌ ${name}\n       ${error.message}`);
  }
}

/**
 * The Loader's own export normalization, copied from `cordis-plugin-loader`'s
 * `unwrapExports`. Kept as a local copy so this test fails loudly (rather than
 * silently drifting) if the rule ever changes: the assertions below are written
 * against this shape on purpose.
 */
function unwrapExports(exports) {
  if (exports == null) return exports;
  exports = exports.default ?? exports;
  if (!exports.__esModule) return exports;
  return exports.default ?? exports;
}

const cordisPath = findCordis();

console.log('─'.repeat(70));
console.log('dsh-g-memory — Loader contract test');
console.log(cordisPath === null
  ? '  ⚠️  Cordis not found — load-order checks CANNOT run'
  : `  Cordis: ${cordisPath}`);
console.log('─'.repeat(70));

if (cordisPath === null) {
  console.log('');
  console.log('  The Loader contract cannot be verified without the deployment\'s');
  console.log('  Cordis. Set DSH_CHECKOUT to a DSH installation and re-run.');
  process.exitCode = 1;
} else {
  const { Context, Service } = await import(pathToFileURL(cordisPath).href);
  const mod = await import('../lib/index.js');

  /**
   * Registrations seen across the scenario. Deliberately module-scope rather
   * than read off the service instance: resolving the instance from the root at
   * mount time is itself subject to the timing this test is about, so reading it
   * back would make the test fail for the wrong reason.
   */
  let registeredNames = [];

  /** A stand-in for the real `tools` service that records registrations. */
  class FakeTools extends Service {
    constructor(ctx) {
      super(ctx, 'tools');
    }
    register(tool) {
      registeredNames.push(tool.name);
      return () => {};
    }
  }

  // ------------------------------------------------------------- export shape
  await check('module exports no default (a default would shadow `inject`)', () => {
    const picked = unwrapExports(mod);
    assert.ok(
      mod.default === undefined,
      'export default must not exist: the Loader prefers it and discards named exports',
    );
    assert.equal(picked, mod, 'the Loader must resolve the module namespace itself');
  });

  await check('module declares the `tools` dependency', () => {
    const picked = unwrapExports(mod);
    assert.ok(Array.isArray(picked.inject), '`inject` must be an exported array');
    assert.ok(
      picked.inject.includes('tools'),
      `\`inject\` must name 'tools', got ${JSON.stringify(picked.inject)}`,
    );
  });

  // -------------------------------------------------------- load-order matrix
  /**
   * Load the plugin through a real Cordis context and report the names it
   * registered. `providerFirst` selects which side mounts first; a correct
   * `inject` makes the plugin work in both orders, and an absent one makes it
   * fail in both.
   */
  async function loadAndCollect(providerFirst) {
    const root = new Context();
    registeredNames = [];
    if (providerFirst) root.plugin(FakeTools);
    // Hand Cordis what the Loader actually hands it. Passing the raw namespace
    // here would bypass `unwrapExports` and quietly stop testing the very rule
    // this file exists to pin down.
    const pluginFiber = root.plugin(unwrapExports(mod));
    if (!providerFirst) root.plugin(FakeTools);
    // Let the fiber machinery settle: a plugin deferred on a service starts from
    // that service's registration, which is not synchronous.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const registered = [...registeredNames];
    await root.stop?.();
    return { registered, fiber: pluginFiber };
  }

  for (const providerFirst of [true, false]) {
    await check(
      providerFirst
        ? 'registers memory_recall when the tools provider mounts first'
        : 'registers memory_recall when the tools provider mounts last',
      async () => {
        const { registered } = await loadAndCollect(providerFirst);
        assert.ok(
          registered.includes('memory_recall'),
          `the Loader never reached the registration line (registered: ${JSON.stringify(registered)})`,
        );
      },
    );
  }

  await check('apply() throws rather than returning when `tools` is absent', async () => {
    // Bypass `inject` deliberately: call apply() on a bare context. The plugin
    // must refuse loudly, because a silently absent memory plugin is the exact
    // failure this whole file exists to prevent.
    const bare = new Context();
    assert.throws(
      () => mod.apply(bare, { auto: false }),
      /tools.*unavailable|memory_recall/i,
      'apply() must throw when the tool registry cannot be reached',
    );
    await bare.stop?.();
  });

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log('─'.repeat(70));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log('─'.repeat(70));
  process.exitCode = failed.length === 0 ? 0 : 1;
}
