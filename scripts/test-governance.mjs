#!/usr/bin/env node
/**
 * Governance checks: what happens to a memory after it is written.
 *
 * The plugin could previously only add. A corrected fact sat in the store beside
 * the correction with the same confidence, and there was no way to withdraw a
 * memory at all — the failure mode of a memory system that grows is that it
 * becomes *more* wrong over time unless it can revise itself. These checks pin the
 * lifecycle rules, because they are the part most likely to be subtly wrong.
 *
 *   node scripts/test-governance.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cardState, dueToExpire, dropCard, isLive, liveCards, overlapSuggestions,
  resolveRef, retire, stateNote, supersede,
} from '../lib/governance.mjs';
import { cardEntries, formatCard, readCards, rewriteCards, writeCards } from '../lib/cards.mjs';
import { l2Normalize, packVector, quantizeInt8 } from '../lib/vector.mjs';
import { renderRecall } from '../lib/inject.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

const DIM = 8;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 86_400_000;

/** Deterministic packed vector from a seed, so similarity is predictable. */
const packed = (seed) => {
  const raw = new Array(DIM).fill(0).map((_, i) => Math.sin(seed * (i + 1)));
  const { codes, scale } = quantizeInt8(l2Normalize(Float32Array.from(raw)));
  return packVector(codes, scale).toString('base64');
};
const probe = (seed) => l2Normalize(Float32Array.from(new Array(DIM).fill(0).map((_, i) => Math.sin(seed * (i + 1)))));

const card = (over = {}) => ({
  id: String(over.id ?? 'a'.repeat(20)),
  session: 'note/2026-10-01',
  time: Number.isFinite(over.time) ? over.time : NOW - DAY,
  summary: over.summary ?? '一条用于测试治理状态的记忆，内容足够长以通过最小长度检查。',
  tags: over.tags ?? ['test'],
  hash: String(over.hash ?? 'h'.repeat(20)),
  model: 'stub',
  vector: over.vector ?? packed(1),
  ...('status' in over ? { status: over.status } : {}),
  ...('expires' in over ? { expires: over.expires } : {}),
  ...('supersededBy' in over ? { supersededBy: over.supersededBy } : {}),
});

await check('state is derived: active, expired, superseded, retired', () => {
  assert.equal(cardState(card(), NOW), 'active');
  assert.equal(cardState(card({ expires: NOW - 1 }), NOW), 'expired');
  assert.equal(cardState(card({ expires: NOW + DAY }), NOW), 'active', 'a future expiry is still current');
  assert.equal(cardState(card({ status: 'superseded' }), NOW), 'superseded');
  assert.equal(cardState(card({ status: 'retired' }), NOW), 'retired');
  assert.equal(cardState(card({ expires: NOW }), NOW), 'expired', 'the expiry instant itself counts as lapsed');
});

await check('an explicit withdrawal outranks expiry', () => {
  // Reporting a withdrawn card as merely expired would lose the reason it is gone.
  assert.equal(cardState(card({ status: 'retired', expires: NOW - DAY }), NOW), 'retired');
  assert.equal(cardState(card({ status: 'superseded', expires: NOW - DAY }), NOW), 'superseded');
});

await check('isLive is true only for cards with nothing to caveat', () => {
  assert.equal(isLive(card(), NOW), true);
  for (const over of [{ expires: NOW - 1 }, { status: 'superseded' }, { status: 'retired' }]) {
    assert.equal(isLive(card(over), NOW), false, JSON.stringify(over));
  }
});

await check('stateNote is empty for live cards and names the successor otherwise', () => {
  assert.equal(stateNote(card(), NOW), '');
  assert.equal(stateNote(card({ status: 'superseded', supersededBy: 'bbbbbbbbccccccccdddd' }), NOW), '⛔superseded → bbbbbbbb');
  assert.equal(stateNote(card({ status: 'retired' }), NOW), '✂retired');
  assert.equal(stateNote(card({ expires: NOW - 1 }), NOW), '⌛expired');
});

await check('resolveRef takes an id, a prefix, or a distinctive fragment', () => {
  const cards = [
    card({ id: 'aaaaaa11111111111111', summary: '第一条记忆：嵌入模型是 embed-gemma，768 维。' }),
    card({ id: 'bbbbbb22222222222222', summary: '第二条记忆：索引压缩用的是 zstd 多帧。' }),
  ];
  assert.equal(resolveRef(cards, 'aaaaaa11111111111111').how, 'id');
  assert.equal(resolveRef(cards, 'aaaaaa').how, 'id-prefix');
  assert.equal(resolveRef(cards, '索引压缩').how, 'summary');
  assert.ok('missing' in resolveRef(cards, 'zzzzzz'), 'unknown id is missing');
  assert.ok('missing' in resolveRef(cards, ''), 'empty reference is missing');
});

await check('an ambiguous reference is reported, never guessed', () => {
  const cards = [
    card({ id: 'aaaaaa11111111111111', time: NOW - 3 * DAY, summary: '记忆甲：嵌入模型更换为 embed-gemma。' }),
    card({ id: 'aaaaaa22222222222222', time: NOW - DAY, summary: '记忆乙：嵌入模型更换前是 bge-m3。' }),
  ];
  const byPrefix = resolveRef(cards, 'aaaaaa');
  assert.ok('ambiguous' in byPrefix, 'two cards share the prefix');
  assert.equal(byPrefix.ambiguous.length, 2);
  const byText = resolveRef(cards, '嵌入模型更换');
  assert.ok('ambiguous' in byText);
  assert.equal(byText.ambiguous[0].id, 'aaaaaa22222222222222', 'newest first, so the reader sees the latest first');
});

await check('lifecycle transitions are pure and do not mutate the input', () => {
  const cards = [card({ id: 'aaaaaa11111111111111' }), card({ id: 'bbbbbb22222222222222' })];
  const superseded = supersede(cards, 'aaaaaa11111111111111', 'bbbbbb22222222222222', NOW);
  assert.equal(cards[0].status, undefined, 'the input list is untouched');
  assert.equal(superseded[0].status, 'superseded');
  assert.equal(superseded[0].supersededBy, 'bbbbbb22222222222222');
  assert.equal(superseded[0].governedAt, NOW, 'when it changed is recorded');
  assert.equal(superseded[1].status, undefined);

  const retired = retire(cards, 'bbbbbb22222222222222', NOW);
  assert.equal(cards[1].status, undefined);
  assert.equal(retired[1].status, 'retired');

  assert.equal(dropCard(cards, 'aaaaaa11111111111111').length, 1);
  assert.equal(cards.length, 2, 'dropping is also pure');
});

await check('liveCards and dueToExpire split the store by state', () => {
  const cards = [
    card({ id: 'a'.repeat(20), time: NOW - 2 * DAY }),
    card({ id: 'b'.repeat(20), time: NOW - DAY }),
    card({ id: 'c'.repeat(20), status: 'retired' }),
    card({ id: 'd'.repeat(20), expires: NOW - DAY }),
  ];
  const live = liveCards(cards, NOW);
  assert.deepEqual(live.map((c) => c.id), ['b'.repeat(20), 'a'.repeat(20)], 'live only, newest first');
  assert.deepEqual(dueToExpire(cards, NOW).map((c) => c.id), ['d'.repeat(20)]);
});

await check('overlapSuggestions finds near-identical memories and ignores distant ones', () => {
  const cards = [
    card({ id: 'same'.padEnd(20, '0'), vector: packed(2) }),
    card({ id: 'other'.padEnd(20, '0'), vector: packed(9) }),
  ];
  const hits = overlapSuggestions(cards, probe(2), { threshold: 0.9, now: NOW });
  assert.equal(hits.length, 1, `expected one overlap, got ${hits.length}`);
  assert.equal(hits[0].card.id, 'same'.padEnd(20, '0'));
  assert.ok(hits[0].similarity > 0.9);
});

await check('a retired memory is not offered as a replacement candidate', () => {
  const cards = [card({ id: 'gone'.padEnd(20, '0'), vector: packed(2), status: 'retired' })];
  assert.equal(overlapSuggestions(cards, probe(2), { threshold: 0.5, now: NOW }).length, 0);
});

await check('cardEntries hides anything not current by default', () => {
  const query = probe(2);
  const cards = [
    card({ id: 'live'.padEnd(20, '0'), vector: packed(2) }),
    card({ id: 'old'.padEnd(20, '0'), vector: packed(2), status: 'superseded' }),
    card({ id: 'gone'.padEnd(20, '0'), vector: packed(2), status: 'retired' }),
    card({ id: 'lapsed'.padEnd(20, '0'), vector: packed(2), expires: NOW - DAY }),
  ];
  const live = cardEntries(cards, query, { now: NOW, minSimilarity: 0.5 });
  assert.deepEqual(live.map((e) => e.cardId), ['live'.padEnd(20, '0')], 'injection must not see a corrected fact');
  assert.equal(live[0].state, 'active');
  assert.equal(live[0].stateNote, '');
});

await check('cardEntries can include them on request — labelled, not hidden', () => {
  const query = probe(2);
  const cards = [
    card({ id: 'live'.padEnd(20, '0'), vector: packed(2) }),
    card({ id: 'old'.padEnd(20, '0'), vector: packed(2), status: 'superseded', supersededBy: 'live'.padEnd(20, '0') }),
    card({ id: 'gone'.padEnd(20, '0'), vector: packed(2), status: 'retired' }),
  ];
  const all = cardEntries(cards, query, { now: NOW, minSimilarity: 0.5, includeInactive: true });
  assert.equal(all.length, 3);
  const old = all.find((e) => e.cardId === 'old'.padEnd(20, '0'));
  assert.equal(old.state, 'superseded');
  assert.equal(old.supersededBy, 'live'.padEnd(20, '0'));
  assert.match(old.stateNote, /superseded/);
  const gone = all.find((e) => e.cardId === 'gone'.padEnd(20, '0'));
  assert.equal(gone.stateNote, '✂retired');
});

await check('the human-facing one-liner shows the lifecycle', () => {
  assert.doesNotMatch(formatCard(card()), /superseded|retired|expired/);
  assert.match(formatCard(card({ status: 'superseded', supersededBy: 'bbbbbbbbccccccccdddd' })), /⛔superseded/);
  assert.match(formatCard(card({ status: 'retired' })), /✂retired/);
});

await check('an injected or recalled memory carries the label, not just the state', () => {
  const rendered = renderRecall([
    { source: 'card', text: '嵌入模型是 1024 维。', time: NOW, session: 'note/2026-09-01', state: 'superseded', supersededBy: 'ffffffff00000000aaaa' },
    { source: 'card', text: '嵌入模型是 768 维。', time: NOW, session: 'note/2026-10-01', state: 'active' },
  ]);
  assert.match(rendered, /superseded by ffffffff/, 'the correction trail must be visible');
  assert.match(rendered, /do not treat as current/);
  assert.match(rendered, /written memory/, 'the current one still carries its normal provenance');
});

// ── persistence ────────────────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'gm-gov-'));
const store = join(dir, 'cards.ndjson');
process.env.DSH_G_MEMORY_CARD_MIRROR = 'off'; // the mirror is exercised elsewhere

await check('governance state survives a write and a read', async () => {
  await writeCards([card({ id: 'keep'.padEnd(20, '0') })], store);
  const before = await readCards(store);
  await writeCards([{ ...before[0], status: 'superseded', supersededBy: 'next'.padEnd(20, '0'), governedAt: NOW }], store);
  const after = await readCards(store);
  assert.equal(after.length, 1, 'the same id is updated, not duplicated');
  assert.equal(after[0].status, 'superseded');
  assert.equal(cardState(after[0], NOW), 'superseded');
});

await check('retiring keeps the card; a hard delete removes it', async () => {
  await writeCards([card({ id: 'second'.padEnd(20, '0'), hash: 'h2'.padEnd(20, '0'), time: NOW })], store);
  assert.equal((await readCards(store)).length, 2);

  const before = await readCards(store);
  await writeCards([{ ...before[1], status: 'retired', governedAt: NOW }], store);
  const retired = await readCards(store);
  assert.equal(retired.length, 2, 'retiring is not deleting');
  assert.equal(retired[1].status, 'retired');

  await rewriteCards(retired.filter((c) => c.id !== 'second'.padEnd(20, '0')), store);
  const afterDelete = await readCards(store);
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, 'keep'.padEnd(20, '0'));
});

await check('a rewritten store is still valid NDJSON', async () => {
  const raw = await readFile(store, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

await check('an empty store survives a rewrite', async () => {
  await rewriteCards([], store);
  assert.deepEqual(await readCards(store), []);
});

await rm(dir, { recursive: true, force: true });
delete process.env.DSH_G_MEMORY_CARD_MIRROR;

console.log(failures === 0 ? '\n  governance: all checks passed\n' : `\n  governance: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
