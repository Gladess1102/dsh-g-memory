#!/usr/bin/env node
/**
 * VCP 2.0 适配器的集成检查：精确臂进 RRF、时间分层加权、以及两个开关。
 *
 * 单测覆盖的是 lib/exact.mjs 与 lib/timeline.mjs 各自的行为；这里验证的是
 * 接进 MemoryIndex.recall 之后排序真的变了——单测全绿但没接上，正是这次
 * 移植最可能的失败形态。
 *
 *   node scripts/test-vcp-arms.mjs
 */
import assert from 'node:assert/strict';
import { MemoryIndex } from '../lib/store.mjs';
import { packVector } from '../lib/vector.mjs';
import { parseExactQuery, searchExact } from '../lib/exact.mjs';
import { buildTimeline, selectMonths } from '../lib/timeline.mjs';
import { AutoRecall } from '../lib/auto-recall.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  ✅ ' + name); }
  catch (error) { failures += 1; console.log('  ❌ ' + name + '\n       ' + error.message); }
};

const DIM = 2;
/** A unit whose int8 vector points at [a, b] (normalised by the packer). */
const unit = (text, time, a, b) => ({
  text,
  role: 'user',
  session: 's1',
  seq: 0,
  time,
  hash: String(text.length),
  vector: packVector([Math.round(a * 100), Math.round(b * 100)], 1 / 100),
});

const at = (iso) => new Date(iso + 'T12:00:00Z').getTime();
const units = [
  unit('the deploy script needs a rollback path', at('2026-10-15'), 1, 0),
  unit('unrelated cooking notes about soup', at('2026-08-01'), 0, 1),
  unit('deploy script rollback procedure', at('2026-08-20'), 0.7, 0.7),
  unit('refactor of the migration runner', at('2026-10-02'), 0.9, 0.1),
];
const index = new MemoryIndex({ version: 1, dim: DIM, builtAt: 1, model: 'test', units });
const queryVector = new Float32Array([1, 0]);

const recall = (query, extra = {}) => index.recall(queryVector, query, { k: 4, ...extra });

await check('exact arm promotes a literal phrase hit to the top', async () => {
  const parsed = parseExactQuery('"deploy script" please');
  const arm = searchExact(units, parsed, { limit: 4 }).map((hit) => hit.index);
  assert.ok(arm.length > 0, 'the phrase must match at least one unit');
  const fused = recall('"deploy script" please', { exactArm: arm });
  assert.equal(fused[0].index, 0, 'the exact-only unit must win the fusion');
});

await check('no exact arm leaves the two-arm ordering alone', async () => {
  const a = recall('deploy script rollback');
  const b = recall('deploy script rollback', { exactArm: null });
  assert.deepEqual(a, b);
});

await check('an empty exact arm is ignored, not fused as a zero-score ranking', async () => {
  const a = recall('cooking notes');
  const b = recall('cooking notes', { exactArm: [] });
  assert.deepEqual(a, b);
});

await check('timeline builds the months the units actually fall in', async () => {
  const timeline = buildTimeline(units);
  assert.deepEqual(timeline.months.map((m) => m.month).sort(), ['2026-08', '2026-10']);
  assert.equal(timeline.byIndex.get(0), '2026-10');
  assert.equal(timeline.byIndex.get(1), '2026-08');
});

await check('selectMonths matches a digest word from the query', async () => {
  const timeline = buildTimeline(units);
  const months = selectMonths(timeline, 'migration runner refactor', { limit: 3 });
  assert.ok(months.includes('2026-10'), 'expected 2026-10, got ' + JSON.stringify(months));
});

await check('the timeline nudge reorders the fused list in favour of the month', async () => {
  const recallObj = new AutoRecall({ logger: { debug() {} }, on: () => () => {} }, {
    auto: { exact: true, timelineBoost: 0.5 },
  });
  const base = recall('migration runner refactor');
  const boosted = recallObj._boostByTimeline(base, index, 'migration runner refactor');
  const before = base.findIndex((hit) => hit.index === 3);
  const after = boosted.findIndex((hit) => hit.index === 3);
  assert.ok(after <= before, 'the October unit must not fall behind after the nudge');
});

await check('timelineBoost=0 disables the nudge entirely', async () => {
  const recallObj = new AutoRecall({ logger: { debug() {} }, on: () => () => {} }, {
    auto: { exact: true, timelineBoost: 0 },
  });
  const base = recall('migration runner refactor');
  assert.deepEqual(recallObj._boostByTimeline(base, index, 'migration runner refactor'), base);
});

if (failures > 0) {
  console.log('\n  ' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('\n  vcp arms: all checks passed');
