#!/usr/bin/env node
/**
 * Exact-arm checks: parsing quoted phrases, dates, tags and paths out of a
 * query, then scoring units against them.
 *
 * These are pure functions, so there is no index and no server here: what is
 * asserted is exactly what the fusion layer consumes. Timestamps are built on
 * the LOCAL calendar on purpose — the arm compares local days, and a UTC-built
 * fixture would shift by one day on any machine west of UTC, which is the sort
 * of test that passes in Shanghai and fails in CI.
 *
 *   node scripts/test-exact.mjs
 */
import assert from 'node:assert/strict';
import { parseExactQuery, searchExact } from '../lib/exact.mjs';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failures += 1; console.log(`  ❌ ${name}\n       ${error.message}`); }
};

/** Noon on a calendar day; noon keeps every zone and DST edge on the same day. */
const at = (year, month, day) => new Date(year, month - 1, day, 12, 0, 0).getTime();

/**
 * searchExact reads only text and time, so the rest of IndexedUnit is left out:
 * a fixture that carries a vector would suggest this arm owns one.
 */
const makeUnit = (text, time = at(2026, 10, 22)) => ({ text, time });

const EMPTY = { phrases: [], dates: [], tags: [], paths: [], rest: '' };

await check('all four quote styles are parsed as phrases', async () => {
  const parsed = parseExactQuery('"double" \'single\' “中文” 「角」');
  assert.deepEqual(parsed.phrases, ['double', 'single', '中文', '角']);
  assert.equal(parsed.rest, '');
});

await check('a contraction does not open a phrase', async () => {
  // The naive single-quote regex reads "it's a 'test'" as a phrase starting
  // inside "it's"; the guards on both sides of the ASCII quote are what stop it.
  const parsed = parseExactQuery("don't 认为 it's fine");
  assert.deepEqual(parsed.phrases, []);
  assert.equal(parsed.rest, "don't 认为 it's fine");
});

await check('dates parse with and without a day, in both separators', async () => {
  assert.deepEqual(parseExactQuery('2026-10').dates, [{ year: 2026, month: 10 }]);
  assert.deepEqual(parseExactQuery('2026/10/22').dates, [{ year: 2026, month: 10, day: 22 }]);
  assert.deepEqual(parseExactQuery('2026-1-5').dates, [{ year: 2026, month: 1, day: 5 }]);
});

await check('an impossible month or day yields no date and stays in rest', async () => {
  // Dropping the text as well would lose a token no other arm can match, which
  // the user experiences as "the search ignored my words".
  for (const query of ['2026-13', '2026-0', '2026-10-32', '2026-10-0']) {
    const parsed = parseExactQuery(query + ' 的笔记');
    assert.deepEqual(parsed.dates, [], query + ' must not parse as a date');
    assert.equal(parsed.rest, query + ' 的笔记', query + ' must survive into rest');
  }
});

await check('tags are recognised in both spellings and de-duplicated', async () => {
  const parsed = parseExactQuery('#vcp tag:记忆 tag:VCP #记忆');
  assert.deepEqual(parsed.tags, ['vcp', '记忆'], 'case and prefix are not part of the name');
  assert.equal(parsed.rest, '');
});

await check('paths are recognised by separator or extension', async () => {
  const parsed = parseExactQuery('看 lib/store.mjs 和 docs/plan.md 和 notes/ 以及 package.json');
  assert.deepEqual(parsed.paths, ['lib/store.mjs', 'docs/plan.md', 'notes/', 'package.json']);
});

await check('a version number is not a path', async () => {
  // "1.5" matches the contract's extension regex, but treating it as a path is
  // a false positive that would promote every unit mentioning a version.
  const parsed = parseExactQuery('升级到 v1.2 和 GPT-5.2 以及 1.5 倍');
  assert.deepEqual(parsed.paths, []);
});

await check('a sentence-final period is not part of a path', async () => {
  const parsed = parseExactQuery('see docs/plan.md.');
  assert.deepEqual(parsed.paths, ['docs/plan.md']);
  assert.equal(parsed.rest, 'see');
});

await check('rest keeps only what no exact token claimed', async () => {
  const parsed = parseExactQuery('"数据库迁移" 2026-10-22 #vcp docs/plan.md 的其余文字');
  assert.deepEqual(parsed.phrases, ['数据库迁移']);
  assert.deepEqual(parsed.dates, [{ year: 2026, month: 10, day: 22 }]);
  assert.deepEqual(parsed.tags, ['vcp']);
  assert.deepEqual(parsed.paths, ['docs/plan.md']);
  assert.equal(parsed.rest, '的其余文字');
});

await check('a query made only of exact tokens leaves rest empty', async () => {
  assert.equal(parseExactQuery('"one" #two three/four.md 2026-11').rest, '');
});

await check('a quoted span is claimed once, not re-read as a date or tag', async () => {
  // One substring, one arm: otherwise the unit is scored twice and the rest
  // rewrite overwrites the same range from both ends.
  const parsed = parseExactQuery('"2026-10-22 #vcp" 补充');
  assert.deepEqual(parsed.phrases, ['2026-10-22 #vcp']);
  assert.deepEqual(parsed.dates, []);
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.rest, '补充');
});

await check('a slashed date is a date, not a path', async () => {
  const parsed = parseExactQuery('2026/10/22 的会议');
  assert.deepEqual(parsed.dates, [{ year: 2026, month: 10, day: 22 }]);
  assert.deepEqual(parsed.paths, []);
});

await check('a line anchor belongs to the path, not to the tags', async () => {
  const parsed = parseExactQuery('见 docs/plan.md#L24 那里');
  assert.deepEqual(parsed.paths, ['docs/plan.md#L24']);
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.rest, '见 那里');
});

await check('empty and non-string input is handled without throwing', async () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.deepEqual(parseExactQuery(value), EMPTY);
  }
  assert.deepEqual(searchExact([], parseExactQuery('"x"')), []);
  assert.deepEqual(searchExact(null, parseExactQuery('"x"')), []);
  assert.deepEqual(searchExact([makeUnit('x')], null), []);
  assert.deepEqual(searchExact([makeUnit('x')], {}), []);
});

await check('a phrase matches case-insensitively and scores +3', async () => {
  const units = [makeUnit('the README is the entry point'), makeUnit('nothing here')];
  assert.deepEqual(searchExact(units, parseExactQuery('"readme"')), [
    { index: 0, score: 3, kind: 'phrase' },
  ]);
});

await check('two phrases on one unit add up', async () => {
  const units = [makeUnit('alpha and beta'), makeUnit('alpha only')];
  const hits = searchExact(units, parseExactQuery('"alpha" "beta"'));
  assert.deepEqual(hits, [
    { index: 0, score: 6, kind: 'phrase' },
    { index: 1, score: 3, kind: 'phrase' },
  ]);
});

await check('a date scores the day +3 and the same month +1', async () => {
  const units = [
    makeUnit('同一天', at(2026, 10, 22)),
    makeUnit('同月另一天', at(2026, 10, 3)),
    makeUnit('别的月', at(2026, 11, 22)),
  ];
  assert.deepEqual(searchExact(units, parseExactQuery('2026-10-22')), [
    { index: 0, score: 3, kind: 'date' },
    { index: 1, score: 1, kind: 'date' },
  ]);
});

await check('a month-only date scores +1 for that month', async () => {
  const units = [makeUnit('十月', at(2026, 10, 3)), makeUnit('十一月', at(2026, 11, 3))];
  assert.deepEqual(searchExact(units, parseExactQuery('2026-10')), [
    { index: 0, score: 1, kind: 'date' },
  ]);
});

await check('mixed kinds rank by score, then by index', async () => {
  const units = [
    makeUnit('only a tag #vcp'),
    makeUnit('docs/plan.md 在这里'),
    makeUnit('"migration" 出现在 docs/plan.md'),
    makeUnit('#vcp 和 docs/plan.md'),
  ];
  const hits = searchExact(units, parseExactQuery('"migration" #vcp docs/plan.md'));
  assert.deepEqual(hits.map((hit) => hit.index), [2, 3, 0, 1]);
  assert.deepEqual(hits.map((hit) => hit.score), [5, 4, 2, 2]);
  assert.deepEqual(hits.map((hit) => hit.kind), ['phrase', 'path', 'tag', 'path']);
});

await check('limit caps the arm without disturbing order', async () => {
  const units = Array.from({ length: 5 }, (_, index) => makeUnit('#vcp ' + index));
  const parsed = parseExactQuery('#vcp');
  assert.equal(searchExact(units, parsed).length, 5, 'the default limit is above this fixture');
  assert.deepEqual(searchExact(units, parsed, { limit: 2 }).map((hit) => hit.index), [0, 1]);
  assert.deepEqual(searchExact(units, parsed, { limit: 0 }), []);
  assert.equal(searchExact(units, parsed, { limit: Number.NaN }).length, 5, 'a bad limit falls back');
});

await check('a unit with an unusable timestamp simply misses on dates', async () => {
  const units = [{ text: 'no time' }, { text: 'bad time', time: Number.NaN }];
  assert.deepEqual(searchExact(units, parseExactQuery('2026-10-22')), []);
});

await check('a query with no exact tokens yields no hits and no exact sets', async () => {
  const parsed = parseExactQuery('上次我们聊到的那件事');
  assert.deepEqual(parsed.phrases, []);
  assert.deepEqual(parsed.dates, []);
  assert.deepEqual(parsed.tags, []);
  assert.deepEqual(parsed.paths, []);
  assert.equal(parsed.rest, '上次我们聊到的那件事');
  assert.deepEqual(searchExact([makeUnit('上次我们聊到的那件事')], parsed), [],
    'an arm with nothing to say must return nothing, not an arbitrary ranking');
});

await check('the same input yields the same parse and the same hits', async () => {
  const query = '"alpha" 2026-10 #tag docs/x.md rest';
  const units = [makeUnit('alpha docs/x.md'), makeUnit('nothing'), makeUnit('alpha', at(2026, 10, 9))];
  assert.deepEqual(parseExactQuery(query), parseExactQuery(query));
  assert.deepEqual(searchExact(units, parseExactQuery(query)), searchExact(units, parseExactQuery(query)));
});

console.log(failures === 0
  ? '\n  exact: all checks passed\n'
  : '\n  exact: ' + failures + ' failed\n');
process.exit(failures === 0 ? 0 : 1);
