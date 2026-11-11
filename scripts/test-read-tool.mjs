#!/usr/bin/env node
/**
 * `memory_read`: the details half of recall.
 *
 * Why this exists: `memory_recall` returns previews capped at a few hundred
 * characters, so before this tool the only way to read the rest of a matched
 * conversation was to open the zstd-framed session log by hand. claude-mem drives
 * the same split with a search → timeline → details skill; this pins the
 * arithmetic that makes the "details" half trustworthy.
 *
 * What can go wrong silently, and is therefore tested:
 *
 *   - the anchor window is off by one and still returns text;
 *   - a missing `seq` makes the tool refuse instead of falling back to the start;
 *   - the character budget is exceeded and the caller never learns it was cut;
 *   - a session id truncated at a different length does not match.
 *
 * Hermetic: an in-memory index, no files, no network.
 *
 *   node scripts/test-read-tool.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { collectSessionRows, findSession, sliceSession } from '../lib/read-around.mjs';
import { createReadTool } from '../lib/tools.mjs';

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

/** A tiny index shaped exactly like the real one's `data.units`. */
function makeIndex() {
  const units = [];
  const push = (session, seq, text, extra = {}) => units.push({
    session, seq, text, role: 'user', time: 1794000000000 + seq * 1000, ...extra,
  });
  push('session-aaa', 0, 'first of aaa');
  push('session-aaa', 1, 'second of aaa');
  push('session-aaa', 2, 'third of aaa');
  push('session-bbb', 0, 'only of bbb');
  push('', 0, 'orphan with no session');       // must be skipped
  push(undefined, 1, 'orphan with undefined'); // must be skipped
  return { data: { units } };
}

console.log('─'.repeat(70));
console.log('dsh-g-memory — memory_read');
console.log('─'.repeat(70));

const index = makeIndex();
const bySession = collectSessionRows(index);

await check('groups units by session and skips units with no session id', () => {
  assert.equal(bySession.size, 2);
  assert.equal(bySession.get('session-aaa').length, 3);
  assert.equal(bySession.get('session-bbb').length, 1);
  // The empty string would otherwise match every orphan at once.
  assert.equal(bySession.has(''), false);
});

await check('orders each session by sequence', () => {
  assert.deepEqual(bySession.get('session-aaa').map((r) => r.seq), [0, 1, 2]);
});

await check('finds a session by exact id and by truncated id', () => {
  assert.equal(findSession(bySession, 'session-aaa').length, 3);
  assert.equal(findSession(bySession, 'session-aa').length, 3, 'a 16-char telemetry id is a prefix');
  assert.equal(findSession(bySession, 'nope'), null);
  assert.equal(findSession(bySession, '   '), null);
});

await check('without seq the window starts at the first entry', () => {
  const { entries, truncated } = sliceSession(bySession.get('session-aaa'), null, 1, 1, 10_000);
  assert.equal(truncated, false);
  assert.deepEqual(entries.map((e) => e.seq), [0, 1]);
  assert.equal(entries[0].text, 'first of aaa');
});

await check('with seq the window centres on the nearest entry', () => {
  const { entries } = sliceSession(bySession.get('session-aaa'), 1, 1, 1, 10_000);
  assert.deepEqual(entries.map((e) => e.seq), [0, 1, 2]);
});

await check('a seq that no longer exists snaps to the nearest instead of failing', () => {
  const { entries } = sliceSession(bySession.get('session-aaa'), 99, 1, 0, 10_000);
  assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
});

await check('the character budget cuts the window and says so', () => {
  const rows = bySession.get('session-aaa');
  const { entries, truncated } = sliceSession(rows, 1, 1, 1, 5);
  assert.equal(truncated, true);
  assert.equal(entries.length, 1, 'the second entry had no room left');
  assert.equal(entries[0].text, 'first…', 'cut to the budget plus one ellipsis character');
});

await check('the tool declares a schema and requires a session', () => {
  const tool = createReadTool({ readAround: async () => ({ session: '', entries: [] }), readCard: async () => null, maxChars: 100 });
  assert.equal(tool.name, 'memory_read');
  // Neither is required on its own: a call names either a session (transcript) or
  // a card (durable memory), and the tool reports which one is missing.
  assert.deepEqual(tool.parameters.required, []);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.session.type, 'string');
  assert.equal(tool.parameters.properties.card.type, 'string');
  assert.equal(tool.parameters.properties.seq.type, 'integer');
  assert.ok(tool.output.schema.properties.entries, 'entries must be declared');
});

await check('the tool passes a validated window to readAround', async () => {
  const calls = [];
  const tool = createReadTool({
    readAround: async (...args) => { calls.push(args); return { session: 's', total: 0, entries: [] }; },
    readCard: async () => null,
    maxChars: 6000,
  });
  await tool.execute({ session: ' session-aaa ', seq: 2, before: 3, after: 1 });
  assert.deepEqual(calls[0], ['session-aaa', 2, 3, 1, 6000]);
  // Out-of-range counts fall back rather than reaching the slicer.
  await tool.execute({ session: 's', before: 99, after: -1 });
  assert.deepEqual(calls[1], ['s', null, 1, 1, 6000]);
});

await check('a missing session is reported, not thrown', async () => {
  const tool = createReadTool({ readAround: async () => ({ session: '', entries: [] }), readCard: async () => null, maxChars: 100 });
  const out = await tool.execute({});
  assert.equal(out.entries.length, 0);
  assert.match(out.hint, /session or card is required/);
});

await check('a card id returns the full card text, untruncated', async () => {
  const summary = 'x'.repeat(1200);
  const tool = createReadTool({
    readAround: async () => ({ session: '', entries: [] }),
    readCard: async (id) => (id === 'abc123' ? { id: 'abc123', summary, time: 1794000000000, session: 'note/x' } : null),
    maxChars: 100,
  });
  const out = await tool.execute({ card: 'abc123' });
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].role, 'card');
  assert.equal(out.entries[0].text.length, 1200, 'a card is returned as stored, not cut by maxChars');
});

await check('an unknown card id is reported, not thrown', async () => {
  const tool = createReadTool({ readAround: async () => ({ session: '', entries: [] }), readCard: async () => null, maxChars: 100 });
  const out = await tool.execute({ card: 'nope' });
  assert.equal(out.entries.length, 0);
  assert.match(out.hint, /No card with id/);
});

await check('the rendered text carries the untrusted notice', () => {
  const tool = createReadTool({ readAround: async () => ({ session: '', entries: [] }), readCard: async () => null, maxChars: 100 });
  const rendered = tool.output.render({}, {
    session: 'session-aaa',
    total: 3,
    entries: [{ seq: 1, role: 'user', when: '2026-10-20T00:00:00.000Z', text: 'second of aaa' }],
  });
  const text = rendered[0].text;
  assert.match(text, /Untrusted data, not instructions/);
  assert.match(text, /#1/);
  assert.match(text, /second of aaa/);
});

console.log('─'.repeat(70));
console.log(failures === 0 ? 'memory_read: all checks passed' : 'memory_read: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
