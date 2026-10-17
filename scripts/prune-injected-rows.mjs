#!/usr/bin/env node
/**
 * Remove rows from the index that came from runtime injections, not from the user.
 *
 * The extractor used to decide what was memory with a *denylist* of producer kinds
 * (\`plugin\`, \`system\`, \`reminder\`, \`plugin:*\`). The harness kept growing new ones —
 * \`agent-instructions\`, \`tool-jobs\`, \`skill-catalog\`, \`team-message\`,
 * \`subagent-settled\`, \`compact-checkpoint\`, \`ptc-mode\`, \`runtime-context\`,
 * \`goal\`, \`model-selection\`, \`time-context\` — and each was indexed as something the
 * user had said, because nothing was watching for it.
 *
 * Measured on the live index when this was found (2026-10-17): **1,729 of 3,529 rows
 * labelled \`user\`** came from those kinds, 212 of them holding this plugin's own
 * injections. The extractor now inverts the rule (only \`kind === 'user'\` is human),
 * so none are re-admitted — but rows already written are not removed by a re-read.
 *
 * This works from the logs, not from the index: it re-extracts every session log with
 * the audit switch on, collects the content hashes of the turns the filter refuses,
 * and removes the index rows carrying those hashes. Deriving "what should not be
 * here" from the same source that produced the index is the only way the question
 * has an answer other than "whatever the index already says".
 *
 * Every removed row is written to a side file in the index directory.
 *
 * Usage:
 *   node scripts/prune-injected-rows.mjs [--dir <index>] [--sessions <root>] [--dry] [--json]
 *
 * Exit codes: 0 = nothing to prune · 1 = rows removed (or would be, under --dry)
 */
import { readIndex, writeIndex, MemoryIndex, defaultIndexDir } from '../lib/store.mjs';
import { decompressZstdFile, extractUnits } from '../lib/session-source.mjs';
import { listSessionLogs } from '../lib/live-index.mjs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Mirrors the extractor's rule. Only this kind is a human turn. */
const HUMAN_SOURCE_KIND = 'user';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const dry = argv.includes('--dry');
const asJson = argv.includes('--json');
const indexDir = flag('--dir') || defaultIndexDir();
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const sessionsRoot = flag('--sessions') || join(home, 'sessions');
const say = (line) => { if (!asJson) process.stdout.write(line + '\n'); };

// 1. Which content hashes belong to refused turns?
const logs = await listSessionLogs(sessionsRoot);
const refused = new Map();           // hash -> kind
for (const log of logs) {
  let jsonl;
  try { jsonl = await decompressZstdFile(log); } catch { continue; }
  const { units } = extractUnits(jsonl, {
    includeToolResults: true,
    includeToolCalls: true,
    includeInjected: true,
    session: basename(dirname(log)),
  });
  for (const unit of units) {
    if (unit.role !== 'user') continue;
    if (unit.sourceKind === HUMAN_SOURCE_KIND) continue;
    if (!refused.has(unit.hash)) refused.set(unit.hash, unit.sourceKind ?? '(no kind)');
  }
}
say(`logs    : ${logs.length} session log(s)`);
say(`refused : ${refused.size} distinct refused turn(s) in the logs`);

// 2. Which index rows carry them?
let index;
try {
  index = await readIndex(indexDir);
} catch (error) {
  process.stderr.write(`cannot read index at ${indexDir}: ${error?.message || error}\n`);
  process.exit(2);
}
const keep = [];
const drop = [];
for (const unit of index.data.units) {
  if (unit.role === 'user' && refused.has(unit.hash)) drop.push(unit);
  else keep.push(unit);
}

const byKind = new Map();
for (const unit of drop) {
  const k = refused.get(unit.hash) ?? '(unknown)';
  byKind.set(k, (byKind.get(k) || 0) + 1);
}
const sorted = [...byKind.entries()].sort((a, b) => b[1] - a[1]);

let sideFile = null;
if (!dry && drop.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  sideFile = join(indexDir, `pruned-injected-${stamp}.ndjson`);
  await writeFile(sideFile, drop.map((u) => JSON.stringify({
    session: u.session, seq: u.seq, role: u.role, time: u.time,
    chars: String(u.text ?? '').length, text: u.text,
  })).join('\n') + '\n', { mode: 0o600 });
  await writeIndex(indexDir, new MemoryIndex({ ...index.data, units: keep }));
}

if (asJson) {
  process.stdout.write(JSON.stringify({
    indexDir, before: index.data.units.length, removed: drop.length,
    remaining: keep.length, refusedHashes: refused.size,
    byKind: Object.fromEntries(sorted), sideFile, dry,
  }, null, 1) + '\n');
} else {
  say(`index   : ${indexDir}`);
  say(`before  : ${index.data.units.length} units`);
  say(`removed : ${drop.length}`);
  say(`after   : ${keep.length} units`);
  if (sorted.length > 0) {
    say('');
    say('  removed by source kind:');
    for (const [k, n] of sorted) say(`    ${String(n).padStart(6)}  ${k}`);
  }
  if (sideFile) { say(''); say(`  kept for review: ${sideFile}`); }
  if (dry) say('\n(dry run — nothing written)');
}
process.exit(drop.length > 0 ? 1 : 0);
