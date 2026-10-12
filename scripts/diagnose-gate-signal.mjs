#!/usr/bin/env node
/**
 * Is there *any* retrieval-side signal that says "this turn has memory"?
 *
 * The automatic path asks that question of a score, so this script measures the
 * two scores available on this deployment against turns a human would call
 * memory-wanting and turns they would not:
 *
 *   cosine   int8 bi-encoder similarity (EmbeddingGemma 2), the retrieval arm
 *   rerank   bge-reranker-v2-m3 logit, the cross-encoder the gate reads today
 *
 * Measured 2026-10-13 over 80 real user turns, candidates restricted to units
 * that existed before the query and with self-matches removed:
 *
 *   - rerank top1: p10/p50/p90 = 0.010 / 0.020 / 0.030. Every turn sits at the
 *     "not an answer" end of the scale, including the ones that plainly are
 *     about past sessions. (The same reranker separates known-item calibration
 *     cases at a median of 5.18, so the model is not broken — it is scoring
 *     "is this passage the answer to that question", and a memory of a shared
 *     evening is not an answer to "you don't remember how we built this".)
 *   - cosine top1: p50 0.80 for turns the judge fires on, 0.825 for turns it
 *     skips. Overlapping distributions; a floor of 0.72 passes 78 of 80 turns.
 *     Random unit pairs sit at p50 0.61, so the arm does rank — it just does not
 *     separate *these* two classes.
 *
 * That is why the judge exists: on this corpus the retrieval score cannot carry
 * the decision, in either scale. This script is the evidence for that claim and
 * the tool to re-run it after a model or index change.
 *
 *   node scripts/diagnose-gate-signal.mjs --limit 80 --provider off
 *   node scripts/diagnose-gate-signal.mjs --limit 80 --judge-file /tmp/eval-judge.jsonl
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readIndex, defaultIndexDir, prepareQueryVector } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { rerankEntries, resolveRerankConfig } from '../lib/rerank.mjs';
import { judgeTurn } from '../lib/judge.mjs';
import { int8Similarity, unpackVector } from '../lib/vector.mjs';
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
const limit = Number(valueOf('--limit', '40'));
const provider = valueOf('--provider', 'rules');
const judgeFile = valueOf('--judge-file', '');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const commonPrefix = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i += 1; return i; };
const isSelf = (query, candidate) => {
  const a = norm(query); const b = norm(candidate);
  if (a.length < 20 || b.length < 20) return false;
  if (commonPrefix(a, b) >= 30) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 40 && long.includes(short);
};
const quantile = (values, p) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

/** Real user turns: the harness marks them with source.kind === 'user'. */
async function loadTurns() {
  const { stat } = await import('node:fs/promises');
  const logs = await listSessionLogs(sessionsDir);
  const stamped = [];
  for (const file of logs) { try { stamped.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* gone */ } }
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
      turns.push({ text, time: entry.time });
    }
  }
  return turns;
}

const index = await readIndex(defaultIndexDir());
const embedCfg = resolveConfig();
const rerankCfg = { ...resolveRerankConfig(), maxChars: 800 };

const preset = judgeFile ? new Map(JSON.parse('[' + (await readFile(judgeFile, 'utf8')).trim().split('\n').join(',') + ']')
  .map((row) => [row.text, row.judge])) : null;
const turns = await loadTurns();
console.log('index    ' + index.size + ' units, model ' + index.model);
console.log('corpus   ' + turns.length + ' real user turns' + (preset ? ' (judge verdicts reused)' : ' (judge: ' + provider + ')'));

const rows = [];
const randomSamples = [];
for (const turn of turns) {
  const [raw] = await embedBatch([turn.text], embedCfg, { purpose: 'query' });
  const vector = prepareQueryVector(raw);
  const ids = index.searchVector(vector, 200);
  const picked = ids
    .map((i) => { const unit = index.unit(i); return { text: String(unit.text || ''), time: Number(unit.time) || 0, vector: unit.vector }; })
    .filter((c) => c.time > 0 && c.time < turn.time && !isSelf(turn.text, c.text))
    .slice(0, 40);
  const cosines = picked.map((c) => { const { codes, scale } = unpackVector(c.vector); return int8Similarity(vector, codes, scale); });
  for (let n = 0; n < 20; n += 1) {
    const unitIndex = Math.floor(Math.random() * index.size);
    const { codes, scale } = unpackVector(index.unit(unitIndex).vector);
    randomSamples.push(int8Similarity(vector, codes, scale));
  }
  const top = picked.slice(0, 8);
  let rerankTop1 = null;
  if (top.length >= 2) {
    const { entries } = await rerankEntries(turn.text, top.map((c) => ({ text: c.text, time: c.time, vector: c.vector })), { config: rerankCfg });
    const scores = entries.map((e) => Number(e.rerankScore)).filter(Number.isFinite);
    rerankTop1 = scores.length ? Math.max(...scores) : null;
  }
  const judge = preset ? preset.get(turn.text) : await judgeTurn({ message: turn.text }, { config: { provider } });
  rows.push({ text: turn.text.slice(0, 44), fire: Boolean(judge?.fire), kind: judge?.kind,
    cosTop1: cosines.length ? Math.max(...cosines) : null, cosMed: quantile(cosines, 0.5), rerankTop1 });
  process.stderr.write('.');
}
process.stderr.write('\n');

const ok = rows.filter((r) => r.cosTop1 !== null);
const fire = ok.filter((r) => r.fire);
const skip = ok.filter((r) => !r.fire);
const pick = (set, key) => set.map((r) => r[key]).filter(Number.isFinite);
console.log('');
console.log('signal          judge fire p10/p50/p90        judge skip p10/p50/p90');
console.log('  cosine top1   ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(pick(fire, 'cosTop1'), p))).join(' / ')
  + '         ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(pick(skip, 'cosTop1'), p))).join(' / '));
console.log('  cosine margin ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(fire.map((r) => r.cosTop1 - r.cosMed), p))).join(' / ')
  + '         ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(skip.map((r) => r.cosTop1 - r.cosMed), p))).join(' / '));
console.log('  rerank top1   ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(pick(fire, 'rerankTop1'), p))).join(' / ')
  + '         ' + [0.1, 0.5, 0.9].map((p) => f3(quantile(pick(skip, 'rerankTop1'), p))).join(' / '));
console.log('  random cosine (all queries) p50 ' + f3(quantile(randomSamples, 0.5)) + '  p90 ' + f3(quantile(randomSamples, 0.9)));
console.log('');
console.log('cosine floor sweep (how many turns a cosine-only gate would pass)');
for (const floor of [0.6, 0.65, 0.7, 0.72, 0.74, 0.76, 0.78]) {
  const pass = ok.filter((r) => r.cosTop1 >= floor);
  console.log('  ' + String(floor).padEnd(6) + pass.length + '/' + ok.length + '   of which the judge fired: ' + pass.filter((r) => r.fire).length);
}
