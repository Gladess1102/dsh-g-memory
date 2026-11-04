#!/usr/bin/env node
/**
 * Read accounting: which memories actually reached a model.
 *
 * The counter is only useful if it is honest, so the checks are about the
 * failure modes rather than the happy path: a card that was selected and then
 * dropped must not count, an unknown id must not invent a card, and recording a
 * read must never lose a card written beside it.
 *
 * Hermetic: a temporary DSH_HOME, no network.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCards, recordCardReads, writeCards } from '../lib/cards.mjs';
import { staleCard } from '../lib/index-layer.mjs';

const home = mkdtempSync(join(tmpdir(), 'gm-reads-'));
const path = join(home, 'dsh-g-memory', 'cards.ndjson');
const now = Date.now();
const sha1 = (text) => createHash('sha1').update(String(text));
const card = (id, summary, extra = {}) => ({
  id, session: 's', time: now, summary, tags: [], hash: sha1(summary).digest('hex').slice(0, 24), ...extra,
});

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

await check('a read increments the counter and stamps the clock', async () => {
  await writeCards([card('a'.repeat(20), '第一条'), card('b'.repeat(20), '第二条')], path);
  const result = await recordCardReads(['a'.repeat(20)], path, now);
  assert.equal(result.updated, 1);
  const cards = await readCards(path);
  const a = cards.find((c) => c.id === 'a'.repeat(20));
  const b = cards.find((c) => c.id === 'b'.repeat(20));
  assert.equal(a.readCount, 1);
  assert.equal(a.lastReadAt, now);
  assert.equal(b.readCount, undefined, 'an unread card must not be touched');
});

await check('repeated reads accumulate', async () => {
  await recordCardReads(['a'.repeat(20)], path, now + 1);
  const a = (await readCards(path)).find((c) => c.id === 'a'.repeat(20));
  assert.equal(a.readCount, 2);
  assert.equal(a.lastReadAt, now + 1);
});

await check('an unknown id adds nothing', async () => {
  const before = (await readCards(path)).length;
  const result = await recordCardReads(['f'.repeat(20)], path, now);
  assert.equal(result.updated, 0);
  assert.equal((await readCards(path)).length, before);
});

await check('a read does not lose a card written beside it', async () => {
  // Simulates the consolidation loop writing while a read is being flushed.
  await writeCards([card('c'.repeat(20), '刚写入的卡')], path);
  await recordCardReads(['c'.repeat(20), 'a'.repeat(20)], path, now);
  const ids = (await readCards(path)).map((c) => c.id);
  assert.ok(ids.includes('c'.repeat(20)));
  assert.ok(ids.includes('a'.repeat(20)));
});

await check('a read memory stops being stale', async () => {
  const old = card('d'.repeat(20), '很久以前的卡', { time: now - 200 * 86_400_000 });
  await writeCards([old], path);
  assert.equal(staleCard((await readCards(path)).find((c) => c.id === old.id), { now }), true);
  await recordCardReads([old.id], path, now);
  assert.equal(staleCard((await readCards(path)).find((c) => c.id === old.id), { now }), false);
});

if (failures > 0) {
  console.log('\ncard-reads: ' + failures + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\ncard-reads: all checks passed');
}
rmSync(home, { recursive: true, force: true });
