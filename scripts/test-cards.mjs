#!/usr/bin/env node
/** Cards, consolidation gate, and the index quality filter. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCard, readCards, writeCards, withVector, searchCards, tagIndex, lastSkippedCards } from '../lib/cards.mjs';
import { ConsolidationTracker, readConsolidationState, writeConsolidationState } from '../lib/consolidate.mjs';
import { isLowInformation } from '../lib/chunker.mjs';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (error) { fail += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
}
const dir = mkdtempSync(join(tmpdir(), 'cards-'));
const store = join(dir, 'cards.ndjson');
const vec = (n) => { const v = new Float32Array(1024); v[n] = 1; return v; };

await check('parseCard strips fences, a 摘要: prefix and reads the Tag line', () => {
  const c = parseCard('```\n摘要：会话日志的压缩比实测为 5.95 倍，36 个日志共 31.7 MB。\nTag: 记忆系统, 压缩\n```', { session: 's1' });
  assert.equal(c.summary, '会话日志的压缩比实测为 5.95 倍，36 个日志共 31.7 MB。');
  assert.deepEqual(c.tags, ['记忆系统', '压缩']);
  assert.equal(c.session, 's1');
});

await check('parseCard rejects text too short to be a memory', () => {
  assert.equal(parseCard('好的', {}), null);
  assert.equal(parseCard('', {}), null);
});

await check('writeCards merges by id instead of duplicating', async () => {
  const a = parseCard('第一张卡片，记录了会话日志压缩比实测为 5.95 倍这个具体的技术结论。', { session: 's1' });
  const b = parseCard('第二张卡片，记录 BGE-M3 嵌入维度为 1024 这个具体的技术事实。', { session: 's2' });
  await writeCards([withVector(a, vec(0))], store);
  await writeCards([withVector(b, vec(1))], store);
  const again = await writeCards([withVector(a, vec(0))], store);
  assert.equal((await readCards(store)).length, 2, 're-writing the same card must not duplicate it');
  assert.equal(again.total, 2);
});

await check('searchCards ranks in the shared embedding space', async () => {
  const cards = await readCards(store);
  const hit = searchCards(cards, vec(0), { limit: 1 });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].card.session, 's1');
});

await check('a human edit in the mirror overrides the stored card', async () => {
  const mirror = join(dir, 'cards', 'MEMORY.md');
  const cards = await readCards(store);
  const target = cards[0];
  const before = readFileSync(mirror, 'utf8');
  assert.ok(before.includes(target.summary), 'the mirror must contain the card body');
  // The edit a person would make: type over the body, leave everything else.
  writeFileSync(mirror, before.replace(target.summary, '人工修正后的正文，替换掉机器写的那一版，并保留足够长度。'));
  const reread = await readCards(store);
  const edited = reread.find((c) => c.id === target.id);
  assert.match(edited.summary, /人工修正后的正文/, 'the human edit must win');
  assert.equal(edited.editedByHuman, true);
  // The id is content-derived, so an edit makes a distinct memory rather than
  // silently overwriting the machine's version under the same identity.
  assert.notEqual(edited.hash, target.hash);
});

await check('two concurrent writes keep both cards', async () => {
  // Both used `process.pid` in the temp name and merged onto the same snapshot,
  // so one write threw ENOENT and the survivor dropped the other's card.
  const path = join(dir, 'concurrent.ndjson');
  const a = parseCard('并发写入的第一张卡片，正文必须超过三十个字符才能通过解析检查，所以这里写长一点。', { session: 'c1' });
  const b = parseCard('并发写入的第二张卡片，正文同样必须超过三十个字符才能通过解析检查。', { session: 'c2' });
  const results = await Promise.allSettled([writeCards([a], path), writeCards([b], path)]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.equal((await readCards(path)).length, 2, 'both cards must survive');
});

await check('a refusal is not stored as a card', async () => {
  // `parseCard` claims to reuse the synthesiser's classifier and did not, so a
  // refusal became a retrievable card with a vector behind it.
  const path = join(dir, 'refusal.ndjson');
  const refusal = { id: 'r1', session: 's', time: Date.now(), summary: '未找到相关记忆。', tags: [] };
  const out = await writeCards([refusal], path);
  assert.equal(out.refused, 1);
  assert.equal((await readCards(path)).length, 0);
});

await check('damaged rows are counted, and preserved when the store is rewritten', async () => {
  const path = join(dir, 'damaged.ndjson');
  const good = JSON.stringify({ id: 'g1', session: 's', time: Date.now(), summary: '一条完好的卡片，长度足够通过解析检查。', tags: [] });
  writeFileSync(path, `${good}\n{"id":"broken","summary":\n`);
  const cards = await readCards(path);
  assert.equal(cards.length, 1);
  assert.equal(lastSkippedCards, 1);
  await writeCards([], path);
  const backups = readdirSync(dir).filter((f) => f.startsWith('damaged.ndjson.damaged-'));
  assert.equal(backups.length, 1, 'the unparseable line must survive the rewrite');
});

await check('the mirror switch also gates reading', async () => {
  const path = join(dir, 'mirror.ndjson');
  const card = parseCard('镜像里这张卡片会被人工改写，正文超过三十个字符才能通过解析检查。', { session: 'm1' });
  await writeCards([card], path);
  const mirror = join(dir, 'cards', 'MEMORY.md');
  writeFileSync(mirror, readFileSync(mirror, 'utf8').replace(card.summary, '人工改写后的正文内容，同样要超过三十个字符才能通过解析检查。'));
  process.env.DSH_G_MEMORY_CARD_MIRROR = 'off';
  try {
    const off = await readCards(path);
    assert.equal(off[0].summary, card.summary, 'with the mirror off, the store is authoritative');
  } finally { delete process.env.DSH_G_MEMORY_CARD_MIRROR; }
  const on = await readCards(path);
  assert.match(on[0].summary, /人工改写后的正文内容/, 'with the mirror on, the edit wins');
});

await check('the same content recorded twice is stored once', async () => {
  // The id is sha1(session + summary), so a note repeated on another day — a
  // different session string — used to become a second card. `hash` is the
  // content identity and is what dedup reads now.
  const path = join(dir, 'dedup.ndjson');
  const text = '同一条判断在两天里各记一次，内容完全相同，应当只留一张卡片。';
  const first = parseCard(text, { session: 'note/2026-09-23' });
  const second = parseCard(text, { session: 'note/2026-09-24' });
  assert.notEqual(first.id, second.id, 'the ids genuinely differ — that is why the hash is needed');
  await writeCards([first], path);
  const out = await writeCards([second], path);
  assert.equal(out.duplicates, 1);
  assert.equal(out.added, 0);
  assert.equal((await readCards(path)).length, 1, 'the store must still hold one card');
});

await check('the store is written before the mirror', async () => {
  // The mirror takes precedence on read, so writing it first meant a failed store
  // write left it showing a card the store did not have.
  const path = join(dir, 'ordering', 'cards.ndjson');
  mkdirSync(dirname(path), { recursive: true });
  const card = parseCard('写入顺序测试用的卡片，正文需要超过三十个字符才能通过解析检查。', { session: 'order/1' });
  await writeCards([card], path);
  const mirror = join(dir, 'ordering', 'cards', 'MEMORY.md');
  assert.match(readFileSync(mirror, 'utf8'), /写入顺序测试用的卡片/);

  // Now make the store unwritable and confirm the mirror is not updated.
  const before = readFileSync(mirror, 'utf8');
  rmSync(path, { force: true });
  mkdirSync(path); // a directory where the file should be → the atomic replace fails
  const another = parseCard('这一张不应该出现在镜像里，因为存储写入会失败，正文同样要够长。', { session: 'order/2' });
  await writeCards([another], path).catch(() => {});
  assert.equal(readFileSync(mirror, 'utf8'), before, 'the mirror must not run ahead of the store');
});

await check('tagIndex aggregates tags across cards', async () => {
  const tagged = parseCard('带标签的卡片，记录压缩比 5.95 倍与嵌入维度 1024 两个事实。\nTag: 压缩, 嵌入', { session: 's3' });
  const cards = [...await readCards(store), tagged];
  const tags = tagIndex(cards);
  assert.deepEqual(tags.map(([t]) => t).sort(), ['压缩', '嵌入']);
  assert.ok(tags.every(([, n]) => n === 1));
});

await check('the consolidation gate needs BOTH time and material', () => {
  const cfg = { enabled: true, minIntervalHours: 24, minTurns: 5, minSessionTurns: 3, idleMs: 600_000 };
  let now = 1000;
  const t = new ConsolidationTracker(cfg, () => now);
  assert.equal(t.shouldRun().run, false, 'no material yet');
  for (let i = 0; i < 6; i += 1) t.note('s1');
  assert.equal(t.shouldRun().run, false, 'material but not enough time');
  now = 99 * 3_600_000;
  assert.equal(t.shouldRun().run, true, 'both conditions met');
});

await check('a picked session is not picked twice', () => {
  const cfg = { enabled: true, minIntervalHours: 0, minTurns: 1, minSessionTurns: 2, idleMs: 1000 };
  let now = 10_000;
  const t = new ConsolidationTracker(cfg, () => now);
  t.note('a'); t.note('a');
  now += 10_000;                       // let the session go idle
  assert.deepEqual(t.pick(), ['a']);
  assert.deepEqual(t.pick(), [], 'a failed run must not retry forever');
});

await check('a failed distillation keeps its material and retries', () => {
  // Picking used to zero `turns` immediately: one throw — an embedding endpoint
  // that is down is enough — and the session's material was gone with no receipt.
  let t = 0;
  const tracker = new ConsolidationTracker({ enabled: true, minTurns: 1, minSessionTurns: 2, idleMs: 1_000 }, () => t);
  tracker.note('s1'); tracker.note('s1');
  t += 10_000;
  const first = tracker.pick();
  assert.deepEqual(first, ['s1']);
  assert.deepEqual(tracker.pick(), [], 'a reserved session is not picked again');
  tracker.settle(first, ['s1']);
  assert.deepEqual(tracker.pick(), ['s1'], 'the material survives a failure and is offered again');
  tracker.settle(['s1'], ['s1']);
  tracker.settle(['s1'], ['s1']);
  assert.deepEqual(tracker.pick(), [], 'but not forever: attempts are bounded');
});

await check('a successful distillation clears the material', () => {
  let t = 0;
  const tracker = new ConsolidationTracker({ enabled: true, minTurns: 1, minSessionTurns: 2, idleMs: 1_000 }, () => t);
  tracker.note('s2'); tracker.note('s2');
  t += 10_000;
  const picked = tracker.pick();
  tracker.settle(picked, []);
  assert.deepEqual(tracker.pick(), [], 'a distilled session has nothing pending');
  assert.equal(tracker.stats().sessions, 1, 'but it is still tracked');
});

await check('crash recovery releases reservations', () => {
  let t = 0;
  const tracker = new ConsolidationTracker({ enabled: true, minTurns: 1, minSessionTurns: 1, idleMs: 0 }, () => t);
  tracker.note('s3');
  t += 10_000;
  assert.deepEqual(tracker.pick(), ['s3']);
  tracker.releaseAll();
  assert.deepEqual(tracker.pick(), ['s3'], 'a reservation must not survive the process that took it');
});

await check('the interval gate survives a restart', async () => {
  // `lastRunAt` came from an environment variable nothing ever wrote, so every new
  // process started at 0 and the interval half of the gate passed immediately.
  const path = join(dir, 'consolidate-state.json');
  const now = 1_800_000_000_000;
  await writeConsolidationState(now, path);
  const restored = await readConsolidationState(path);
  assert.equal(restored.lastRunAt, now);
  const tracker = new ConsolidationTracker({ enabled: true, minIntervalHours: 24, minTurns: 0 }, () => now + 3_600_000);
  tracker.lastRunAt = restored.lastRunAt;
  const verdict = tracker.shouldRun();
  assert.equal(verdict.run, false, 'an hour after a run is inside a 24-hour interval');
  assert.match(verdict.why, /interval/);
  assert.equal((await readConsolidationState(join(dir, 'absent.json'))).lastRunAt, 0);
});

await check('a session below the minimum is never distilled', () => {
  const t = new ConsolidationTracker({ enabled: true, minIntervalHours: 0, minTurns: 1, minSessionTurns: 3, idleMs: 0 }, () => 1e12);
  t.note('a'); t.note('b');
  assert.deepEqual(t.pick(), []);
});

await check('the quality filter only drops text that cannot carry a fact', () => {
  for (const t of ['好的', '继续', '嗯', '谢谢！', 'ok', 'OK']) assert.equal(isLowInformation(t), true, `should drop: ${t}`);
  for (const t of ['端口是 11435', '用 BGE-M3', '压缩比 5.95 倍', 'docs/policy.mjs 里加了门控',
    '我们决定采用索引式与抽取式共存的双层架构']) {
    assert.equal(isLowInformation(t), false, `must keep: ${t}`);
  }
});

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail === 0 ? 0 : 1;
