#!/usr/bin/env node
/**
 * Audit the memory index for content that should never have been admitted.
 *
 * Why this exists: the extractor decides what becomes memory, and it decides by
 * *refusing* injected turns — messages whose \`source.kind\` is \`plugin:*\` /
 * \`system\` / \`reminder\`. A refusal leaves no record anywhere. So if that rule
 * ever stops matching (a new producer kind, a schema change, a refactor), the index
 * quietly fills with the plugin's own output and nothing in the system says so.
 *
 * That is not hypothetical. The sibling memory project in this space shipped 83,464
 * injected slices — 71% of everything it had labelled "user" — and only found out
 * months later, by accident. It could not have found out earlier: it had nothing to
 * count. This script is that counter.
 *
 * The verdict is three-valued on purpose. "Not measured" is not "clean":
 *
 *   pass        every unit carries a kind, and no unit carries an injected kind
 *   fail        at least one unit carries an injected kind
 *   unverified  at least one unit carries no kind at all (written before
 *               \`sourceKind\` existed and not yet re-read) — the audit cannot
 *               speak for those rows, so it does not claim the index is clean
 *
 * Usage:
 *   node scripts/audit-index-sources.mjs [--dir <index-dir>] [--json] [--top <n>] [--list <n>]
 *
 * Exit codes: 0 = pass · 1 = fail or unverified · 2 = the index could not be read
 */
import { readIndex, defaultIndexDir } from '../lib/store.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');
const top = Number.parseInt(flag('--top', '10'), 10);
const listCount = Number.parseInt(flag('--list', '0'), 10);
const dir = flag('--dir') || defaultIndexDir();

/** The only kind that is a human turn — fail-closed, matching the extractor. */
const HUMAN_SOURCE_KIND = 'user';

/**
 * The same predicate the extractor refuses on: a labelled message is human only if
 * its kind is `user`. Kept as a separate copy rather than imported so that a change
 * to the extractor shows up as a disagreement here instead of silently redefining
 * what this audit means.
 * @param {unknown} kind
 */
export function isInjectedKind(kind) {
  return kind !== HUMAN_SOURCE_KIND;
}

/** @param {string|null|undefined} kind */
const label = (kind) => (typeof kind === 'string' && kind !== '' ? kind : '(none)');

let index;
try {
  index = await readIndex(dir);
} catch (error) {
  const message = error?.message || String(error);
  if (asJson) process.stdout.write(JSON.stringify({ verdict: 'unreadable', dir, reason: message }, null, 1) + '\n');
  else process.stdout.write(`audit:index-sources — UNREADABLE\n  index: ${dir}\n  reason: ${message}\n`);
  process.exit(2);
}

const units = index.data.units;
const byKind = new Map();
const byRoleKind = new Map();
const offending = [];
let unknown = 0;
let unlabelled = 0;

for (const unit of units) {
  const raw = unit.sourceKind;
  // `null` is the writer saying "this event carried no source" — a fact.
  // `undefined` is "written before the field existed" — a gap the audit may not
  // paper over. Counting them together is how an unaudited index passes for clean.
  const backfilled = raw === null || (typeof raw === 'string' && raw !== '');
  const kind = backfilled ? (raw === null ? null : raw) : undefined;
  const key = kind === undefined ? '(not backfilled)' : label(kind);
  byKind.set(key, (byKind.get(key) || 0) + 1);
  const rk = `${unit.role} × ${key}`;
  byRoleKind.set(rk, (byRoleKind.get(rk) || 0) + 1);
  // Only a `user` row carries a source claim: the harness does not tag assistant
  // or tool events, so their `null` is the expected value, not a gap.
  if (!backfilled) { unknown += 1; continue; }
  // A `user` row whose event carried no kind is not an injection — the extractor
  // admits those on purpose (see isInjected) — but it is also not evidence of a
  // human turn. Counted apart, so "we chose to let it through" never reads as
  // "we checked and it was fine".
  if (unit.role === 'user' && kind === null) { unlabelled += 1; continue; }
  if (unit.role === 'user' && isInjectedKind(kind)) offending.push(unit);
}

const verdict = offending.length > 0 ? 'fail' : (unknown > 0 ? 'unverified' : 'pass');
const sorted = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
const sortedRoles = [...byRoleKind.entries()].sort((a, b) => b[1] - a[1]);

const report = {
  verdict,
  dir,
  units: units.length,
  builtAt: index.data.builtAt ? new Date(index.data.builtAt).toISOString() : null,
  model: index.data.model,
  injectedUnits: offending.length,
  unitsWithoutKind: unknown,
  unlabelledUserRows: unlabelled,
  byKind: Object.fromEntries(sorted),
  byRoleKind: Object.fromEntries(sortedRoles),
  offending: offending.slice(0, Math.max(0, listCount)).map((u) => ({
    session: u.session, seq: u.seq, role: u.role, sourceKind: u.sourceKind,
    preview: String(u.text || '').slice(0, 120),
  })),
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 1) + '\n');
} else {
  const lines = [];
  lines.push(`audit:index-sources — ${verdict.toUpperCase()}`);
  lines.push(`  index   : ${dir}`);
  lines.push(`  units   : ${units.length}${index.data.builtAt ? '  built ' + new Date(index.data.builtAt).toISOString().slice(0, 19).replace('T', ' ') : ''}`);
  lines.push(`  model   : ${index.data.model ?? '(unknown)'}`);
  lines.push('');
  lines.push(`  units carrying an injected kind : ${offending.length}${offending.length === 0 ? '  ✓' : '  ✗ THE FILTER IS NOT HOLDING'}`);
  lines.push(`  units carrying no kind at all   : ${unknown}${unknown === 0 ? '  ✓' : '  ? not yet re-read — this audit cannot speak for them'}`);
  lines.push(`  user rows admitted unlabelled   : ${unlabelled}${unlabelled === 0 ? '  ✓' : '  ? the event carried no kind — admitted by design, not verified human'}`);
  lines.push('');
  lines.push('  kinds:');
  for (const [k, n] of sorted.slice(0, top)) lines.push(`    ${String(n).padStart(8)}  ${k}`);
  if (sorted.length > top) lines.push(`    ${String(sorted.length - top).padStart(8)}  … ${sorted.length - top} more kind(s)`);
  lines.push('');
  lines.push('  role × kind:');
  for (const [k, n] of sortedRoles.slice(0, top)) lines.push(`    ${String(n).padStart(8)}  ${k}`);
  if (verdict === 'unverified') {
    lines.push('');
    lines.push('  → run a rebuild (or let the live index re-read the logs) to give the');
    lines.push('    remaining rows a kind; the extractor revision bump triggers that re-read.');
  }
  if (offending.length > 0) {
    lines.push('');
    lines.push(`  → inspect with: node scripts/audit-index-sources.mjs --list 20`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

process.exit(verdict === 'pass' ? 0 : 1);
