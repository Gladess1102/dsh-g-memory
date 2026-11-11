#!/usr/bin/env node
/**
 * What shapes of query actually retrieve?
 *
 * The decision log now keeps the query text on every gate decision (2026-11-08),
 * which makes this answerable from data instead of opinion: group gate outcomes
 * by the shape of the query, and the shapes that never pass are the ones worth
 * telling a model not to use.
 *
 * Why this exists at all: measured on 2026-11-08, noun-keyed queries found their
 * answer in 15/15 probes while context-free fragments ("继续", "这又是啥") returned
 * nothing in 7/12. That gap is not a threshold to tune — a fragment carries no
 * nouns, so there is nothing to match. The fix belongs in the guidance the model
 * reads, and this script is how that guidance stays honest as traffic changes.
 *
 *   node scripts/recall-query-report.mjs
 *   node scripts/recall-query-report.mjs --json
 *   node scripts/recall-query-report.mjs --min 5     # hide groups smaller than N
 *
 * Data starts at the commit that added the `q` field; older lines have no query
 * and are skipped rather than counted as misses.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minIndex = args.indexOf('--min');
const minN = minIndex >= 0 ? Number(args[minIndex + 1]) || 1 : 1;

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const path = process.env.DSH_G_MEMORY_AUTO_STATS || join(home, 'dsh-g-memory', 'auto-recall-stats.jsonl');

/** Pronouns and bare continuations: a query that names nothing. */
const PRONOUN = /^(这|那|它|继续|接着|然后|所以|还是|嗯|好的|行|对|不)|那个|这个|刚才|上次|上面|前面|继续/;
/** Latin identifiers, paths, model ids — the thing that makes a query specific. */
const LATIN = /[A-Za-z]/;
/** Digits: versions, sizes, ports, counts, dates. */
const DIGIT = /\d/;

function shapeOf(q) {
  const s = String(q ?? '').trim();
  const tags = [];
  if (LATIN.test(s)) tags.push('latin');
  if (DIGIT.test(s)) tags.push('digit');
  if (PRONOUN.test(s)) tags.push('pronoun');
  if (s.length <= 10) tags.push('short');
  if (tags.length === 0) tags.push('plain-zh');
  return tags.join('+');
}

let raw = '';
try { raw = await readFile(path, 'utf8'); } catch {
  console.error('no decision log at ' + path + ' (nothing recorded yet)');
  process.exit(0);
}

const groups = new Map();
let total = 0;
for (const line of raw.split('\n')) {
  if (!line || !line.includes('"gate"')) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.event !== 'gate' || typeof o.q !== 'string' || o.q === '') continue;
  total += 1;
  const key = shapeOf(o.q);
  const g = groups.get(key) ?? { n: 0, pass: 0 };
  g.n += 1;
  if (o.verdict === 'pass') g.pass += 1;
  groups.set(key, g);
}

if (total === 0) {
  console.log('No gate decisions carry a query yet.');
  console.log('The \`q\` field landed 2026-11-08; restart the host so the new code runs,');
  console.log('then this report fills in as traffic arrives.');
  process.exit(0);
}

const rows = [...groups.entries()]
  .map(([shape, g]) => ({ shape, n: g.n, pass: g.pass, rate: g.pass / g.n }))
  .filter((r) => r.n >= minN)
  .sort((a, b) => b.n - a.n);

if (asJson) {
  console.log(JSON.stringify({ path, total, groups: rows }, null, 2));
  process.exit(0);
}

console.log('decision log  ' + path);
console.log('gate rows with a query  ' + total + '\n');
console.log('shape'.padEnd(26) + 'n'.padStart(6) + 'pass'.padStart(7) + 'rate'.padStart(8));
console.log('-'.repeat(47));
for (const r of rows) {
  console.log(r.shape.padEnd(26) + String(r.n).padStart(6) + String(r.pass).padStart(7)
    + (r.rate * 100).toFixed(0).padStart(7) + '%');
}

const worst = rows.filter((r) => r.n >= 3).sort((a, b) => a.rate - b.rate)[0];
const best = rows.filter((r) => r.n >= 3).sort((a, b) => b.rate - a.rate)[0];
if (best && worst && best.shape !== worst.shape) {
  console.log('\nbest  ' + best.shape + '  ' + (best.rate * 100).toFixed(0) + '% of ' + best.n);
  console.log('worst ' + worst.shape + '  ' + (worst.rate * 100).toFixed(0) + '% of ' + worst.n);
  console.log('\nGuidance follows from the gap: name the subject. Pronoun-first and');
  console.log('context-free shapes are the ones to rewrite before calling the tool.');
}
