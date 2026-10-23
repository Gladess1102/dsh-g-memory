#!/usr/bin/env node
/**
 * The quality baseline gate: fragment rate, truncation rate, self-recall and
 * missed cross-session recall, computed from what actually reached the model.
 *
 * Every failure this project has had was measured too late. The gate was
 * read as "injection rate"; the thing that was wrong was what got injected:
 * 22-27% of entries shorter than 80 characters, 57-68% cut off with an
 * ellipsis and no label, up to 16.6% of them recalled from the same session
 * they were injected into. None of those show up in a count of injections, and
 * none of them were noticed until a human read 72 blocks by hand.
 *
 * So the input here is the injected block itself — parsed out of the session
 * logs, exactly as the model received it — not the retrieval scores. The
 * decision log supplies the denominator (how many memories the automatic path
 * produced) and the judge fallback share; the logs supply what the text looked
 * like. Read-only: it opens logs and stats and writes nothing.
 *
 * Thresholds are the targets stated in the review: fragments <=5%, truncated
 * <=5%, self-recall <=2%, missed cross-session recall <=15%. Each is a flag.
 *
 *   node scripts/eval-quality.mjs                 # last 7 days, gate on
 *   node scripts/eval-quality.mjs --days 14 --json
 *   node scripts/eval-quality.mjs --no-gate       # measure without failing
 *
 * Exit code: 0 when every rate is inside its threshold, 1 when any is not,
 * 2 when there is nothing to measure (missing sessions root). "No data" is not
 * a pass, and it is not a quality failure either.
 *
 * SPDX-License-Identifier: MIT
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decompressZstdFile } from '../lib/session-source.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};
const asJson = argv.includes('--json');
const gateOn = !argv.includes('--no-gate');
const home = process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh');
const days = Number(valueOf('--days', '7'));
const sessionsRoot = valueOf('--sessions', join(home, 'sessions'));
const statsPath = process.env.DSH_G_MEMORY_AUTO_STATS || join(home, 'dsh-g-memory', 'auto-recall-stats.jsonl');

// Targets from the review's acceptance table. A rate above any of these is the
// regression the gate exists to catch.
const LIMITS = {
  fragment: Number(valueOf('--max-fragment', '0.05')),
  truncated: Number(valueOf('--max-truncated', '0.05')),
  selfRecall: Number(valueOf('--max-self', '0.02')),
  missedRecall: Number(valueOf('--max-miss', '0.15')),
};

/** A block is injected when the plugin authored it and it carries the wrapper. */
function injectedText(event) {
  const kind = event?.data?.source?.kind;
  if (typeof kind !== 'string' || !kind.startsWith('plugin:')) return '';
  const content = event?.data?.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
    : '';
  return text.includes('<recalled-memory>') ? text : '';
}

/** Message text of a user/assistant event, for the turn-side classification. */
function messageText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/**
 * One entry line, as renderRecall writes it:
 *   - (written memory, may be lossy, 2026-10-23 11:22, session-abc#41) text
 * The provenance contains commas, so it is matched non-greedily up to the
 * timestamp; the session part is optional (cards written outside a session).
 */
const ENTRY_LINE = /^- \((.+?), (\d{4}-\d{2}-\d{2} \d{2}:\d{2}|unknown time)(?:, (.+?)#(\S+?))?\) (.*)$/;

/** Split a framed block into entries, folding continuation lines into the one above. */
function parseBlock(text) {
  const open = text.indexOf('<recalled-memory>');
  const close = text.indexOf('</recalled-memory>');
  if (open === -1 || close === -1 || close < open) return [];
  const entries = [];
  for (const line of text.slice(open + 17, close).split('\n')) {
    const match = ENTRY_LINE.exec(line);
    if (match) {
      entries.push({
        provenance: match[1],
        when: match[2],
        session: match[3] || '',
        seq: match[4] || '',
        text: match[5],
      });
    } else if (entries.length > 0 && line.trim() !== '') {
      // Card summaries carry their own newlines; they belong to the entry above.
      entries[entries.length - 1].text += '\n' + line;
    }
  }
  return entries;
}

/** Local calendar day, so the per-day buckets read like the doctor's, not like UTC. */
function localDay(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

/** 'session-abc…' and 'abc…' name the same session; compare their first 16 chars. */
function sameSession(a, b) {
  const norm = (value) => String(value || '').replace(/^session-/, '').toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (x.length === 0 || y.length === 0) return false;
  const n = Math.min(16, x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

/** Cross-session references: the turns that should have found something. */
const CROSS_SESSION_REF = /(上次|之前|上个对话|上一个对话|接续|原文|还记得|那次|早先|先前|以前说)/;
/** In-session references: these must NOT need long-term memory. */
const IN_SESSION_REF = /(刚才|刚刚|上面|继续|那个|这个|前面说)/;

async function collectLogs(root, cutoff) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (/session\.v\d+\.jsonl\.zstd$/.test(entry.name)) {
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs >= cutoff) out.push({ path, mtime: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  return out;
}

const cutoff = Date.now() - days * 86_400_000;
let files = [];
try {
  files = await collectLogs(sessionsRoot, cutoff);
} catch (error) {
  console.error('eval-quality: cannot walk ' + sessionsRoot + ': ' + (error?.message || error));
  process.exit(2);
}

const byDay = new Map();
const totals = {
  files: 0,
  unreadable: 0,
  blocks: 0,
  entries: 0,
  fragments: 0,
  truncated: 0,
  selfRecalled: 0,
  crossTurns: 0,
  crossTurnsInjected: 0,
  inSessionTurns: 0,
  inSessionTurnsInjected: 0,
  entryChars: [],
};

for (const file of files) {
  let text = '';
  try {
    text = await decompressZstdFile(file.path);
  } catch {
    totals.unreadable += 1;
    continue;
  }
  totals.files += 1;
  // The directory (or file) name carries the session UUID; entries name their
  // source the same way, so self-recall is a prefix comparison of the two.
  const sessionId = (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(String(file.path)) || [''])[0];
  let currentTurn = null;
  const turns = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    // The window is on the EVENT's own time, not the file's mtime: a log that was
    // appended to yesterday still contains months of injections, and counting
    // those would inflate the block rate against a stats file that is filtered by
    // time (measured: 2.1x apart before this filter, 1:1 after).
    const eventTime = Number(event?.time);
    if (Number.isFinite(eventTime) && eventTime > 0 && eventTime < cutoff) continue;
    if (event.type === 'user/message' && event?.data?.source?.kind === 'user') {
      currentTurn = { text: messageText(event), injected: 0, entries: [] };
      turns.push(currentTurn);
      continue;
    }
    const block = injectedText(event);
    if (block === '' || currentTurn === null) continue;
    const entries = parseBlock(block);
    currentTurn.injected += 1;
    currentTurn.entries.push(...entries);
    totals.blocks += 1;
    const day = localDay(event.time || file.mtime);
    const bucket = byDay.get(day) || { blocks: 0, entries: 0, fragments: 0, truncated: 0, selfRecalled: 0 };
    bucket.blocks += 1;
    for (const entry of entries) {
      const chars = entry.text.trim().length;
      totals.entries += 1;
      bucket.entries += 1;
      totals.entryChars.push(chars);
      if (chars < 80) { totals.fragments += 1; bucket.fragments += 1; }
      if (/…\s*(\[truncated\])?\s*$/.test(entry.text)) { totals.truncated += 1; bucket.truncated += 1; }
      if (sameSession(entry.session, sessionId)) { totals.selfRecalled += 1; bucket.selfRecalled += 1; }
    }
    byDay.set(day, bucket);
  }
  for (const turn of turns) {
    if (CROSS_SESSION_REF.test(turn.text)) {
      totals.crossTurns += 1;
      if (turn.injected > 0) totals.crossTurnsInjected += 1;
    } else if (IN_SESSION_REF.test(turn.text)) {
      totals.inSessionTurns += 1;
      if (turn.injected > 0) totals.inSessionTurnsInjected += 1;
    }
  }
}

// The decision log is the independent denominator. If the two disagree by a few
// percent that is a delivery window; if they disagree by 10x the logs and the
// telemetry are not describing the same thing (measured 2026-09, before the
// inject event was aligned to delivery).
let stats = null;
try {
  const raw = await readFile(statsPath, 'utf8');
  const cutoff = Date.now() - days * 86_400_000;
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (Number(row.t) >= cutoff) rows.push(row);
  }
  const count = (event) => rows.filter((row) => row.event === event).length;
  const judge = rows.filter((row) => row.event === 'judge');
  stats = {
    rows: rows.length,
    inject: count('inject'),
    hint: count('hint'),
    resident: count('resident'),
    judge: judge.length,
    judgeFallback: judge.filter((row) => row.source === 'fallback').length,
    judgeFallbackShare: judge.length > 0 ? Number((judge.filter((row) => row.source === 'fallback').length / judge.length).toFixed(4)) : null,
  };
} catch { /* no decision log: the log-derived rates still stand on their own */ }

const rate = (part, total) => (total > 0 ? Number((part / total).toFixed(4)) : null);
const sortedChars = [...totals.entryChars].sort((a, b) => a - b);
const percentile = (q) => (sortedChars.length > 0 ? sortedChars[Math.min(sortedChars.length - 1, Math.floor(q * sortedChars.length))] : null);

const result = {
  window: { days, sessionsRoot, statsPath, generatedAt: new Date().toISOString() },
  logs: {
    files: totals.files,
    unreadable: totals.unreadable,
    blocks: totals.blocks,
    entries: totals.entries,
    entriesPerBlock: totals.blocks > 0 ? Number((totals.entries / totals.blocks).toFixed(2)) : null,
  },
  rates: {
    fragment: rate(totals.fragments, totals.entries),
    truncated: rate(totals.truncated, totals.entries),
    selfRecall: rate(totals.selfRecalled, totals.entries),
    missedCrossSessionRecall: rate(totals.crossTurns - totals.crossTurnsInjected, totals.crossTurns),
    inSessionInjection: rate(totals.inSessionTurnsInjected, totals.inSessionTurns),
  },
  counts: {
    fragments: totals.fragments,
    truncated: totals.truncated,
    selfRecalled: totals.selfRecalled,
    crossSessionTurns: totals.crossTurns,
    crossSessionTurnsInjected: totals.crossTurnsInjected,
    inSessionTurns: totals.inSessionTurns,
    inSessionTurnsInjected: totals.inSessionTurnsInjected,
  },
  entryChars: {
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sortedChars.length > 0 ? sortedChars[sortedChars.length - 1] : null,
  },
  stats,
  limits: LIMITS,
  byDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, bucket]) => ({ day, ...bucket })),
};

const failures = [];
if (result.logs.entries === 0) {
  result.verdict = 'no-data';
} else {
  const checks = [
    ['fragment', result.rates.fragment, LIMITS.fragment],
    ['truncated', result.rates.truncated, LIMITS.truncated],
    ['selfRecall', result.rates.selfRecall, LIMITS.selfRecall],
  ];
  if (result.rates.missedCrossSessionRecall !== null && result.counts.crossSessionTurns >= 5) {
    checks.push(['missedCrossSessionRecall', result.rates.missedCrossSessionRecall, LIMITS.missedRecall]);
  }
  for (const [name, value, limit] of checks) {
    if (value !== null && value > limit) failures.push({ metric: name, value, limit });
  }
  result.verdict = failures.length === 0 ? 'pass' : 'fail';
}
result.failures = failures;
// "No data" is not a pass (nothing was verified) and not a failure of quality;
// the gate only fails on a measured regression.
result.gatePassed = result.verdict !== 'fail';

if (asJson) {
  console.log(JSON.stringify(result, null, 1));
} else {
  const pct = (value) => (value === null ? 'n/a' : (value * 100).toFixed(1) + '%');
  console.log('window      last ' + days + ' d, ' + result.logs.files + ' log(s) read'
    + (result.logs.unreadable > 0 ? ', ' + result.logs.unreadable + ' unreadable' : ''));
  console.log('blocks      ' + result.logs.blocks + ' injected block(s), ' + result.logs.entries
    + ' entries (' + (result.logs.entriesPerBlock ?? 'n/a') + '/block)');
  console.log('chars       p50 ' + (result.entryChars.p50 ?? 'n/a') + ', p90 ' + (result.entryChars.p90 ?? 'n/a')
    + ', max ' + (result.entryChars.max ?? 'n/a'));
  console.log('');
  console.log('metric                       value     target');
  console.log('  fragment (<80 chars)       ' + pct(result.rates.fragment).padEnd(10) + '<= ' + pct(LIMITS.fragment));
  console.log('  truncated (… / [truncated])' + pct(result.rates.truncated).padEnd(10) + '<= ' + pct(LIMITS.truncated));
  console.log('  self-recall (same session) ' + pct(result.rates.selfRecall).padEnd(10) + '<= ' + pct(LIMITS.selfRecall));
  console.log('  missed cross-session recall' + pct(result.rates.missedCrossSessionRecall).padEnd(10) + '<= ' + pct(LIMITS.missedRecall)
    + '  (n=' + result.counts.crossSessionTurns + ')');
  console.log('  in-session injection        ' + pct(result.rates.inSessionInjection).padEnd(10) + '(budget wasted, not gated; n=' + result.counts.inSessionTurns + ')');
  if (stats) {
    console.log('');
    console.log('stats       inject ' + stats.inject + ' vs log blocks ' + result.logs.blocks
      + (stats.inject > 0 ? ' (ratio ' + (result.logs.blocks / stats.inject).toFixed(2) + ')' : '')
      + '; hint ' + stats.hint + '; judge fallback ' + pct(stats.judgeFallbackShare));
  }
  console.log('');
  if (failures.length > 0) {
    for (const failure of failures) console.log('  FAIL ' + failure.metric + ': ' + pct(failure.value) + ' > ' + pct(failure.limit));
    console.log('quality gate: FAIL (' + failures.length + ' metric(s) over target)');
  } else if (result.verdict === 'no-data') {
    console.log('quality gate: no data (' + result.logs.files + ' log(s), ' + result.logs.blocks + ' block(s) — nothing was verified, not a pass)');
  } else {
    console.log('quality gate: pass');
  }
}

if (!gateOn || result.verdict === 'no-data') process.exit(0);
process.exit(failures.length > 0 ? 1 : 0);
