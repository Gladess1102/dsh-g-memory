#!/usr/bin/env node
/**
 * Label real user messages with the judgement layer.
 *
 * This is the标定 half of the fix. The gate that broke was calibrated on
 * known-item cases — questions built backwards from answers already in the
 * index, which are answerable by construction — while the traffic it actually
 * serves is chat, and the two distributions do not overlap (real messages score
 * a median of -1.49, the calibration set 5.18). Labeling has to happen on real
 * messages, and it has to be cheap enough to redo whenever the model, the index
 * or the corpus changes.
 *
 *   node scripts/label-messages.mjs --limit 100 --out /tmp/labels.jsonl
 *   node scripts/label-messages.mjs --provider rules          # no model calls
 *   node scripts/label-messages.mjs --golden scripts/cases.trigger.json
 *
 * The output is one JSON object per line: the message, the verdict, and which
 * layer decided. `--golden` compares against a hand-labelled file of
 * `{"text": "...", "fire": true}` records and prints the confusion matrix.
 *
 * Read-only with respect to the deployment: it reads session logs, calls the
 * judge, writes only the file named by `--out`.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listSessionLogs } from '../lib/live-index.mjs';
import { decompressZstdFile } from '../lib/session-source.mjs';
import { judgeTurn, resolveJudgeConfig } from '../lib/judge.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};

const sessionsDir = valueOf('--sessions', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'));
const limit = Number(valueOf('--limit', '60'));
const minChars = Number(valueOf('--min-chars', '8'));
const out = valueOf('--out', '');
const goldenFile = valueOf('--golden', '');
const provider = valueOf('--provider', process.env.DSH_G_MEMORY_JUDGE || 'auto');
const concurrency = Number(valueOf('--concurrency', '4'));

const cfg = resolveJudgeConfig({ provider });
console.log('sessions  ' + sessionsDir);
console.log('judge     provider=' + cfg.provider + ' threshold=' + cfg.threshold
  + (cfg.provider === 'auto' || cfg.provider === 'jev' ? '  jev=' + cfg.jev.model : '')
  + (cfg.provider === 'auto' || cfg.provider === 'chat' ? '  chat=' + cfg.chat.model : ''));

const logs = await listSessionLogs(sessionsDir);
console.log('logs      ' + logs.length + ' session logs found');

/** The most recently modified logs first: recent traffic is the point. */
const { stat } = await import('node:fs/promises');
const stamped = [];
for (const file of logs) {
  try { stamped.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
}
stamped.sort((a, b) => b.mtime - a.mtime);

/**
 * Real user turns, taken from the session log's own event stream.
 *
 * Not from `extractUnits`: that returns everything the *index* considers a unit
 * with role=user, which also includes injected recall blocks, runtime snapshots,
 * messages other agents sent, and excerpts of documents the user pasted from. A
 * first run labeled 60 "messages" of which most were recall blocks and teammate
 * traffic — the labels would have been noise, and the threshold derived from
 * them worse than none. `source.kind === 'user'` is the harness's own marker
 * for "the person typed this", and it is the same test the plugin uses.
 */
const messages = [];
for (const { file } of stamped) {
  if (messages.length >= limit) break;
  let jsonl = '';
  try {
    jsonl = file.endsWith('.zstd') ? await decompressZstdFile(file) : await readFile(file, 'utf8');
  } catch { continue; }
  for (const line of jsonl.split('\n')) {
    if (messages.length >= limit) break;
    if (!line.includes('"user/message"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user/message') continue;
    const data = entry.data || {};
    if ((data.source || {}).kind !== 'user') continue;
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((part) => part && part.type === 'text')
      .map((part) => String(part.text || ''))
      .join(' ')
      .trim();
    if (text.length < minChars) continue;
    messages.push({ text, session: String(file).split('/').pop(), time: entry.time, file });
  }
}
console.log('messages  ' + messages.length + ' candidate user turns');

let done = 0;
const failures = [];
const started = Date.now();
const results = new Array(messages.length);
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (;;) {
    const i = done++;
    if (i >= messages.length) return;
    const m = messages[i];
    try {
      const verdict = await judgeTurn({ message: m.text }, {
        config: { provider },
        onFailure: (error, layer) => failures.push({ layer, message: String(error.message).slice(0, 120) }),
      });
      results[i] = { ...m, verdict };
    } catch (error) {
      results[i] = { ...m, verdict: { fire: false, kind: 'none', confidence: 0, source: 'error', why: String(error.message) } };
    }
    process.stderr.write('.');
  }
}));
process.stderr.write('\n');

const elapsed = Date.now() - started;
const bySource = {};
const byKind = {};
let fired = 0;
for (const r of results) {
  bySource[r.verdict.source] = (bySource[r.verdict.source] || 0) + 1;
  byKind[r.verdict.kind] = (byKind[r.verdict.kind] || 0) + 1;
  if (r.verdict.fire) fired += 1;
}
console.log('');
console.log('fire      ' + fired + '/' + results.length + '  (' + (results.length ? (fired / results.length * 100).toFixed(0) : 0) + '%)');
console.log('by source ' + JSON.stringify(bySource));
console.log('by kind   ' + JSON.stringify(byKind));
console.log('elapsed   ' + (elapsed / 1000).toFixed(1) + 's  (' + (results.length ? (elapsed / results.length).toFixed(0) : 0) + ' ms/message)');
if (failures.length) {
  const unique = [...new Set(failures.map((f) => f.layer + ': ' + f.message))].slice(0, 5);
  console.log('failures  ' + failures.length + '  e.g. ' + unique.join(' | '));
}

console.log('');
console.log('--- fired turns ---');
for (const r of results.filter((x) => x.verdict.fire).slice(0, 25)) {
  console.log('  ' + String(r.verdict.source).padEnd(8) + ' ' + String(r.verdict.kind).padEnd(15)
    + ' ' + r.verdict.confidence.toFixed(2) + '  ' + JSON.stringify(r.text.slice(0, 46)));
}

if (goldenFile) {
  const golden = JSON.parse(await readFile(goldenFile, 'utf8'));
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  for (const r of results) {
    const want = golden.find((g) => r.text.startsWith(g.text.slice(0, 24)));
    if (!want) continue;
    if (r.verdict.fire && want.fire) tp += 1;
    else if (r.verdict.fire && !want.fire) fp += 1;
    else if (!r.verdict.fire && want.fire) fn += 1;
    else tn += 1;
  }
  console.log('');
  console.log('--- golden comparison ---');
  console.log('  tp ' + tp + '  fp ' + fp + '  fn ' + fn + '  tn ' + tn);
  console.log('  precision ' + (tp + fp ? (tp / (tp + fp)).toFixed(2) : 'n/a')
    + '  recall ' + (tp + fn ? (tp / (tp + fn)).toFixed(2) : 'n/a'));
}

if (out) {
  await writeFile(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('');
  console.log('wrote ' + out + ' (' + results.length + ' lines)');
}
