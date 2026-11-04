#!/usr/bin/env node
/**
 * One command that answers "is the memory system healthy right now?".
 *
 * Every failure this project has had was silent. The gate stopped letting
 * anything through for five days and the log said nothing; a recall finished and
 * was dropped with no event; the automatic path and the tool path drifted apart
 * because they had separate scales. Reading a 5800-line JSONL by hand is not a
 * maintenance procedure.
 *
 * So this checks the pieces that can fail independently and prints a verdict per
 * piece, in the order a failure would hurt:
 *
 *   index    exists, has units, matches the configured embedding space, is fresh
 *   models   the embedder and the reranker actually answer, and how fast
 *   cards    the curated layer: count, governance state, tags, vector space
 *   traffic  the last seven days of decisions, with the silent-failure patterns
 *            called out explicitly (armed but never injected, gate always drops,
 *            hints never consumed, late-drops climbing), plus the two new ways
 *            that log lies: late-drops concentrated into one event day rather
 *            than spread evenly, and judge decisions that silently degraded
 *   coldstart the log's own cold-start times against the client timeout they are
 *            racing, because the smoke test above warms the model first and so
 *            can never reproduce the two-minute start that drops real recalls
 *   backups  old index and card copies sitting next to the live ones, which get
 *            read as current state by whoever greps the directory
 *   config   which switches are on, because "off" and "broken" look identical
 *
 * Exit code is 0 when nothing is wrong, 1 when something is. A warning counts as
 * "something is": a degraded deployment is not a healthy one, and the failures
 * this script exists to find all looked healthy from a switch-level report. Pass
 * --allow-degraded to report warnings without failing, so it can still be put in
 * a cron or a pre-flight check that only gates on hard faults.
 *
 *   node scripts/memory-doctor.mjs
 *   node scripts/memory-doctor.mjs --json
 *   node scripts/memory-doctor.mjs --days 14
 *   node scripts/memory-doctor.mjs --allow-degraded
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readIndex, defaultIndexDir } from '../lib/store.mjs';
import { embedBatch, resolveConfig } from '../lib/embedder.mjs';
import { rerankEntries, resolveRerankConfig } from '../lib/rerank.mjs';
import { readCards, defaultCardPath } from '../lib/cards.mjs';
import { resolveJudgeConfig } from '../lib/judge.mjs';
import { resolveApiKey } from '../lib/synthesize.mjs';
import { resolveResidentConfig } from '../lib/resident.mjs';
import { resolvePolicy } from '../lib/policy.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) throw new Error(flag + ' needs a value');
  return next;
};
const asJson = argv.includes('--json');
/** Warnings are the degraded verdict; --allow-degraded keeps them out of the exit code. */
const allowDegraded = argv.includes('--allow-degraded');
const days = Number(valueOf('--days', '7'));

// A "skip" is the fourth level, and it exists because the honest answer to
// "how long does a cold start take" is sometimes "nothing here has measured
// one". A warn would invent a fault and an ok would hide the gap.
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const statsPath = process.env.DSH_G_MEMORY_AUTO_STATS || join(home, 'dsh-g-memory', 'auto-recall-stats.jsonl');
const statsDir = dirname(statsPath);
const localDay = (t) => {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const localStamp = (t) => {
  const d = new Date(t);
  return localDay(t) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const mb = (bytes) => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
// Recursive, with symlinks counted as their own size rather than followed:
// this walks a directory whose whole problem is old copies pointing at each
// other, and following them once cost a five-minute walk on a real machine.
async function treeBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(full);
    else if (entry.isFile()) total += await stat(full).then((s) => s.size).catch(() => 0);
  }
  return total;
}
const CONFIG_FILE = join(dirname(new URL(import.meta.url).pathname), '..', 'lib', 'config.mjs');
let configDefault = null;
// Read the schema's own default rather than hard-coding 30 000: this script
// exists to notice when a measured number and a declared one disagree, so it
// should not add a third copy of the number that can drift.
async function readConfigDefault() {
  if (configDefault !== null) return configDefault;
  configDefault = 30_000;
  try {
    const text = await readFile(CONFIG_FILE, 'utf8');
    const at = text.indexOf("  embed: t.object({");
    if (at !== -1) {
      const m = /timeoutMs: t\.number\(([0-9_]+)/.exec(text.slice(at, at + 600));
      if (m) configDefault = Number(m[1].replace(/_/g, ''));
    }
  } catch { /* unreadable schema: the documented default stands */ }
  return configDefault;
}
const findings = [];
const say = (level, area, message, advice) => findings.push({ level, area, message, ...(advice ? { advice } : {}) });
const ok = (area, message) => say('ok', area, message);
const warn = (area, message, advice) => say('warn', area, message, advice);
const bad = (area, message, advice) => say('bad', area, message, advice);

// --------------------------------------------------------------- observed
// The decision log is read first because it is the only witness to the running
// configuration. This process sees its own environment, not the composition the
// host was started with, and on this machine those two disagree: the profiles set
// the reranker, the gate and now the judge/resident switches, while a shell that
// runs the doctor has none of them. Reporting the environment as if it were the
// deployment sent the first version of this script to "no reranker configured"
// on a host whose gate events all say "reranked: true".
const observed = { rows: [], gate: null, events: new Set(), newest: 0 };
try {
  const raw = await readFile(statsPath, 'utf8');
  const cutoff = Date.now() - days * 86_400_000;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.t >= cutoff) observed.rows.push(entry);
  }
  observed.gate = [...observed.rows].reverse().find((r) => r.event === 'gate') || null;
  for (const row of observed.rows) observed.events.add(row.event);
  observed.newest = observed.rows.reduce((a, r) => Math.max(a, r.t || 0), 0);
} catch { /* no log yet: every observation below degrades to the environment */ }

// ------------------------------------------------------------------- index
const indexDir = defaultIndexDir();
let index = null;
try {
  index = await readIndex(indexDir);
  const fileStat = await stat(join(indexDir, 'index.ndjson.zstd')).catch(() => null);
  const embedCfg = resolveConfig();
  if (index.size === 0) bad('index', 'the index has no units', 'run: npm run build');
  else ok('index', index.size + ' units, ' + index.dim + ' dims, model ' + (index.model || '(unrecorded)'));

  // The space the index was built in and the space the deployment queries in
  // have to be the same one. This is the failure that is invisible from the
  // outside: every score looks plausible and nothing is ever relevant.
  const indexPrefix = index.docPrefix ?? '(none recorded)';
  const cfgPrefix = embedCfg.docPrefix || '';
  if (indexPrefix !== '(none recorded)' && indexPrefix !== cfgPrefix) {
    bad('index', 'doc-prefix mismatch: index has ' + JSON.stringify(indexPrefix) + ', config has ' + JSON.stringify(cfgPrefix),
      'rebuild the index with the configured prefixes, or fix the config');
  } else {
    ok('index', 'doc-prefix matches the configured embedding space');
  }

  // Freshness: a live index writes whenever a session goes quiet, so a stale
  // file means the writer stopped, not that nothing happened.
  let newest = 0;
  for (let i = 0; i < index.size; i += 1) {
    const time = Number(index.unit(i).time) || 0;
    if (time > newest) newest = time;
  }
  const ageMinutes = newest > 0 ? (Date.now() - newest) / 60_000 : Infinity;
  const mtimeAge = fileStat ? (Date.now() - fileStat.mtimeMs) / 60_000 : Infinity;
  if (mtimeAge > 24 * 60) warn('index', 'index file last written ' + (mtimeAge / 60).toFixed(1) + ' h ago', 'is a host running? the live index only writes while sessions are active');
  else ok('index', 'last written ' + mtimeAge.toFixed(0) + ' min ago; newest unit ' + (Number.isFinite(ageMinutes) ? ageMinutes.toFixed(0) + ' min old' : 'unknown'));
} catch (error) {
  bad('index', 'cannot read ' + indexDir + ': ' + (error?.message || error), 'run: npm run selfcheck');
}

// ------------------------------------------------------------------ models
const embedCfg = resolveConfig();
const started = Date.now();
try {
  const [vector] = await embedBatch(['doctor smoke test'], embedCfg, { purpose: 'query' });
  const ms = Date.now() - started;
  if (!vector || vector.length === 0) bad('models', 'the embedder returned no vector');
  else if (index && vector.length !== index.dim) bad('models', 'embedder returns ' + vector.length + ' dims, index has ' + index.dim, 'they must match: rebuild or reconfigure');
  else ok('models', 'embedder ok (' + vector.length + ' dims, ' + ms + ' ms) at ' + embedCfg.url);
} catch (error) {
  bad('models', 'embedder unreachable at ' + embedCfg.url + ': ' + (error?.message || error), 'start it: bash ~/bin/dsh-quick.sh --services-only');
}
const rerankCfg = resolveRerankConfig();
if (!rerankCfg.url && observed.gate && observed.gate.reranked === true) {
  ok('models', 'reranker not in this shell, but the running host ranks with one (observed on its last gate decision)');
} else if (!rerankCfg.url) {
  warn('models', 'no reranker configured and no evidence of one at runtime, so the gate falls back to the fused floor', 'set rerank.url in the plugin config');
} else {
  const t0 = Date.now();
  try {
    const { entries, reranked } = await rerankEntries('doctor smoke test', [{ text: 'a relevant document' }, { text: 'an unrelated document' }], { config: rerankCfg });
    if (!reranked) warn('models', 'reranker did not answer; ranking degraded to fused order');
    else ok('models', 'reranker ok (' + (Date.now() - t0) + ' ms) at ' + rerankCfg.url + ', scores ' + entries.map((e) => Number(e.rerankScore).toFixed(2)).join('/'));
  } catch (error) {
    bad('models', 'reranker unreachable at ' + rerankCfg.url + ': ' + (error?.message || error), 'start it: bash ~/bin/dsh-quick.sh --services-only');
  }
}

// ------------------------------------------------------------------- cards
/** Read by the traffic section below, to tell "no cards" from "layer not armed". */
let cardCount = 0;
try {
  const cards = await readCards(defaultCardPath());
  cardCount = cards.length;
  if (cards.length === 0) warn('cards', 'no cards: nothing has been consolidated yet', 'consolidation runs after a session goes quiet; check consolidate.enabled');
  else {
    const now = Date.now();
    const active = cards.filter((c) => !c.supersededBy && c.status !== 'superseded' && c.status !== 'retired');
    const withTags = cards.filter((c) => (c.tags || []).length > 0).length;
    const newest = Math.max(...cards.map((c) => Number(c.time) || 0));
    const ageDays = (now - newest) / 86_400_000;
    ok('cards', cards.length + ' cards (' + active.length + ' active, ' + withTags + ' tagged), newest ' + ageDays.toFixed(1) + ' d old');
    if (ageDays > 30) warn('cards', 'no new card in ' + ageDays.toFixed(0) + ' days', 'consolidation may be failing: check receipts.ndjson');
    if (index && cards[0].vector) {
      const packed = Buffer.from(cards[0].vector, 'base64');
      const dim = packed.length - 4;
      if (dim !== index.dim) bad('cards', 'card vectors are ' + dim + ' dims, index is ' + index.dim, 'cards and index must share an embedding space');
      else ok('cards', 'card vectors share the index embedding space (' + dim + ' dims)');
    }
  }
} catch (error) {
  bad('cards', 'cannot read the card store: ' + (error?.message || error));
}

// ----------------------------------------------------------------- traffic
{
  const rows = observed.rows;
  const count = (event) => rows.filter((r) => r.event === event).length;
  const armed = count('armed');
  const injected = count('inject');
  const gatePass = rows.filter((r) => r.event === 'gate' && r.verdict === 'pass').length;
  const gateDrop = rows.filter((r) => r.event === 'gate' && r.verdict === 'drop').length;
  const judged = count('judge');
  const judgeFire = rows.filter((r) => r.event === 'judge' && r.verdict === 'fire').length;
  const hints = count('hint');
  const resident = count('resident');
  /**
   * A late-drop is not one thing any more. `carried-to-next-turn` is a result
   * that missed this turn's window and was handed to the next one — the repair
   * working, not a loss; every other reason is still a recall that died waiting.
   */
  const lateDrops = rows.filter((r) => r.event === 'late-drop');
  const carried = lateDrops.filter((r) => r.why === 'carried-to-next-turn').length;
  /**
   * Expired results that a later turn never replaced.
   *
   * `expired` used to be counted as a lost recall, and on this deployment it
   * almost never is: measured 2026-11-03, 28 of 29 expired results were followed
   * by a new `armed` turn in the same session (p50 gap 7 minutes), which starts a
   * fresh recall. What was lost is the *work* — one embedding, one rerank — not
   * the memory. Only the ones with no later turn are a recall the model never
   * got the chance to see, and those are what this number now counts.
   */
  const expiredRows = lateDrops.filter((r) => r.why === 'expired' || r.why === 'superseded-expired');
  const rowsBySession = new Map();
  for (const row of rows) {
    const key = row.session;
    if (typeof key !== 'string' || key === '') continue;
    const list = rowsBySession.get(key) ?? [];
    list.push(row);
    rowsBySession.set(key, list);
  }
  const orphanedExpired = expiredRows.filter((row) => !(rowsBySession.get(row.session) ?? [])
    .some((later) => later.t > row.t && later.event === 'armed')).length;
  const reingested = expiredRows.length - orphanedExpired;
  const lostLate = lateDrops.length - carried - reingested;

  if (rows.length === 0) warn('traffic', 'no decisions recorded in the last ' + days + ' days', 'is DSH_G_MEMORY_AUTO_STATS pointing at ' + statsPath + '?');
  else {
    ok('traffic', 'last ' + days + ' d: armed ' + armed + ', inject ' + injected + ', gate pass/drop ' + gatePass + '/' + gateDrop
      + (judged ? ', judge ' + judged + ' (fire ' + judgeFire + ')' : '')
      + (resident ? ', resident ' + resident : '') + (hints ? ', hint ' + hints : '')
      + ', late-drop ' + lateDrops.length
      + (lateDrops.length > 0
        ? ' (' + carried + ' carried, ' + reingested + ' re-ingested by a later turn, ' + lostLate + ' orphaned)'
        : ''));
    // The silent patterns, named. Each of these has happened for real.
    if (armed > 20 && injected === 0 && gatePass === 0) {
      bad('traffic', 'armed ' + armed + ' times, the gate never passed: automatic injection is effectively off',
        'this is the 2026-10-08 failure. Check policy.gate against the real score distribution (npm run label)');
    }
    if (judgeFire > 0 && hints === 0 && resident === 0) {
      warn('traffic', 'the judge fired ' + judgeFire + ' times but nothing was ever handed to the model', 'is DSH_G_MEMORY_HINT off, or was every fire also a gate pass?');
    }
    if (lostLate > 0) {
      warn('traffic', 'late-drop orphaned ' + lostLate + ' recall(s): finished after their turn, and no later turn in that session asked again',
        'this is the real loss; a rising count means the step window is closing before retrieval finishes AND the session went quiet');
    } else if (carried + reingested > 0) {
      ok('traffic', carried + ' recall(s) carried into the next turn, ' + reingested + ' expired and were re-ingested by the next turn — work spent, memory not lost');
    }
    if (injected > 0) {
      const ratios = rows.filter((r) => r.event === 'inject').map((r) => Number(r.chars) || 0);
      const avg = Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length);
      ok('traffic', 'injections averaged ' + avg + ' characters');
    }
    // The index layer has no per-turn event: the only evidence it is wired at all
    // is a `index-layer` line, written when the rendered block changes. Cards
    // present but no line in the window means the host is still running a build
    // from before the layer — it is a source change, so only a restart arms it.
    // "Every signal green, channel absent" is the failure this doctor exists for.
    const layerRows = rows.filter((r) => r.event === 'index-layer');
    if (layerRows.length > 0) {
      const last = layerRows[layerRows.length - 1];
      ok('traffic', 'index layer: ' + last.shown + ' entries (' + last.chars + ' chars'
        + (Number(last.hidden) > 0 ? ', ' + last.hidden + ' stale hidden' : '') + ') in the assembled prompt');
    } else if (cardCount > 0) {
      warn('traffic', 'cards exist (' + cardCount + ') but the index layer never rendered in the last ' + days + ' d',
        'it rides system-prompt/assemble, which is a source change: restart the host and check indexLayer.enabled before reading this as "nothing to show"');
    }
  }
}

// What each profile declares. Read before the checks below, because the
// cold-start budget is one of the declared values and a check that reads its own
// input after itself is how a script reports a ReferenceError as "unmeasured".
// (The config section below reads this same `declared`.)
async function declaredInProfiles() {
  const out = [];
  for (const profile of ['web', 'desktop', 'headless']) {
    let text = '';
    try { text = await readFile(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'); } catch { continue; }
    const start = text.indexOf('- id: dsh-g-memory');
    if (start === -1) continue;
    const next = text.indexOf('\n- ', start + 1);
    const block = text.slice(start, next === -1 ? undefined : next);
    const grab = (re) => { const m = re.exec(block); return m ? m[1] : null; };
    out.push({
      profile,
      judge: grab(/^    judge:\n(?:[^\n]*\n)*?      provider: (\S+)/m),
      // The backend the declared provider would actually reach. Without these the
      // reachability check below could only ever inspect this shell's
      // environment, where a judge is almost always `off` — so it would report
      // nothing about the host it is supposed to be diagnosing.
      judgeUrl: grab(/^    judge:\n(?:[^\n]*\n)*?        url: (\S+)/m),
      judgeKeyName: grab(/^    judge:\n(?:[^\n]*\n)*?        apiKeyName: (\S+)/m),
      judgeThreshold: grab(/^    judge:\n(?:[^\n]*\n)*?      threshold: (\S+)/m),
      judgeTimeout: grab(/^    judge:\n(?:[^\n]*\n)*?      timeoutMs: (\S+)/m),
      resident: grab(/^    resident:\n(?:[^\n]*\n)*?      enabled: (\S+)/m),
      residentLimit: grab(/^    resident:\n(?:[^\n]*\n)*?      limit: (\S+)/m),
      gate: grab(/^    policy:\n(?:[^\n]*\n)*?      gate: (\S+)/m),
      midGate: grab(/^    policy:\n(?:[^\n]*\n)*?      midGate: (\S+)/m),
      marginGate: grab(/^    policy:\n(?:[^\n]*\n)*?      marginGate: (\S+)/m),
      cardMinSimilarity: grab(/^    policy:\n(?:[^\n]*\n)*?      cardMinSimilarity: (\S+)/m),
      cardMargin: grab(/^    policy:\n(?:[^\n]*\n)*?      cardMargin: (\S+)/m),
      minContentChars: grab(/^    policy:\n(?:[^\n]*\n)*?      minContentChars: (\S+)/m),
      maxEntryChars: grab(/^    policy:\n(?:[^\n]*\n)*?      maxEntryChars: (\S+)/m),
      // The embed timeout the host would run with. Scoped to the `embed:` section
      // on purpose: the same block sets a judge timeout, a synthesis timeout and
      // a title timeout, so a whole-block search reports whichever one happens to
      // come first as "the" timeout the embedder races. Absent here means the
      // schema default applies, which is exactly the fact worth reporting.
      embedTimeout: (() => {
        const embedAt = block.search(/^    embed:\s*$/m);
        if (embedAt === -1) return null;
        const after = block.slice(embedAt + 1);
        const next = after.search(/^    [a-zA-Z]/m);
        const m = /^      timeoutMs:\s*(\S+)/m.exec(next === -1 ? after : after.slice(0, next));
        return m ? m[1] : null;
      })(),
    });
  }
  return out;
}
const declared = await declaredInProfiles();

// -------------------------------------------------------------- coldstart
// The smoke test in `models` above answers one question well — is the embedder
// up right now — and it cannot answer the question that has actually dropped
// recalls. It queries a model that is by definition already warm: the doctor's
// own request starts the sidecar, but the arrival of that request is itself the
// warm-up, so the measured 59 ms is the steady state, never the start. The
// failure this leaves green is the documented one: the daemon releases its
// child after 300 s idle, the next request pays a full model load, the start
// has been measured at 3.2–6.0 s when healthy and at 56.2 / 117.7 s / ≥180 s
// when it is not, and the client gives up long before the long ones finish.
//
// The log has the honest numbers, so the check reads the log instead of trying
// to reproduce the fault. It stays a static read: nothing here wakes the
// sidecar, because a health check that induces a two-minute cold start every
// time it runs is a health check that causes the incident.
//
// Shape of the lines it reads (HH:MM:SS, no date — the file is not rotated):
//   [embed-gemma2] 04:06:43 就绪，用时 117.7s（pid 11276）
const EMBED_LOG = process.env.DSH_G_MEMORY_EMBED_LOG || join(home, 'logs', 'embed-gemma2.log');
const READY_LINE = /^\[[^\]]+\]\s+(\d{2}:\d{2}:\d{2})\s+就绪，用时\s+([0-9]+(?:\.[0-9]+)?)\s*s/;
try {
  const text = await readFile(EMBED_LOG, 'utf8');
  const samples = [];
  for (const line of text.split('\n')) {
    const m = READY_LINE.exec(line);
    if (m) samples.push({ at: m[1], s: Number(m[2]) });
  }
  // A start the script has no line for at all. The daemon logs its own killer:
  // "启动超时（180s）" is the start that failed rather than finished, and it is
  // the worst case for the client, so it belongs in the report even though it
  // cannot be averaged in with the ones that completed.
  const neverStarted = (text.match(/启动超时（(\d+)s）/g) || []).length;
  if (samples.length === 0) {
    say('skip', 'coldstart', 'no cold-start records in ' + EMBED_LOG + ' — cannot say how long a cold start takes here, only that none has been logged'
      + (neverStarted ? ' (' + neverStarted + ' start(s) timed out outright)' : ''),
      'the log is written by the sidecar that serves the embedder; if it is missing, cold starts are unmeasured');
  } else {
    const sorted = samples.map((s) => s.s).sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const p50 = pick(0.5);
    const p95 = pick(0.95);
    const max = sorted[sorted.length - 1];
    const worst = samples.filter((s) => s.s === max).slice(0, 3);
    const startWord = 'cold start (n=' + samples.length + ', log has no dates so the window does not apply)';
    const fmt = (s) => s + 's';

    // Which timeout the start is racing, and where that number comes from. The
    // profiles are the authority here, not this shell: a shell running the
    // doctor has none of these variables set, and the whole failure mode is a
    // host whose config the shell cannot see.
    const cfgDefault = await readConfigDefault();
    const declaredTimeout = declared.map((d) => ({ profile: d.profile, ms: Number(d.embedTimeout) })).filter((d) => Number.isFinite(d.ms));
    const envTimeout = Number(process.env.DSH_G_MEMORY_EMBED_TIMEOUT_MS);
    const effective = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : null;
    const candidates = (declaredTimeout.length ? declaredTimeout.map((d) => d.ms) : [effective ?? cfgDefault]);
    // The strictest client is the one that gives up first, and on this machine
    // that is a real distinction: the profiles disagree, so the start has to
    // clear the smallest number rather than the one this shell happens to have.
    const budget = Math.min(...candidates);
    // Everything above is milliseconds and everything below is seconds — the log
    // prints seconds, the config is written in ms, and comparing the two
    // directly is a silent factor of 1000 that makes a 117.7 s start look like
    // it fits a 90 s budget. One conversion, at the boundary, on purpose.
    const budgetSec = budget / 1000;
    const source = declaredTimeout.length
      ? (declaredTimeout.length > 1
        ? 'profiles ' + declaredTimeout.map((d) => d.profile + ' ' + d.ms + 'ms').join(' / ') + ' (min ' + budget + 'ms)'
        : 'profile ' + declaredTimeout[0].profile + ' override ' + budget + 'ms')
      : effective !== null
        ? 'environment DSH_G_MEMORY_EMBED_TIMEOUT_MS ' + effective + 'ms'
        : 'schema default ' + cfgDefault + 'ms (no profile overrides embed.timeoutMs)';
    const head = startWord + ': P50 ' + fmt(p50) + ', P95 ' + fmt(p95) + ', max ' + fmt(max)
      + '; budget ' + budgetSec + 's (' + budget + 'ms) from ' + source;

    if (max >= budgetSec) {
      warn('coldstart', head
        + " — the slowest start observed (" + max + "s) does not fit the client's budget; it was recorded at " + worst.map((w) => w.at).join(', ') + ' (log times carry no date)',
        'each timeout is a dropped recall, not a slow one: the client has already given up and the model finishes into a disconnected socket. Raise embed.timeoutMs past the healthy start (3–6 s), or stop the daemon releasing the child after 300 s idle');
    } else {
      ok('coldstart', head);
    }
    if (neverStarted) {
      warn('coldstart', neverStarted + " start(s) in this log never became ready (the daemon's own 180 s limit fired)",
        'a start that cannot finish inside 180 s is a wedged model load, not a slow one: check memory pressure and the gguf path');
    }
  }
} catch (error) {
  say('skip', 'coldstart', 'no cold-start times readable from ' + EMBED_LOG + ' (' + (error?.code || error?.name || 'unreadable') + ': ' + String(error?.message || error).slice(0, 80) + ')',
    'this is the log the on-demand sidecar writes; without it the smoke test above is the only timing evidence, and it never sees a cold start');
}

// ------------------------------------------------------------- judge degrade
// The judge has a fallback that fails silently by construction: when the backend
// does not answer, the decision degrades to rules and every degraded turn returns
// "skip" while writing no event of its own. The only surviving trace is the
// `why` field on the judge row, so aggregate counts read exactly like a healthy
// deployment that simply decided not to retrieve.
//
// A raw count is the wrong statistic. Twenty fallbacks spread over seven quiet
// days is a very different system from twenty in one afternoon, and the
// 2.5-5.3 s timeouts behind the 2026-10-23 spike are background noise on other
// days. So the alarm is the *share of decisions per day* (>10%), and the message
// names the failure class judge.mjs records in `why`
// (timeout / http-<status> / parse / network / circuit-open) so the next
// investigation starts from a cause instead of from the endpoint.
const JUDGE_FALLBACK_ALARM = 0.10;
{
  const decisions = observed.rows.filter((r) => r.event === 'judge');
  const isDegraded = (r) => r.source === 'fallback' || /model layers unavailable/i.test(String(r.why || ''));
  const degraded = decisions.filter(isDegraded);
  const byDay = new Map();
  for (const r of decisions) {
    const key = localDay(r.t);
    const bucket = byDay.get(key) || { total: 0, fellBack: 0 };
    bucket.total += 1;
    if (isDegraded(r)) bucket.fellBack += 1;
    byDay.set(key, bucket);
  }
  const causes = new Map();
  for (const r of degraded) {
    const m = /:(?: chat| jev) ([a-z0-9-]+)/i.exec(String(r.why || ''));
    const key = m ? m[1] : 'unclassified';
    causes.set(key, (causes.get(key) || 0) + 1);
  }
  const causeText = causes.size
    ? ' [' + [...causes.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => kind + ' ' + n).join(', ') + ']'
    : '';
  const share = decisions.length ? degraded.length / decisions.length : 0;
  // A day needs a denominator before its ratio means anything: 1 fallback in 3
  // decisions is noise, not a 33% incident.
  const hotDays = [...byDay.entries()]
    .filter(([, b]) => b.total >= 4 && b.fellBack / b.total > JUDGE_FALLBACK_ALARM)
    .sort((a, b) => b[1].fellBack / b[1].total - a[1].fellBack / a[1].total);
  const advice = 'every degraded decision answers "skip" with no event of its own, so the automatic path looks quiet rather than broken. Check the backend key and endpoint, then judge.timeoutMs against how long it really takes to answer';
  if (degraded.length === 0) {
    ok('judge', decisions.length + ' judge decision(s) in ' + days + ' d, none degraded to the fallback');
  } else if (share > JUDGE_FALLBACK_ALARM || hotDays.length > 0) {
    const worst = hotDays.slice(0, 3).map(([day, b]) => day + ' ' + b.fellBack + '/' + b.total + ' (' + Math.round((b.fellBack / b.total) * 100) + '%)');
    warn('judge', 'judge degraded on ' + degraded.length + '/' + decisions.length + ' decisions in ' + days + ' d ('
      + Math.round(share * 100) + '%, alarm >' + Math.round(JUDGE_FALLBACK_ALARM * 100) + '%)' + causeText
      + (worst.length ? '; worst day(s) ' + worst.join(', ') : '')
      + '; first ' + degraded.slice(0, 3).map((r) => localStamp(r.t)).join(', '),
      advice);
  } else {
    // Below the alarm is still not healthy — it is the background rate, reported
    // with its number. Warning on every nonzero day would train the reader to
    // ignore the day that matters.
    ok('judge', 'judge degraded on ' + degraded.length + '/' + decisions.length + ' decisions in ' + days + ' d ('
      + Math.round(share * 100) + '%, below the ' + Math.round(JUDGE_FALLBACK_ALARM * 100) + '% alarm)' + causeText);
  }
}

// -------------------------------------------------------------- late-drop day
// A count over a window is the wrong statistic for this failure. The 42
// late-drops of the 2026-10-19 window were not a slow rise that needed a
// threshold; they were one bad night — 28 of them on a single day — diluted by
// the two quiet days either side. Bucketing by day is what turns "42, elevated"
// into "one day lost a quarter of the day's recalls".
{
  const lateDrops = observed.rows.filter((r) => r.event === 'late-drop');
  const byDay = new Map();
  for (const r of lateDrops) {
    const key = localDay(r.t);
    const bucket = byDay.get(key) || { n: 0, carried: 0 };
    bucket.n += 1;
    if (r.why === 'carried-to-next-turn') bucket.carried += 1;
    byDay.set(key, bucket);
  }
  if (lateDrops.length === 0) {
    say('skip', 'late-drop', 'no late-drops in ' + days + ' d, so nothing to bucket by day');
  } else {
    const ranked = [...byDay.entries()].sort((a, b) => b[1].n - a[1].n);
    const [peakDay, peak] = ranked[0];
    const share = Math.round((peak.n / lateDrops.length) * 100);
    // Same-day correlation is the part worth naming: this failure has a cause
    // that shows up in the log as an unreachable embedder, so whether the worst
    // day coincides with endpoint errors separates "a bad day on the endpoint"
    // from "a limit that needs retuning".
    const errors = observed.rows.filter((r) => r.event === 'error');
    const sameDay = errors.filter((r) => localDay(r.t) === peakDay);
    const correlation = errors.length
      ? (sameDay.length ? '; ' + sameDay.length + ' endpoint-unreachable error(s) that same day (' + sameDay.slice(0, 3).map((r) => localStamp(r.t)).join(', ') + ')' : '; no endpoint-unreachable error recorded that day')
      : '; no endpoint-unreachable error anywhere in the window';
    const verdict = peak.n >= 10 || peak.n / lateDrops.length > 0.5 ? 'warn' : 'ok';
    const message = peakDay + ' accounts for ' + peak.n + '/' + lateDrops.length + ' late-drops in ' + days + ' d (' + share + '%, '
      + byDay.size + ' day(s) with any' + (peak.carried ? ', ' + peak.carried + ' carried into the next turn' : '') + ')' + correlation;
    if (verdict === 'warn') {
      warn('late-drop', message, 'a day this concentrated is an incident, not a trend: line it up against the cold-start log and the endpoint errors before touching the step window');
    } else {
      ok('late-drop', message);
    }
  }
}

// ------------------------------------------------------------------- backups
// The directory the live state lives in is also where every past migration left
// its "before" copy, and the copies are the same shape as the originals. A
// stale 27 MB index.ndjson.zstd next to the live one is not merely wasted disk:
// it is a second answer to "what is in the index right now" for anything that
// resolves the path by glob, including a human reading the directory. Reported
// as counts and bytes so the size is visible without opening anything.
{
  const scanDirs = [...new Set([statsDir, indexDir].filter(Boolean))];
  const found = new Map();
  for (const dir of scanDirs) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.bak-|\.before-/.test(name) && !/^pruned-.*\.ndjson$/.test(name)) continue;
      const full = join(dir, name);
      let size = 0;
      let dirLike = false;
      try {
        const s = await stat(full);
        dirLike = s.isDirectory();
        size = dirLike ? await treeBytes(full) : s.size;
      } catch { /* vanished mid-scan */ }
      found.set(full, { size, dirLike });
    }
  }
  const entries = [...found.entries()].sort((a, b) => b[1].size - a[1].size);
  const total = entries.reduce((a, [, v]) => a + v.size, 0);
  if (entries.length === 0) {
    ok('backups', 'no stale backup copies beside the live state in ' + scanDirs.join(', '));
  } else {
    const detail = entries.slice(0, 3).map(([p, v]) => basename(p) + ' ' + mb(v.size) + (v.dirLike ? ' (directory)' : '')).join(', ');
    const message = entries.length + ' stale backup(s), ' + mb(total) + ' total: ' + detail + (entries.length > 3 ? ', ...' : '');
    if (total > 10 * 1024 * 1024) {
      warn('backups', message, 'these are read as current state by any path that globs the directory; prune them once the migration they belong to is settled');
    } else {
      ok('backups', message);
    }
  }
}

// ------------------------------------------------------------------ config
// What the profiles declare — the third view, and the one that catches the most
// common confusion of all: a switch that is declared, correct, and not yet in
// effect because the host has not restarted since it was written.
if (declared.length > 0) {
  say('ok', 'config', 'declared in profiles: ' + declared.map((d) => d.profile + ' judge=' + (d.judge || '?') + ' resident=' + (d.resident || '?') + ' gate=' + (d.gate || '?')).join(' | '));
  const wantsJudge = declared.some((d) => d.judge && d.judge !== 'off');
  const wantsResident = declared.some((d) => d.resident === 'true' || d.resident === 'on');
  // The judge runs from the second turn on: a resident hit answers the opening
  // turn and returns before the judge is consulted. So "no judge decision" means
  // "not restarted" only while nothing else of the new code has run — reporting it
  // as a restart problem after the resident layer has demonstrably fired sends a
  // healthy deployment looking for a fault that is not there.
  if (wantsJudge && !observed.events.has('judge') && !observed.events.has('resident')) {
    warn('config', 'the profiles enable the judge but neither it nor the resident layer has run', 'the host has not restarted since the config changed; restart it');
  } else if (wantsJudge && !observed.events.has('judge')) {
    say('ok', 'config', 'the judge has not been asked yet — the resident layer answers opening turns, so the judge runs from the second turn on');
  }
  if (wantsResident && !observed.events.has('resident')) {
    warn('config', 'the profiles enable resident cards but no resident decision has been recorded', 'the host has not restarted since the config changed; restart it');
  }
} else {
  warn('config', 'no dsh-g-memory block found in any profile', 'the plugin may be running on defaults');
}

// ------------------------------------------------------------ profile drift
// The interactive hosts read different files and have run different generations
// of this config before: on 2026-10-24 the web profile still carried
// policy.gate=3 with no judge block, while desktop had been on gate=-1.0 +
// judge=chat since 13 Oct. Reporting each profile on its own cannot show that —
// every declared value looks deliberate in isolation — and the symptom is that
// the same plugin behaves differently depending on which host the user opened.
// Only settings the two hosts are expected to share are compared; embed and
// rerank endpoints are already covered by the model and cold-start checks.
const PROFILE_DIFF_FIELDS = [
  ['judge', 'judge.provider'],
  ['judgeThreshold', 'judge.threshold'],
  ['judgeTimeout', 'judge.timeoutMs'],
  ['resident', 'resident.enabled'],
  ['residentLimit', 'resident.limit'],
  ['gate', 'policy.gate'],
  ['midGate', 'policy.midGate'],
  ['marginGate', 'policy.marginGate'],
  ['cardMinSimilarity', 'policy.cardMinSimilarity'],
  ['cardMargin', 'policy.cardMargin'],
  ['minContentChars', 'policy.minContentChars'],
  ['maxEntryChars', 'policy.maxEntryChars'],
];
{
  const pair = declared.filter((d) => d.profile === 'web' || d.profile === 'desktop');
  if (pair.length >= 2) {
    const diffs = [];
    for (const [key, label] of PROFILE_DIFF_FIELDS) {
      const values = pair.map((d) => String(d[key] ?? '(unset)'));
      if (values.some((value) => value !== values[0])) {
        diffs.push(label + ' ' + pair.map((d, i) => d.profile + '=' + values[i]).join(' vs '));
      }
    }
    if (diffs.length === 0) {
      ok('config', pair.map((d) => d.profile).join(' and ') + ' profiles declare the same gate/judge/card/content settings');
    } else {
      warn('config', 'web and desktop profiles disagree on ' + diffs.length + ' setting(s): ' + diffs.join('; '),
        'the two hosts run different generations of this config while reporting the same plugin version; align them (or write down why they differ) before comparing their traffic');
    }
  } else if (pair.length === 1) {
    const [only] = pair;
    warn('config', 'only the ' + only.profile + ' profile declares dsh-g-memory; the other interactive profile would run the plugin on defaults',
      'add the same block to the other profile, or the two hosts will behave differently');
  }
}

// What the host is actually running, as opposed to what this shell would run.
if (observed.rows.length > 0) {
  const states = ['judge', 'resident', 'hint'].filter((e) => observed.events.has(e));
  say('ok', 'config', 'observed at runtime: ' + (states.length ? states.join(' + ') + ' active' : 'neither judge, resident nor hint has fired yet')
    + (observed.gate ? '; last gate decision reranked=' + observed.gate.reranked + ', verdict ' + observed.gate.verdict : ''));
  if (!observed.events.has('judge') && !observed.events.has('resident')) {
    warn('config', 'the log shows no judge or resident decision in ' + days + ' days', 'either the switches are off, or no host has restarted since they were set');
  }
}
const policy = resolvePolicy({});
const judge = resolveJudgeConfig({});
const resident = resolveResidentConfig({});
ok('config', 'policy gate/mid/margin = ' + policy.gate + '/' + policy.midGate + '/' + policy.marginGate + ', candidates ' + (process.env.DSH_G_MEMORY_AUTO_CANDIDATES || '8'));
if (judge.provider === 'off' && !declared.some((d) => d.judge && d.judge !== 'off')) {
  warn('config', 'judge is off: no per-turn decision, no hint delegation', 'set judge.provider in the profile (rules is free)');
} else if (judge.provider === 'off') {
  ok('config', 'this shell has judge off (it reads the environment); the host runs whatever the profile declares');
} else {
  ok('config', 'judge provider ' + judge.provider + ', threshold ' + judge.threshold + ', timeout ' + judge.timeoutMs + ' ms');
}

// Switched on is not the same as able to answer. A judge whose endpoint is
// unreachable, or whose key cannot be resolved, returns "do not retrieve" on
// every turn — the silent channel this layer exists to reopen — while every
// switch still reads as on. Measured 2026-10-13: the desktop host starts the
// plugin with a fixed `--env` list that does not carry the provider key, so a
// chat backend that only read `process.env` would have answered 401 on every
// turn with nothing in the log to say so.
const judgeFromProfile = declared.map((d) => d.judge).find((p) => p && p !== 'off' && p !== 'rules') || null;
const judgeFromEnv = judge.provider !== 'off' && judge.provider !== 'rules' ? judge.provider : null;
const judgeProvider = judgeFromProfile || judgeFromEnv;
if (judgeProvider) {
  // Two views, because they disagree by design: the profiles are what the host
  // runs, and a shell running this script usually has no judge variables at all.
  const declaredBlock = declared.find((d) => d.judge === judgeProvider) || {};
  const base = judgeProvider === 'jev' ? judge.jev : judge.chat;
  const backend = {
    url: declaredBlock.judgeUrl || base.url,
    apiKeyName: declaredBlock.judgeKeyName || base.apiKeyName,
    apiKey: base.apiKey,
  };
  const label = judgeProvider === 'jev' ? 'jev' : 'chat';
  const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(String(backend.url || ''));
  const keyName = backend.apiKeyName || (judgeProvider === 'jev' ? 'OPENCODE_API_KEY' : 'OPENCODE_GO_API_KEY');
  const key = backend.apiKey || (await resolveApiKey(keyName));
  if (!backend.url) {
    bad('config', 'judge provider ' + judgeProvider + ' has no endpoint', 'set judge.' + label + '.url in the profile');
  } else if (!key && !loopback) {
    bad('config', 'the judge backend ' + backend.url + ' has no key: every turn would answer 401 and silently degrade to "do not retrieve"',
      'put ' + keyName + ' in ~/.dsh/.credentials.yaml, or set judge.' + label + '.apiKey in the profile');
  } else {
    ok('config', 'judge provider ' + judgeProvider + ' at ' + backend.url + ' (' + (key ? 'key ' + keyName + ' resolved' : 'loopback, no key needed') + ')');
  }
}

// A judge that never fires is indistinguishable from a memory system that is
// switched off, and a switch-level report calls both healthy. What this can
// honestly measure is the *model* layer. `source: 'rules'` is a deterministic
// short-circuit — an explicit "记得…", a resumed session — decided without asking
// the backend at all, so counting those as "the judge answered no" reports a
// healthy deployment as broken the moment its provider changes (measured: the
// first run after switching `rules` → `chat` called 7 old rules decisions a
// silent judge). `fallback` means the backend *was* asked and did not answer,
// which is a different fault with a different fix.
{
  const decisions = observed.rows.filter((r) => r.event === 'judge');
  const modelled = decisions.filter((r) => r.source === 'chat' || r.source === 'jev');
  const fellBack = decisions.filter((r) => r.source === 'fallback');
  if (modelled.length > 5) {
    const fired = modelled.filter((r) => r.verdict === 'fire').length;
    if (fired === 0) {
      bad('config', 'the judge backend answered "do not retrieve" on all ' + modelled.length + ' decisions in ' + days + ' d',
        'the automatic path is silent from the second turn on. Check the criteria against real messages (npm run label), or the threshold');
    } else {
      ok('config', 'judge backend fired on ' + fired + '/' + modelled.length + ' decisions in ' + days + ' d');
    }
  } else if (modelled.length === 0 && fellBack.length > 5) {
    bad('config', 'every judge decision in ' + days + ' d fell back to the rules (' + fellBack.length + ')',
      'the backend is not answering — check the key, the endpoint and the timeout: a judge that cannot answer degrades to silence');
  } else if (modelled.length > 0) {
    ok('config', 'judge backend answered ' + modelled.length + ' decision(s) in ' + days + ' d (' + modelled.filter((r) => r.verdict === 'fire').length + ' fired)');
  }
}
const residentDeclared = declared.some((d) => d.resident === 'true' || d.resident === 'on');
if (resident.enabled || residentDeclared) ok('config', 'resident cards on, up to ' + resident.limit + ' per session');
else warn('config', 'resident cards off: sessions start with no memory at all', 'set resident.enabled in the profile');
if ((process.env.DSH_G_MEMORY_HINT || 'on') === 'off') warn('config', 'the hint channel is disabled', 'the model will not be told that memory_recall could help');

// ------------------------------------------------------------------ report
const badCount = findings.filter((f) => f.level === 'bad').length;
const warnCount = findings.filter((f) => f.level === 'warn').length;
if (asJson) {
  console.log(JSON.stringify({ at: Date.now(), indexDir, statsPath, findings, verdict: badCount ? 'unhealthy' : warnCount ? 'degraded' : 'healthy' }, null, 1));
} else {
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌', skip: '➖' };
  let area = '';
  for (const f of findings) {
    if (f.area !== area) { area = f.area; console.log(''); }
    console.log('  ' + icon[f.level] + ' [' + f.area + '] ' + f.message);
    if (f.advice) console.log('       -> ' + f.advice);
  }
  console.log('');
  console.log('  ' + (badCount ? '❌ unhealthy' : warnCount ? '⚠️  degraded' : '✅ healthy')
    + '   (' + badCount + ' problems, ' + warnCount + ' warnings)');
}
// A warning is the degraded verdict, and a degraded deployment is not a healthy
// one: the failures this script exists to catch (silent judge fallback, a wrong
// gate floor, an unmeasured cold start) all read as healthy from a switch-level
// report. --allow-degraded keeps the old "only hard faults fail" behaviour for a
// cron that cannot act on warnings.
process.exit(badCount > 0 || (warnCount > 0 && !allowDegraded) ? 1 : 0);
