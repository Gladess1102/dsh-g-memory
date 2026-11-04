#!/usr/bin/env node
/**
 * The decision log: on by default, and bounded.
 *
 * Two things are pinned here, both of them regressions the log itself recorded.
 *
 *   1. It is on unless the path is moved. The README said "unset means no
 *      telemetry" while `record()` always wrote to `defaultStatsPath()`, so the
 *      document described an opt-in the code had already abandoned — and a
 *      desktop-launched host that wrote nothing looked exactly like a dead plugin.
 *   2. It has a size cap. One line per model step from every host with no
 *      rotation reached 29,382 lines / 3.7 MB on this machine, still growing.
 *
 * Hermetic: a temporary directory and its own file, no network.
 *
 *   node scripts/test-telemetry.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STATS_BYTES, record, setTelemetrySession } from '../lib/telemetry.mjs';

const dir = await mkdtemp(join(tmpdir(), 'gm-telemetry-'));
const stats = join(dir, 'stats.jsonl');
process.env.DSH_G_MEMORY_AUTO_STATS = stats;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error?.message || error));
  }
}

/** `record()` is fire-and-forget; the append has to land before it is read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/** @param {string} path */
async function lines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// The rotation check runs first on purpose: the size counter is seeded from the
// file on the first write to a path, and this is that write.
await writeFile(stats, 'x'.repeat(MAX_STATS_BYTES));

await check('a full log is rotated to .1 instead of growing without bound', async () => {
  record('after-cap', {});
  await settle();
  const rotated = await stat(`${stats}.1`).then((info) => info.size).catch(() => -1);
  assert.equal(rotated, MAX_STATS_BYTES, 'the previous generation is kept, not deleted');
  const live = await lines(stats);
  assert.equal(live.length, 1, 'and the live file starts over');
  assert.equal(live[0].event, 'after-cap');
});

await check('an event carries its ambient fields and lands in the live file', async () => {
  setTelemetrySession('session-abcdef012345');
  record('probe', { value: 7 });
  await settle();
  const live = await lines(stats);
  assert.equal(live.length, 2, 'appended beside the rotated-in line');
  const event = live.at(-1);
  assert.equal(event.event, 'probe');
  assert.equal(event.value, 7);
  assert.equal(event.session, 'session-abcdef012345');
  assert.equal(typeof event.cwd, 'string');
  assert.ok(event.t > 0);
});

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? 'telemetry: all checks passed' : 'telemetry: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
