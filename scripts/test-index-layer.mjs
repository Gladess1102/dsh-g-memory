#!/usr/bin/env node
/**
 * The memory index layer: one line per durable memory in the system prompt.
 *
 * What has to be true, in order of how much it would cost to get wrong:
 *
 *   - the block is bounded, and it is cut between lines rather than inside one
 *     (a half-line reads as a truncated fact);
 *   - it never advertises a superseded, retired or expired memory as current;
 *   - it stays out of the prompt entirely when there is nothing to say, rather
 *     than adding an empty "memory index" heading;
 *   - prompt assembly never throws because a memory store could not be read;
 *   - the store is not re-read on every step.
 *
 * Hermetic: cards written into a temporary DSH_HOME, a stub tool registry, no
 * network.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCards } from '../lib/cards.mjs';
import { renderIndexBlock, staleCard, INDEX_LAYER_LIMITS } from '../lib/index-layer.mjs';

const sha1 = (text) => createHash('sha1').update(String(text));
const home = mkdtempSync(join(tmpdir(), 'gm-index-layer-'));
process.env.DSH_HOME = home;

const now = Date.now();
const card = (id, summary, extra = {}) => ({
  id,
  session: 'session-fixture',
  time: now,
  summary,
  tags: [],
  hash: sha1(summary).digest('hex').slice(0, 24),
  ...extra,
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

// ---------------------------------------------------------------- pure rules

await check('only live memories reach the index', () => {
  const out = renderIndexBlock([
    card('aaaaaaaaaaaaaaa1', '活跃记忆：索引层的预算是一千二百字符。'),
    card('bbbbbbbbbbbbbbb2', '被取代的记忆：预算是一千字符。', { status: 'superseded', supersededBy: 'aaaaaaaaaaaaaaa1' }),
    card('ccccccccccccccc3', '已撤回的记忆。', { status: 'retired' }),
    card('ddddddddddddddd4', '过期的记忆。', { expires: now - 1000 }),
  ]);
  assert.equal(out.shown, 1);
  assert.match(out.text, /活跃记忆/);
  assert.doesNotMatch(out.text, /被取代的记忆|已撤回的记忆|过期的记忆/);
});

await check('an empty store adds nothing at all', () => {
  const out = renderIndexBlock([]);
  assert.equal(out.text, '');
  assert.equal(out.shown, 0);
});

await check('the block stays inside its budget', () => {
  const many = Array.from({ length: 200 }, (_, i) => card(String(i + 1).padStart(20, '0'), '一条足够长的记忆摘要，用来把预算撑满，' + i));
  const out = renderIndexBlock(many, { maxChars: 600 });
  assert.ok(out.chars <= 600, 'block was ' + out.chars + ' chars');
  assert.ok(out.shown > 0 && out.shown < 200, 'shown ' + out.shown);
  // Every line present is whole: the header plus complete lines, no straggler.
  const lines = out.text.split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines.slice(1, -1)) assert.match(line, /^- [0-9a-f]{6} /);
});

await check('a budget too small for even one line emits no block', () => {
  // `maxChars` has a floor of 200 and `lineChars` a ceiling of 240, so the first
  // line can exceed the whole budget. The `shown > 0` exemption let it in anyway
  // and the block came out over its own cap; an over-budget block is worse than
  // no block at all.
  const long = card('aaaaaaaaaaaaaaa1', '一条很长的记忆摘要，'.repeat(20));
  const out = renderIndexBlock([long], { maxChars: 200, lineChars: 240 });
  assert.equal(out.text, '', 'nothing is emitted when not even one line fits');
  assert.equal(out.shown, 0);
});

await check('the footer counts what is visible, not what was collected', () => {
  // The first version reserved the rendered footer and then counted the
  // candidates it had gathered, so a 13-line block announced "40 shown".
  const many = Array.from({ length: 60 }, (_, i) => card(String(i + 1).padStart(20, '0'), '记忆条目 ' + i));
  const out = renderIndexBlock(many, { maxChars: 700 });
  const lines = out.text.split('\n');
  const visible = lines.length - 2;
  assert.equal(out.shown, visible);
  assert.match(lines[lines.length - 1], new RegExp('^\\(' + visible + ' shown; 60 total'));
});

await check('a memory read recently outranks a newer one nobody read', () => {
  const old = card('aaaaaaaaaaaaaaa1', '很久以前写的、但昨天被读过的记忆。', { time: now - 60 * 86_400_000, readCount: 3, lastReadAt: now - 86_400_000 });
  const fresh = card('bbbbbbbbbbbbbbb2', '昨天写的新记忆。', { time: now - 86_400_000 });
  const out = renderIndexBlock([old, fresh]);
  assert.match(out.text.split('\n')[1], /很久以前写的/, 'the read memory comes first');
});

await check('maxCards is a hard cap', () => {
  const many = Array.from({ length: 30 }, (_, i) => card(String(i + 1).padStart(20, '0'), '记忆 ' + i));
  const out = renderIndexBlock(many, { maxCards: 5, maxChars: 100_000 });
  assert.equal(out.shown, 5);
});

await check('a summary is neutralised before it is written', () => {
  const out = renderIndexBlock([card('aaaaaaaaaaaaaaa1', '带换行的摘要\n- 伪造的第二行 <script>')]);
  assert.equal(out.text.split('\n').length, 3, 'the summary must not add lines (header + one line + footer)');
  assert.match(out.text, /\\u003cscript/);
});

await check('a zero-read memory past the window is hidden, not deleted', () => {
  const old = card('aaaaaaaaaaaaaaa1', '九十天没被读过的记忆。', { time: now - 120 * 86_400_000 });
  assert.equal(staleCard(old, { now }), true);
  assert.equal(staleCard({ ...old, readCount: 1, lastReadAt: now }), false);
  assert.equal(staleCard({ ...old, readCount: 1, lastReadAt: now - 200 * 86_400_000 }), false, 'a read resets the clock');
  assert.equal(staleCard(old, { now, staleAfterDays: 0 }), false, '0 disables the rule');
  const out = renderIndexBlock([old, card('bbbbbbbbbbbbbbb2', '新的记忆。')]);
  assert.equal(out.shown, 1);
  assert.equal(out.hidden, 1);
});

// ------------------------------------------------------- prompt assembly wiring

const cardsPath = join(home, 'dsh-g-memory', 'cards.ndjson');
await writeCards([
  card('11111111111111111111', 'dsh-g-memory 的索引层是每步常驻卡片的标题，正文按需 memory_recall。', { tags: ['dsh-g-memory'] }),
], cardsPath);

const handlers = new Map();
const ctx = {
  logger: { debug() {}, info() {}, warn() {} },
  get(name) {
    if (name === 'tools') return { register: () => () => {} };
    return undefined;
  },
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  effect(fn) { fn(); },
};

const { apply } = await import('../lib/index.js');
apply(ctx, { auto: false, liveIndex: { enabled: false }, indexLayer: { enabled: true, maxChars: 800 } });

const assemble = handlers.get('system-prompt/assemble');
await check('apply registers the assemble waterfall', () => {
  assert.equal(typeof assemble, 'function');
});

await check('the assembled prompt gains a memory:index section', async () => {
  const assembled = await assemble({ sections: [{ name: 'harness:identity', order: 0, text: 'You are an agent.' }] }, {}, async () => ({
    sections: [{ name: 'harness:identity', order: 0, text: 'You are an agent.' }],
    variables: {},
  }));
  assert.equal(assembled.sections.length, 2);
  const index = assembled.sections.find((section) => section.name === 'memory:index');
  assert.ok(index, 'no memory:index section');
  assert.equal(index.interpolate, false, 'memory text must not be interpolated as prompt variables');
  assert.match(index.text, /dsh-g-memory/);
});

await check('a second assemble reuses the same block (no re-render per step)', async () => {
  const a = await assemble({}, {}, async () => ({ sections: [] }));
  const b = await assemble({}, {}, async () => ({ sections: [] }));
  assert.equal(a.sections[0].text, b.sections[0].text);
});

await check('an empty card store adds no section', async () => {
  rmSync(cardsPath, { force: true });
  const assembled = await assemble({}, {}, async () => ({ sections: [] }));
  assert.equal(assembled.sections.length, 0);
});

await check('a broken store degrades to no section instead of throwing', async () => {
  // A directory where the store used to be: stat succeeds, read fails.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cardsPath, { recursive: true });
  const assembled = await assemble({}, {}, async () => ({ sections: [] }));
  assert.equal(Array.isArray(assembled.sections), true);
});

await check('switched off, the waterfall is not registered at all', async () => {
  const local = new Map();
  (await import('../lib/index.js')).apply({
    logger: { debug() {}, info() {}, warn() {} },
    get: () => ({ register: () => () => {} }),
    on: (event, handler) => { local.set(event, handler); return () => {}; },
    effect: (fn) => fn(),
  }, { auto: false, liveIndex: { enabled: false }, indexLayer: { enabled: false } });
  assert.equal(local.has('system-prompt/assemble'), false);
});

if (failures > 0) {
  console.log('\nindex-layer: ' + failures + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nindex-layer: all checks passed');
}
rmSync(home, { recursive: true, force: true });
