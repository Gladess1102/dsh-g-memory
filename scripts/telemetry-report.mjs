#!/usr/bin/env node
/**
 * Decision-telemetry report.
 *
 * The automatic path writes one JSON line per decision to
 * $DSH_G_MEMORY_AUTO_STATS. Reading it by hand is how the gate's 27-hour
 * silent degradation stayed invisible; this prints the numbers that would have
 * shown it.
 *
 *   node scripts/telemetry-report.mjs [--hours N] [--file PATH]
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const hours = Number(argOf('--hours', '0')) || 0;
const file = argOf('--file', process.env.DSH_G_MEMORY_AUTO_STATS
  || join(homedir(), '.dsh/dsh-g-memory/auto-recall-stats.jsonl'));

let rows;
try {
  rows = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
} catch (error) {
  console.error(`  cannot read ${file}: ${error.message}`);
  process.exit(1);
}
if (hours > 0) {
  const cutoff = Date.now() - hours * 3600_000;
  rows = rows.filter((r) => r.t > cutoff);
}

const count = (list, key) => list.reduce((acc, r) => {
  const k = String(r[key]);
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
const byEvent = count(rows, 'event');
const gates = rows.filter((r) => r.event === 'gate');
const errors = rows.filter((r) => r.event === 'error' || r.event === 'consolidate-error');
const injected = byEvent.inject ?? 0;
const armed = byEvent.armed ?? 0;
const reranked = gates.filter((g) => g.reranked === true).length;

const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const span = rows.length
  ? `${new Date(rows[0].t).toLocaleString()} → ${new Date(rows.at(-1).t).toLocaleString()}`
  : '(no events)';

console.log(`\n  telemetry: ${file}`);
console.log(`  window:    ${hours > 0 ? `last ${hours}h` : 'all'} · ${rows.length} events · ${span}\n`);
console.log(`  events     ${JSON.stringify(byEvent)}`);
console.log(`  armed      ${armed}`);
console.log(`  injected   ${injected}  (${pct(injected, armed)} of armed turns)`);
console.log(`  gate reads ${gates.length}  · cross-encoder ${reranked}  · RRF fallback ${gates.length - reranked}`);
if (gates.length > 0) {
  console.log(`  verdicts   ${JSON.stringify(count(gates, 'verdict'))}`);
  const kept = gates.reduce((a, g) => a + (g.kept ?? 0), 0);
  const dropped = gates.reduce((a, g) => a + (g.dropped ?? 0), 0);
  const chars = rows.filter((r) => r.event === 'inject' && r.chars).map((r) => r.chars).sort((a, b) => a - b);
  console.log(`  candidates kept ${kept} · dropped ${dropped}`);
  if (chars.length) console.log(`  payload    median ${chars[Math.floor(chars.length / 2)]} chars · max ${chars.at(-1)}`);
  if (reranked === 0) {
    console.log('\n  ⚠️  every gate read the RRF fallback: the cross-encoder is not reaching the');
    console.log('      automatic path. That is the exact signature of 0.6.0\'s fixed defect.');
  }
}
if (errors.length > 0) {
  console.log(`\n  ⚠️  ${errors.length} failed recalls or consolidations:`);
  for (const [message, n] of Object.entries(count(errors, 'message'))) {
    console.log(`      ${n}×  ${message.slice(0, 100)}`);
  }
}
console.log('');
