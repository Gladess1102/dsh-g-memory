#!/usr/bin/env node
/**
 * The carry-over path: a recall that finishes after its turn's last step.
 *
 * The measured shape of the failure this pins down: `pre-step` consumes
 * synchronously and a plain question-and-answer turn has exactly one step, while
 * the pipeline takes 2.2-11 s. So the result was ready, no step ever came, and the
 * next message replaced it (`late-drop`). A tool loop hid it — its later steps
 * eventually consume — which is why it survived so long in a system that logs
 * everything.
 *
 * Hermetic: no index, no embedder, no network. The states are the contract.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRecall } from '../lib/auto-recall.mjs';

const statsPath = join(await mkdtemp(join(tmpdir(), 'dsh-carry-')), 'stats.jsonl');
process.env.DSH_G_MEMORY_AUTO_STATS = statsPath;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

/** `record()` is fire-and-forget, so reading the log needs the append to land. */
async function events() {
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    return (await readFile(statsPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** @param {string} why */
async function sawLateDrop(why) {
  return (await events()).some((e) => e.event === 'late-drop' && e.why === why);
}

function makeRecall() {
  return new AutoRecall(
    { on: () => () => {}, logger: { debug() {} } },
    { consolidate: false, auto: { enabled: true }, indexDir: '/nonexistent-index-for-tests' },
  );
}

/** The state a turn is in after the pipeline finished but nothing consumed it. */
const ready = (text, at = Date.now()) => ({ status: 'ready', text, at });
const running = (at = Date.now()) => ({ status: 'pending', at });

console.log('carry-over');

await check('a ready result is consumed once, as this turn\'s memory', async () => {
  const recall = makeRecall();
  recall.pending.set('a', ready('MEMORY-A'));
  assert.equal(recall.take('a'), 'MEMORY-A');
  assert.equal(recall.lastTakeWhy, 'ready');
  assert.equal(recall.take('a'), '', 'consumed exactly once');
  assert.equal(recall.lastTakeWhy, 'no-armed-result');
});

await check('a result parked by the previous turn is injected while this turn is still retrieving', async () => {
  const recall = makeRecall();
  recall.pending.set('a', running());
  recall.carried.set('a', { text: 'LATE-MEMORY', at: Date.now() });
  assert.equal(recall.take('a'), 'LATE-MEMORY');
  assert.equal(recall.lastTakeWhy, 'carried');
  assert.equal(recall.carried.has('a'), false, 'a carry-over is spent, not repeated');
  assert.equal(recall.take('a'), '', 'and the turned-over result is gone');
  assert.equal(recall.lastTakeWhy, 'pending', 'this turn is still retrieving');
});

await check('a fresh result outranks a carried one and the log says so', async () => {
  const recall = makeRecall();
  recall.pending.set('a', ready('THIS-TURN'));
  recall.carried.set('a', { text: 'LAST-TURN', at: Date.now() });
  assert.equal(recall.take('a'), 'THIS-TURN');
  assert.equal(recall.lastTakeWhy, 'ready');
  assert.equal(recall.carried.has('a'), false);
  assert.ok(await sawLateDrop('carry-over-superseded-by-fresh'));
});

await check('a turn that was decided against does not get the carried memory', async () => {
  const recall = makeRecall();
  // `empty` is what the judge skipping, a gate drop and an empty retrieval all
  // leave behind. That decision is about this turn, so it wins.
  recall.pending.set('a', { status: 'empty', at: Date.now() });
  recall.carried.set('a', { text: 'LAST-TURN', at: Date.now() });
  assert.equal(recall.take('a'), '');
  assert.equal(recall.carried.has('a'), false);
  assert.ok(await sawLateDrop('carry-over-after-empty-turn'));
});

await check('a result from two minutes ago is still usable (the TTL was raised from 120 s)', async () => {
  // Measured 2026-11-03: 28 of 29 expired results were followed by a new turn in
  // the same session, median gap 7 minutes. Two minutes was throwing away work
  // the next turn immediately repeated.
  const recall = makeRecall();
  recall.pending.set('a', ready('A-BIT-OLD', Date.now() - 121_000));
  assert.equal(recall.take('a'), 'A-BIT-OLD', 'two minutes used to be past the deadline');
  assert.equal(recall.lastTakeWhy, 'ready');
});

await check('an expired carry-over is dropped, not injected', async () => {
  const recall = makeRecall();
  recall.pending.set('a', running());
  recall.carried.set('a', { text: 'STALE', at: Date.now() - 301_000 });
  assert.equal(recall.take('a'), '');
  assert.equal(recall.lastTakeWhy, 'pending');
  assert.ok(await sawLateDrop('carry-over-expired'));
});

await check('a turn that was never armed does not receive one either', async () => {
  const recall = makeRecall();
  // A message below the arming floor (< 8 chars) leaves no pending entry at all.
  recall.carried.set('a', { text: 'LAST-TURN', at: Date.now() });
  assert.equal(recall.take('a'), '');
  assert.equal(recall.lastTakeWhy, 'no-armed-result');
  assert.equal(recall.carried.get('a')?.text, 'LAST-TURN', 'still there for a turn that does ask');
});

await check('repeat suppression still applies to a carried payload', async () => {
  const recall = makeRecall();
  recall.injected.set('a', new Set(['LATE-MEMORY']));
  recall.pending.set('a', running());
  recall.carried.set('a', { text: 'LATE-MEMORY', at: Date.now() });
  assert.equal(recall.take('a'), '');
  assert.equal(recall.lastTakeWhy, 'repeat-suppressed');
});

await check('a new turn parks the previous outcome instead of discarding it', async () => {
  const recall = makeRecall();
  recall.arm('a', 'FIRST');
  // Nothing consumed it; the next turn's arming is what used to overwrite it.
  recall.arm('a', 'SECOND');
  assert.equal(recall.carried.get('a')?.text, 'FIRST');
  assert.ok(await sawLateDrop('carried-to-next-turn'));
  assert.equal(recall.take('a'), 'SECOND', 'the explicit arm is this turn\'s memory');
  assert.equal(recall.carried.has('a'), false, 'and it supersedes the parked one');
});

await check('an expired outcome is still a drop', async () => {
  const recall = makeRecall();
  recall.pending.set('a', ready('OLD', Date.now() - 301_000));
  recall.arm('a', 'NEW');
  assert.equal(recall.carried.has('a'), false);
  assert.ok(await sawLateDrop('superseded-expired'));
});

await check('a recall that settles late does not overwrite the turn that replaced it', async () => {
  const recall = makeRecall();
  // The pipeline is asynchronous: run 1 is still retrieving when the person sends
  // a second message, and that message's arming takes the slot. Run 1 then settles
  // — and used to write its own outcome over the newer turn's slot, so the new
  // turn was injected with an answer to the previous query.
  recall.start('a', 'a query long enough to arm the pipeline');
  recall.arm('a', 'THIS-TURN');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recall.take('a'), 'THIS-TURN', 'the newer turn keeps its memory');
});

await check('the run that owns the slot still settles it', async () => {
  const recall = makeRecall();
  recall.start('a', 'a query long enough to arm the pipeline');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recall.take('a'), '');
  assert.equal(recall.lastTakeWhy, 'empty', 'its own settlement must land (there is no index here)');
});

await check('disposing forgets the parked payloads', async () => {
  const recall = makeRecall();
  recall.carried.set('a', { text: 'X', at: Date.now() });
  recall.dispose();
  assert.equal(recall.carried.size, 0);
});

console.log('');
console.log(failures === 0 ? 'carry-over: all checks passed' : 'carry-over: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
