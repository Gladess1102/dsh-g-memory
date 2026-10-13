#!/usr/bin/env node
/**
 * The judge against the gate, measured without the look-ahead trap.
 *
 * The first attempt at this comparison used the live session's own messages and
 * the current index, and the judge-off arm "injected" 10 of 24 turns — because
 * the messages were already indexed, so retrieval was matching the conversation
 * against itself. Two filters are not optional here:
 *
 *   1. candidates are restricted to units that existed **before** the query
 *      (`--delta` seconds of slack, default 0). Without this the index answers a
 *      question with the answer that was written after it.
 *   2. candidates that are the query itself (or a long copy of it) are dropped.
 *
 * What the run answers is the only question that matters for the gate: of the
 * turns where memory *would* have been injected, how many does the judge let
 * through, and how many turns does it fire on that have nothing to inject?
 *
 *                    gate: pass   gate: drop
 *   judge: fire           a            b
 *   judge: skip           c            d
 *
 *   a = injected    b = wasted retrieval    c = MISSED memory    d = correctly skipped
 *
 * `c` is the number that decides whether the judge is fit to gate the live path:
 * every one of those is a turn where the gate would have delivered memory and the
 * judge said no. `b` costs 3-11 s of retrieval for nothing.
 *
 *   node scripts/eval-judge-offline.mjs --limit 80 --provider auto
 *   node scripts/eval-judge-offline.mjs --provider off        # gate only, no judge
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { rerankEntries, resolveRerankConfig } from '../lib/rerank.mjs';
import { selectByPolicy, resolvePolicy } from '../lib/policy.mjs';
import { judgeTurn, resolveJudgeConfig } from '../lib/judge.mjs';
import { decompressZstdFile } from '../lib/session-source.mjs';
import { listSessionLogs } from '../lib/live-index.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};

const sessionsDir = valueOf('--sessions', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'));
const indexDir = valueOf('--index', defaultIndexDir());
const limit = Number(valueOf('--limit', '80'));
const deltaMs = Number(valueOf('--delta', '0')) * 1000;
const candidates = Number(valueOf('--candidates', '8'));
const provider = valueOf('--provider', 'auto');
// The gate floor is a parameter now, and that is the point of the run: the whole
// question is what the judge does *independently* of a floor that was calibrated
// on a different corpus. `--gate 3` reproduces the deployed setting, `--gate 0`
// the cross-encoder's own decision boundary.
const gateFloor = Number(valueOf('--gate', '3'));
const midFloor = Number(valueOf('--mid-gate', String(gateFloor)));
const concurrency = Number(valueOf('--concurrency', '3'));
const out = valueOf('--out', '');

const policy = resolvePolicy({ gate: gateFloor, midGate: midFloor, marginGate: 0 });
const judgeCfg = resolveJudgeConfig({ provider });

// ---------------------------------------------------------------- the corpus
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const commonPrefix = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i += 1; return i; };
/** A candidate that *is* the query is leakage, not retrieval. */
function isSelfMatch(query, candidate) {
  const q = norm(query); const c = norm(candidate);
  if (q.length < 20 || c.length < 20) return false;
  if (commonPrefix(q, c) >= 30) return true;
  const [short, long] = q.length <= c.length ? [q, c] : [c, q];
  return short.length >= 40 && long.includes(short);
}

const { stat } = await import('node:fs/promises');
const logs = await listSessionLogs(sessionsDir);
const stamped = [];
for (const file of logs) {
  try { stamped.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
}
stamped.sort((a, b) => b.mtime - a.mtime);

const turns = [];
for (const { file } of stamped) {
  if (turns.length >= limit) break;
  let jsonl = '';
  try { jsonl = file.endsWith('.zstd') ? await decompressZstdFile(file) : await readFile(file, 'utf8'); } catch { continue; }
  for (const line of jsonl.split('\n')) {
    if (turns.length >= limit) break;
    if (!line.includes('"user/message"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user/message') continue;
    const data = entry.data || {};
    if ((data.source || {}).kind !== 'user') continue;
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((part) => part && part.type === 'text').map((part) => String(part.text || '')).join(' ').trim();
    if (text.length < 8 || !Number.isFinite(entry.time)) continue;
    turns.push({ text, time: entry.time, session: String(file).split('/').pop() });
  }
}

const index = await readIndex(indexDir);
const embedCfg = resolveConfig();
const rerankCfg = { ...resolveRerankConfig(), maxChars: 800 };
console.log('index     ' + indexDir + ' (' + index.size + ' units, ' + index.model + ')');
console.log('judge     provider=' + judgeCfg.provider);
console.log('gate      floor=' + policy.gate + '/' + policy.midGate + ' margin=' + policy.marginGate + ' candidates=' + candidates);
console.log('corpus    ' + turns.length + ' real user turns, candidates limited to units older than the query');

// ------------------------------------------------------------------ the run
let done = 0;
const rows = new Array(turns.length);
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const i = done++;
    if (i >= turns.length) return;
    const turn = turns[i];
    const row = { ...turn, judge: null, gate: { pass: false, selected: 0, pool: 0 }, top1: null, ms: {} };
    try {
      const t0 = Date.now();
      row.judge = await judgeTurn({ message: turn.text }, { config: { provider } });
      row.ms.judge = Date.now() - t0;

      const t1 = Date.now();
      const [raw] = await embedBatch([turn.text], embedCfg, { purpose: 'query' });
      const vector = prepareQueryVector(raw);
      const hits = index.recall(vector, turn.text, { k: Math.max(60, candidates * 4) });
      const pool = hits
        .map((h) => { const unit = index.unit(h.index); return { text: String(unit.text || ''), time: Number(unit.time) || 0, role: unit.role, session: unit.session, seq: unit.seq, score: h.score }; })
        .filter((c) => c.time > 0 && c.time < turn.time - deltaMs)
        .filter((c) => !isSelfMatch(turn.text, c.text));
      row.gate.pool = pool.length;
      const slice = pool.slice(0, candidates);
      if (slice.length >= 2) {
        const { entries: ordered, reranked } = await rerankEntries(turn.text, slice, { config: rerankCfg });
        const scored = reranked ? ordered.map(({ rerankScore, ...rest }) => ({ ...rest, score: rerankScore })) : ordered;
        const selected = selectByPolicy(scored, { policy, limit: 3, reranked });
        row.gate.pass = selected.selected.length > 0;
        row.gate.selected = selected.selected.length;
        row.gate.tier = selected.tier;
        row.gate.reason = selected.reason || '';
        const scores = scored.map((e) => Number(e.score)).filter(Number.isFinite);
        row.top1 = scores.length ? Number(Math.max(...scores).toFixed(2)) : null;
      }
      row.ms.retrieval = Date.now() - t1;
    } catch (error) {
      row.error = String(error?.message || error).slice(0, 120);
    }
    rows[i] = row;
    process.stderr.write(row.error ? 'E' : row.judge?.fire ? (row.gate.pass ? '+' : 'b') : (row.gate.pass ? 'c' : '.'));
  }
}));
process.stderr.write('\n');

// ----------------------------------------------------------------- the table
const cells = { a: [], b: [], c: [], d: [] };
for (const row of rows) {
  if (row.error || !row.judge) continue;
  const key = row.judge.fire ? (row.gate.pass ? 'a' : 'b') : (row.gate.pass ? 'c' : 'd');
  cells[key].push(row);
}
const n = rows.filter((r) => !r.error).length;
const pct = (k) => (n ? (cells[k].length / n * 100).toFixed(0) + '%' : '-');
console.log('');
console.log('                    gate: pass   gate: drop');
console.log('  judge: fire   ' + String(cells.a.length).padStart(8) + '   ' + String(cells.b.length).padStart(10) + '     (injected / wasted retrieval)');
console.log('  judge: skip   ' + String(cells.c.length).padStart(8) + '   ' + String(cells.d.length).padStart(10) + '     (MISSED / correctly skipped)');
console.log('');
console.log('  judged turns      ' + n);
console.log('  would inject      ' + (cells.a.length + cells.c.length) + ' (' + (100 * (cells.a.length + cells.c.length) / n).toFixed(0) + '% of turns)');
console.log('  judge lets through ' + cells.a.length + '/' + (cells.a.length + cells.c.length) + ' of them  (' + (cells.a.length + cells.c.length ? (100 * cells.a.length / (cells.a.length + cells.c.length)).toFixed(0) : '-') + '%)');
console.log('  wasted retrievals ' + cells.b.length + '  (' + pct('b') + ')');
const judgeMs = rows.map((r) => r.ms.judge).filter(Number.isFinite);
const retMs = rows.map((r) => r.ms.retrieval).filter(Number.isFinite);
console.log('  judge cost        median ' + (judgeMs.sort((a, b) => a - b)[Math.floor(judgeMs.length / 2)] || 0) + ' ms   retrieval median ' + (retMs.sort((a, b) => a - b)[Math.floor(retMs.length / 2)] || 0) + ' ms');

console.log('');
console.log('--- MISSED (judge said skip, the gate would have injected) ---');
for (const row of cells.c) console.log('  top1 ' + String(row.top1).padStart(6) + '  conf ' + row.judge.confidence + '  ' + JSON.stringify(row.text.slice(0, 52)));
console.log('--- injected ---');
for (const row of cells.a) console.log('  top1 ' + String(row.top1).padStart(6) + '  conf ' + row.judge.confidence + '  ' + JSON.stringify(row.text.slice(0, 52)));
console.log('--- wasted (fire, nothing to inject) ---');
for (const row of cells.b) console.log('  top1 ' + String(row.top1).padStart(6) + '  pool ' + row.gate.pool + '  ' + JSON.stringify(row.text.slice(0, 48)));

if (out) {
  await writeFile(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('');
  console.log('wrote ' + out);
}
