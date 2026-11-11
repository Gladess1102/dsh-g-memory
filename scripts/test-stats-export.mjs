#!/usr/bin/env node
/**
 * The usage export: aggregate, and provably free of the user's text.
 *
 * The decision log deliberately contains query text, session ids and working
 * directories (added so a failed recall can be diagnosed without replaying
 * transcripts). That makes a naive "dump the log" export a privacy incident
 * waiting to happen, and it is the exact shape of the feature that gets pasted
 * into a public issue by someone who means well.
 *
 * So the assertions here are mostly negative: given a log full of secrets, the
 * rendered report must not contain any of them. The positive ones only pin the
 * counts, so a whitelist that silently drops everything also fails.
 *
 * Hermetic: temporary files, no network.
 *
 *   node scripts/test-stats-export.mjs
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatsLines, summarizeStats, renderStatsReport } from '../lib/stats-export.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = join(here, '..', 'bin', 'dsh-g-memory.mjs');

const SECRETS = [
  'my-private-query-about-boarding-pass',
  '/Users/someone/private-project',
  'session-9f3c21ab77de5511',
  'because the user asked about their medical report',
];

const events = [
  { t: Date.UTC(2026, 10, 1, 10), event: 'armed', q: SECRETS[0], ws: SECRETS[1], session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 1, 11), event: 'pass', q: SECRETS[0], session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 2, 11), event: 'skip', session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 2, 12), event: 'hint', session: SECRETS[2], why: SECRETS[3] },
  { t: Date.UTC(2026, 10, 3, 9), event: 'inject', chars: 900, session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 3, 10), event: 'inject', chars: 1100, session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 4, 10), event: 'judge', source: 'chat', session: SECRETS[2] },
  { t: Date.UTC(2026, 10, 4, 11), event: 'judge', source: 'chat' },
  { t: Date.UTC(2026, 10, 4, 12), event: 'judge', source: 'rules' },
  { t: Date.UTC(2026, 10, 5, 10), event: 'live-index-error', why: SECRETS[3] },
];
const logText = events.map((event) => JSON.stringify(event)).join('\n')
  + '\n{"event":"truncated", "t":' // torn final line, as a crash leaves it
  + '\nnot json at all\n';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error?.message || error));
  }
}

const parsed = parseStatsLines(logText);

await check('a torn or malformed line is skipped, the rest survive', () => {
  assert.equal(parsed.length, events.length);
  assert.ok(parsed.every((event) => typeof event.event === 'string'));
});

const summary = summarizeStats(parsed);

await check('counts, window and gate rate', () => {
  assert.equal(summary.total, events.length);
  assert.equal(summary.turns, 1);
  assert.equal(summary.gate.pass, 1);
  assert.equal(summary.gate.skip, 1);
  assert.equal(summary.gate.hint, 1);
  assert.equal(summary.gateTotal, 3);
  assert.equal(summary.passRate, 33);
  assert.equal(summary.injections, 2);
  assert.equal(summary.avgInjectedChars, 1000);
  assert.equal(summary.days, 5);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.errors, 1);
  // Plain copy: the module keeps a null-prototype map so an event named
  // "__proto__" cannot poison it, and deepEqual treats that as a different shape.
  assert.deepEqual({ ...summary.judgeSources }, { chat: 2, rules: 1 });
});

const report = renderStatsReport(summary, { version: '9.9.9' });

await check('the report carries the aggregate numbers', () => {
  assert.match(report, /plugin version \| 9\.9\.9/);
  assert.match(report, /turns armed \| 1/);
  assert.match(report, /33% passed/);
  assert.match(report, /errors \| 1/);
});

await check('no secret survives the export', () => {
  for (const secret of SECRETS) {
    assert.equal(report.includes(secret), false, 'leaked: ' + secret);
  }
});

await check('an empty log renders instead of throwing', () => {
  const empty = summarizeStats([]);
  const text = renderStatsReport(empty, {});
  assert.match(text, /events \| 0/);
  assert.equal(empty.passRate, null);
});

const dir = await mkdtemp(join(tmpdir(), 'gm-stats-export-'));
const file = join(dir, 'auto-recall-stats.jsonl');
await writeFile(file, logText);

await check('the CLI prints the same report and leaks nothing', () => {
  const out = spawnSync(process.execPath, [cli, 'stats', '--export', '--file', file], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /dsh-g-memory usage summary/);
  for (const secret of SECRETS) {
    assert.equal(out.stdout.includes(secret), false, 'CLI leaked: ' + secret);
  }
});

await check('a missing log fails loudly instead of printing an empty table', () => {
  const out = spawnSync(process.execPath, [cli, 'stats', '--export', '--file', join(dir, 'nope.jsonl')], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /no decision log at/);
});

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? 'stats-export: all checks passed' : 'stats-export: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
