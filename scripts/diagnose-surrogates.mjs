#!/usr/bin/env node
/**
 * Diagnose: find memory units whose text is not safe to JSON-encode.
 *
 * Background: a full index build failed at unit ~10,000 with
 *   `surrogate U+DC00..U+DFFF must follow U+D800..U+DBFF`
 * even though extraction runs `sanitizeText`. This script reproduces the
 * extraction and reports every unit that would still break a strict parser,
 * so the leak path can be identified instead of guessed at.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressZstdFile, extractUnits } from '../lib/session-source.mjs';
import { sanitizeText } from '../lib/chunker.mjs';

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function findLogs(root, limit) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4 || (limit && found.length >= limit)) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    // One log per session directory: the newest version. Collecting every
    // `session*.zstd` counted a session twice whenever v3 and v4 sit side by side,
    // which is the opposite of what the builder does — it indexes only the highest
    // version, because the older file is a prefix of the newer one.
    const here = [];
    for (const e of entries) {
      if (limit && found.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/^session(?:\.v(\d+))?\.jsonl?\.zstd$/.test(e.name) || (e.name.startsWith('session') && e.name.endsWith('.zstd'))) here.push({ name: e.name, full });
    }
    if (here.length > 0) {
      here.sort((a, b) => (Number(a.name.match(/\.v(\d+)\./)?.[1] ?? 0) - Number(b.name.match(/\.v(\d+)\./)?.[1] ?? 0)));
      found.push(here.at(-1).full);
    }
  }
  await walk(root, 0);
  return found;
}

const home = process.env.DSH_HOME || join(process.env.HOME, '.dsh');
const logs = await findLogs(join(home, 'sessions'));
console.log(`scanning ${logs.length} session logs…`);

const byHash = new Map();
let total = 0;
for (const log of logs) {
  let jsonl;
  try { jsonl = await decompressZstdFile(log); } catch { continue; }
  const { units } = extractUnits(jsonl, { includeToolResults: true });
  for (const u of units) {
    total += 1;
    if (!byHash.has(u.hash)) byHash.set(u.hash, u);
  }
}

const units = [...byHash.values()].sort((a, b) => a.time - b.time);
console.log(`extracted units: ${total} (${units.length} after dedup)`);
console.log();

let bad = 0;
for (let i = 0; i < units.length; i += 1) {
  const u = units[i];
  const problems = [];

  // 1) the unit text itself
  if (UNPAIRED.test(u.text)) problems.push('unit.text');
  // 2) reverse-surrogate check for non-BMP characters (emoji must pair)
  for (const ch of u.text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) { problems.push(`bare-surrogate U+${cp.toString(16)}`); break; }
  }
  // 3) the hash and other metadata fields
  for (const key of ['hash', 'session', 'role']) {
    if (typeof u[key] === 'string' && UNPAIRED.test(u[key])) problems.push(key);
  }

  if (problems.length) {
    bad += 1;
    if (bad <= 5) {
      console.log(`#${i} seq=${u.seq} role=${u.role} session=${String(u.session).slice(0, 24)}`);
      console.log(`   offending fields: ${[...new Set(problems)].join(', ')}`);
      console.log(`   text sample: ${JSON.stringify(u.text.slice(0, 120))}`);
      const re = new RegExp(UNPAIRED.source, 'g');
      const hits = [...u.text.matchAll(re)].slice(0, 3).map((m) => `U+${m[0].codePointAt(0).toString(16)}`);
      console.log(`   lone surrogates: ${hits.join(' ') || '(none)'}`);
      console.log();
    }
  }
}

console.log(`units with unsafe characters: ${bad} / ${units.length}`);

if (bad > 0) {
  console.log('\n=== can sanitizeText repair them? ===');
  let fixed = 0;
  for (const u of units) {
    if (UNPAIRED.test(u.text) && !UNPAIRED.test(sanitizeText(u.text))) fixed += 1;
  }
  console.log(`  repairable by sanitizeText: ${fixed} / ${bad}`);
  if (fixed < bad) console.log('  WARNING: some units are not repairable by sanitizeText — the leak is outside the text field');
}
