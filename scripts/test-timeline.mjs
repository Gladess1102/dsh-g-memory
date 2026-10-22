#!/usr/bin/env node
/**
 * Timeline unit checks: month bucketing, extractive summaries, month selection.
 *
 * These are pure functions over an in-memory unit list — no index, no plugin, no
 * collection. Two properties matter for integration: determinism (two builds over
 * the same units must deep-equal, or a month bucket cannot be cached or compared
 * across runs) and bounded output (a summary is a fixed-size index entry and must
 * not grow with the corpus).
 *
 *   node scripts/test-timeline.mjs
 */
import assert from 'node:assert/strict';
import {
  buildTimeline,
  selectMonths,
  DEFAULT_SUMMARY_CHARS,
  SAMPLE_MAX_CHARS,
  SUMMARY_TEXT_CHARS,
  SUMMARY_UNIT_COUNT,
  UNKNOWN_MONTH,
} from '../lib/timeline.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  ✅ ' + name); }
  catch (error) { failures += 1; console.log('  ❌ ' + name + '\n       ' + error.message); }
};

/**
 * Fixture timestamps are built in UTC because that is the frame the month key
 * uses. `new Date(y, m, d)` would make the expected months depend on the host's
 * time zone — the exact failure mode the implementation's UTC choice avoids.
 */
const at = (year, month, day) => Date.UTC(year, month - 1, day, 12);

/** A unit shaped like `IndexedUnit`, minus the fields the timeline never reads. */
const unit = (text, time) => ({
  text, role: 'user', session: 'session-timeline', seq: 0, time, hash: 'hash', vector: Buffer.alloc(0),
});

/** Long enough to clear the summary's minimum unit length. */
const longText = (label) => label + '：这是一段足够长的记忆内容用于抽取式摘要';

/** Characters (code points), the unit the summary limits are expressed in. */
const chars = (text) => Array.from(text).length;

await check('groups units by month, and files unusable timestamps as unknown', async () => {
  const units = [
    unit(longText('九月'), at(2026, 9, 10)),
    unit(longText('十月一'), at(2026, 10, 2)),
    unit(longText('十月二'), at(2026, 10, 20)),
    unit(longText('无时间'), Number.NaN),
  ];
  const timeline = buildTimeline(units);

  assert.deepEqual(timeline.months.map((bucket) => bucket.month), ['2026-10', '2026-09', UNKNOWN_MONTH]);
  assert.equal(timeline.months[0].count, 2, 'both October units belong to one bucket');
  assert.deepEqual(timeline.months[0].unitIndices, [1, 2], 'indices stay in units order');
  assert.equal(timeline.months[1].count, 1);
  assert.equal(timeline.months[2].count, 1);
  assert.deepEqual(timeline.months[2].unitIndices, [3]);
});

await check('reports months newest first and never puts unknown on top', async () => {
  const timeline = buildTimeline([
    unit(longText('旧年'), at(2026, 12, 20)),
    unit(longText('新年'), at(2027, 1, 4)),
    unit(longText('未知'), null),
  ]);
  assert.deepEqual(timeline.months.map((bucket) => bucket.month), ['2027-01', '2026-12', UNKNOWN_MONTH]);
  assert.notEqual(timeline.months[0].month, UNKNOWN_MONTH, 'a caller reads months[0] as the newest real month');
});

await check('byIndex answers the month for every unit, including unknown ones', async () => {
  const timeline = buildTimeline([
    unit(longText('九月'), at(2026, 9, 10)),
    unit(longText('十月'), at(2026, 10, 2)),
    unit(longText('无时间'), undefined),
  ]);
  assert.equal(timeline.byIndex.size, 3);
  assert.equal(timeline.byIndex.get(0), '2026-09');
  assert.equal(timeline.byIndex.get(1), '2026-10');
  assert.equal(timeline.byIndex.get(2), UNKNOWN_MONTH);
});

await check('two builds over the same units are deep-equal (deterministic)', async () => {
  const units = Array.from({ length: 7 }, (_, i) => ({
    ...unit(longText('记忆' + i), at(2026, 10, 1 + i)),
    seq: i,
  }));
  const first = buildTimeline(units);
  const second = buildTimeline(units);
  assert.deepEqual(second.months, first.months);
  assert.deepEqual([...second.byIndex.entries()], [...first.byIndex.entries()]);
});

await check('caps the summary at the default limit and at a requested one', async () => {
  const units = Array.from({ length: 30 }, (_, i) => unit(longText('记忆' + i), at(2026, 10, 1 + (i % 20))));
  const loose = buildTimeline(units).months[0];
  assert.ok(loose.summary.length > 0, 'a month with content must produce a summary');
  assert.ok(chars(loose.summary) <= DEFAULT_SUMMARY_CHARS, 'default cap, got ' + chars(loose.summary));
  assert.ok(loose.summary.split(' / ').length <= SUMMARY_UNIT_COUNT, 'at most 12 entries');

  const tight = buildTimeline(units, { maxSummaryChars: 80 }).months[0];
  assert.ok(chars(tight.summary) > 0);
  assert.ok(chars(tight.summary) <= 80, 'requested cap, got ' + chars(tight.summary));
  assert.ok(chars(tight.summary) < chars(loose.summary), 'a tighter cap must actually shorten');

  // A malformed cap means "unset", never "zero".
  for (const bogus of [0, -5, Number.NaN, 'abc']) {
    assert.equal(buildTimeline(units, { maxSummaryChars: bogus }).months[0].summary, loose.summary,
      'cap ' + String(bogus) + ' must fall back to the default');
  }
});

await check('cuts on entry boundaries, never mid-entry', async () => {
  const units = Array.from({ length: 12 }, (_, i) => unit(longText('记忆' + i), at(2026, 10, 1 + i)));
  const bucket = buildTimeline(units, { maxSummaryChars: 80 }).months[0];
  const parts = bucket.summary.split(' / ');
  assert.ok(parts.length >= 1);
  assert.ok(chars(bucket.summary) <= 80);
  assert.notEqual(bucket.summary.slice(-3), ' / ', 'no dangling separator');
  for (const part of parts) {
    assert.ok(part.length > 0, 'every retained entry is a real excerpt');
    assert.equal(part.indexOf('\n'), -1);
  }
});

await check('keeps each entry within 60 characters and drops duplicates', async () => {
  const units = [
    unit(longText('重复条目'), at(2026, 10, 1)),
    unit(longText('重复条目'), at(2026, 10, 2)),
    unit(longText('不同条目'), at(2026, 10, 3)),
  ];
  const parts = buildTimeline(units).months[0].summary.split(' / ');
  assert.equal(parts.length, 2, 'the duplicate must not consume a slot');
  assert.equal(new Set(parts).size, 2);
  for (const part of parts) assert.ok(chars(part) <= SUMMARY_TEXT_CHARS, 'entry length ' + chars(part));
});

await check('flattens newlines, because an entry has one line to spend', async () => {
  const units = [unit('第一行记忆内容\n第二行记忆内容\r\n第三行记忆内容', at(2026, 10, 1))];
  const summary = buildTimeline(units).months[0].summary;
  assert.doesNotMatch(summary, /[\r\n]/);
  assert.match(summary, /第一行记忆内容 第二行记忆内容/);
});

await check('truncation never splits a surrogate pair', async () => {
  const units = [unit('😀'.repeat(40) + '这条记忆里有很多表情符号', at(2026, 10, 1))];
  const summary = buildTimeline(units).months[0].summary;
  assert.doesNotMatch(summary, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'lone high surrogate');
  assert.doesNotMatch(summary, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'lone low surrogate');
  assert.ok(chars(summary) <= SUMMARY_TEXT_CHARS);
});

await check('the sample is bounded independently of the summary', async () => {
  const units = Array.from({ length: 40 }, (_, i) => unit(longText('样本' + i), at(2026, 10, 1 + (i % 20))));
  const bucket = buildTimeline(units).months[0];
  assert.ok(chars(bucket.sample) <= SAMPLE_MAX_CHARS, 'sample chars ' + chars(bucket.sample));
  assert.ok(bucket.sample.length > 0);
});

await check('selectMonths finds a month by Chinese query', async () => {
  const timeline = buildTimeline([
    unit('十月：数据库迁移方案评审已经通过，下一步是灰度发布', at(2026, 10, 8)),
    unit('九月：重构了召回管线的加权逻辑，并补了单元测试', at(2026, 9, 12)),
  ]);
  assert.deepEqual(selectMonths(timeline, '数据库迁移'), ['2026-10']);
});

await check('selectMonths returns [] when nothing overlaps, and for a blank query', async () => {
  const timeline = buildTimeline([unit(longText('数据库迁移'), at(2026, 10, 8))]);
  assert.deepEqual(selectMonths(timeline, '完全不相关的英文 zzz'), []);
  assert.deepEqual(selectMonths(timeline, ''), []);
  assert.deepEqual(selectMonths(timeline, '   '), []);
  assert.deepEqual(selectMonths(timeline, undefined), []);
});

await check('selectMonths honours limit and minScore', async () => {
  const timeline = buildTimeline([
    unit('十月：部署脚本与数据库迁移都在今天完成，记录一下细节', at(2026, 10, 5)),
    unit('九月：部署流程的文档补全，以及一些历史背景说明', at(2026, 9, 8)),
  ]);

  // Both months contain 部署, so the newer one wins the tie and limit trims the rest.
  assert.deepEqual(selectMonths(timeline, '部署'), ['2026-10', '2026-09']);
  assert.deepEqual(selectMonths(timeline, '部署', { limit: 1 }), ['2026-10']);

  // 数据 appears only in October: October scores 2/2, September 1/2.
  assert.deepEqual(selectMonths(timeline, '部署 数据', { minScore: 0.8 }), ['2026-10']);
  assert.deepEqual(selectMonths(timeline, '部署 数据', { minScore: 0.2 }), ['2026-10', '2026-09']);
});

await check('selectMonths matches a whole query by substring', async () => {
  // "migrat" shares no token with "migration", yet its presence is a clear signal.
  const timeline = buildTimeline([unit('October: the migration plan for the index rework', at(2026, 10, 3))]);
  assert.deepEqual(selectMonths(timeline, 'migrat'), ['2026-10']);
  assert.deepEqual(selectMonths(timeline, 'migrat', { minScore: 0.5 }), ['2026-10']);
});

await check('empty and malformed input never throws', async () => {
  for (const input of [[], undefined, null, 'not a list', 42]) {
    const timeline = buildTimeline(input);
    assert.deepEqual(timeline.months, [], 'input ' + String(input));
    assert.equal(timeline.byIndex.size, 0);
    assert.deepEqual(selectMonths(timeline, '任何查询'), []);
  }
  assert.deepEqual(selectMonths(null, '任何查询'), []);

  // Junk rows are filed as unknown rather than crashing the build.
  const junk = buildTimeline([null, undefined, 42, 'text', { text: '有效文本' }]);
  assert.equal(junk.months.length, 1);
  assert.equal(junk.months[0].month, UNKNOWN_MONTH);
  assert.equal(junk.months[0].count, 5);
});

await check('a corpus with only unusable timestamps still builds one unknown bucket', async () => {
  const units = [
    unit(longText('一条记忆'), 0),
    unit(longText('一条记忆'), -1),
    unit(longText('一条记忆'), Number.NaN),
    unit(longText('一条记忆'), Infinity),
    unit(longText('一条记忆'), 1e300),
    unit(longText('一条记忆'), null),
  ];
  const timeline = buildTimeline(units);
  assert.deepEqual(timeline.months.map((bucket) => bucket.month), [UNKNOWN_MONTH]);
  assert.equal(timeline.months[0].count, 6);
  for (let i = 0; i < units.length; i += 1) assert.equal(timeline.byIndex.get(i), UNKNOWN_MONTH);
  assert.deepEqual(selectMonths(timeline, '记忆'), [UNKNOWN_MONTH], 'the unknown bucket is still searchable');
});

await check('a normal month is not mistaken for unknown, nor a far-future row for a month', async () => {
  const timeline = buildTimeline([
    unit(longText('正常时间'), at(2026, 10, 15)),
    unit(longText('远未来'), 8.64e15),
  ]);
  assert.equal(timeline.byIndex.get(0), '2026-10');
  assert.equal(timeline.byIndex.get(1), UNKNOWN_MONTH, 'a year past 9999 cannot keep the key fixed-width');
});

console.log(failures === 0
  ? '\n  timeline: all checks passed\n'
  : '\n  timeline: ' + failures + ' failed\n');
process.exit(failures === 0 ? 0 : 1);
