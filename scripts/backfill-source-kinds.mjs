#!/usr/bin/env node
/**
 * Give every index row the \`sourceKind\` of the event it came from — without
 * re-embedding a single vector.
 *
 * Why this exists, and why it is not \`build\`:
 *
 *   \`build\` refuses to reuse vectors unless the recorded model name and dimension
 *   match the endpoint it is talking to. That check is right — vectors from two
 *   different spaces must never be mixed — but the model name is a *label*: the
 *   endpoint ignores it, and a rename lands in the mismatch branch. This deployment's
 *   llama-server answers to \`embed-gemma\` while the index recorded
 *   \`embeddinggemma-2\` (same weights, different string), so a plain rebuild
 *   re-embedded all 29,717 units: roughly 54 minutes of embedding-endpoint time,
 *   competing with the automatic recall of whatever session happens to be live.
 *
 *   Backfilling a field needs no vectors. The extractor derives \`sourceKind\` from
 *   the same logs the index was built from, so re-reading those logs and matching on
 *   the content hash is enough: the rows keep their vectors, their model and their
 *   dimension, and the embedding endpoint is never contacted.
 *
 * The extractor revision was bumped when the field was introduced, so a live index
 * repairs these rows by itself the next time the plugin loads. This script exists so
 * that the repair does not have to wait for a restart, and so that it can be run and
 * measured on its own.
 *
 * Usage:
 *   node scripts/backfill-source-kinds.mjs [--dir <index>] [--sessions <root>] [--dry] [--json]
 *
 * Exit codes: 0 = every row now carries a kind · 1 = some rows could not be matched
 *             to a log (their source is gone) and stay unverified
 */
import { readIndex, writeIndex, MemoryIndex, defaultIndexDir } from '../lib/store.mjs';
import { decompressZstdFile, extractUnits } from '../lib/session-source.mjs';
import { listSessionLogs } from '../lib/live-index.mjs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

let index;
try {
  index = await readIndex(indexDir);
} catch (error) {
  process.stderr.write(`cannot read index at ${indexDir}: ${error?.message || error}\n`);
  process.exit(2);
}
const rows = index.data.units;
say(`index : ${indexDir}`);
say(`        ${rows.length} units · model ${index.data.model ?? '(unknown)'} · dim ${index.data.dim}`);

const logs = await listSessionLogs(sessionsRoot);
say(`logs  : ${logs.length} session log(s) under ${sessionsRoot}`);
say('');

const byHash = new Map();
for (const unit of rows) if (unit.hash && !byHash.has(unit.hash)) byHash.set(unit.hash, unit);

let updated = 0;
let extracted = 0;
let read = 0;
let unreadable = 0;

for (const log of logs) {
  let jsonl;
  try {
    jsonl = await decompressZstdFile(log);
  } catch (error) {
    unreadable += 1;
    say(`  ! ${basename(dirname(log))}: ${error?.message || error}`);
    continue;
  }
  const { units } = extractUnits(jsonl, {
    includeToolResults: true,
    includeToolCalls: true,
    session: basename(dirname(log)),
  });
  extracted += units.length;
  for (const unit of units) {
    const target = byHash.get(unit.hash);
    if (target === undefined) continue;
    // `?? null` on both sides: an absent field and an explicit `null` mean the same
    // thing here, and comparing them raw made every row look like it changed.
    if ((target.sourceKind ?? null) !== (unit.sourceKind ?? null)) {
      target.sourceKind = unit.sourceKind;
      updated += 1;
    }
  }
  read += 1;
  if (read % 50 === 0) say(`  … ${read}/${logs.length} logs read · ${updated} row(s) updated`);
}

const withKind = rows.filter((u) => typeof u.sourceKind === 'string' && u.sourceKind !== '').length;
const missing = rows.length - withKind;

if (!dry && updated > 0) {
  await writeIndex(indexDir, new MemoryIndex({ ...index.data, units: rows }));
  say('');
  say(`wrote : ${indexDir}`);
}

const report = {
  indexDir,
  sessionsRoot,
  units: rows.length,
  logs: logs.length,
  unreadableLogs: unreadable,
  extractedUnits: extracted,
  updated,
  rowsWithKind: withKind,
  rowsWithoutKind: missing,
  dry,
};
if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 1) + '\n');
} else {
  say('');
  say(`rows updated with a source kind : ${updated}`);
  say(`rows carrying a source kind     : ${withKind} / ${rows.length}`);
  say(`rows still without one          : ${missing}${missing === 0 ? '  ✓' : '  (source transcript gone, or never matched)'}`);
  if (dry) say('(dry run — nothing written)');
}
process.exit(missing === 0 ? 0 : 1);
