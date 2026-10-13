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
 *            hints never consumed, late-drops climbing)
 *   config   which switches are on, because "off" and "broken" look identical
 *
 * Exit code is 0 when nothing is wrong, 1 when something is, so it can be put in
 * a cron or a pre-flight check.
 *
 *   node scripts/memory-doctor.mjs
 *   node scripts/memory-doctor.mjs --json
 *   node scripts/memory-doctor.mjs --days 14
 *
 * SPDX-License-Identifier: MIT
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
const days = Number(valueOf('--days', '7'));

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const statsPath = process.env.DSH_G_MEMORY_AUTO_STATS || join(home, 'dsh-g-memory', 'auto-recall-stats.jsonl');
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
try {
  const cards = await readCards(defaultCardPath());
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
  const lostLate = lateDrops.length - carried;

  if (rows.length === 0) warn('traffic', 'no decisions recorded in the last ' + days + ' days', 'is DSH_G_MEMORY_AUTO_STATS pointing at ' + statsPath + '?');
  else {
    ok('traffic', 'last ' + days + ' d: armed ' + armed + ', inject ' + injected + ', gate pass/drop ' + gatePass + '/' + gateDrop
      + (judged ? ', judge ' + judged + ' (fire ' + judgeFire + ')' : '')
      + (resident ? ', resident ' + resident : '') + (hints ? ', hint ' + hints : '')
      + ', late-drop ' + lateDrops.length + (carried ? ' (' + carried + ' carried into the next turn, ' + lostLate + ' lost)' : ''));
    // The silent patterns, named. Each of these has happened for real.
    if (armed > 20 && injected === 0 && gatePass === 0) {
      bad('traffic', 'armed ' + armed + ' times, the gate never passed: automatic injection is effectively off',
        'this is the 2026-10-08 failure. Check policy.gate against the real score distribution (npm run label)');
    }
    if (judgeFire > 0 && hints === 0 && resident === 0) {
      warn('traffic', 'the judge fired ' + judgeFire + ' times but nothing was ever handed to the model', 'is DSH_G_MEMORY_HINT off, or was every fire also a gate pass?');
    }
    if (lostLate > 0) {
      warn('traffic', 'late-drop lost ' + lostLate + ' recall(s) that were never consumed' + (carried ? ' (and carried ' + carried + ' into the next turn)' : ''),
        'expected occasionally; a rising count means the step window is closing before retrieval finishes');
    } else if (carried > 0) {
      ok('traffic', carried + ' recall(s) finished after their turn\'s last step and were carried into the next one');
    }
    if (injected > 0) {
      const ratios = rows.filter((r) => r.event === 'inject').map((r) => Number(r.chars) || 0);
      const avg = Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length);
      ok('traffic', 'injections averaged ' + avg + ' characters');
    }
  }
}

// ------------------------------------------------------------------ config
// What the profiles declare — the third view, and the one that catches the most
// common confusion of all: a switch that is declared, correct, and not yet in
// effect because the host has not restarted since it was written.
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
      resident: grab(/^    resident:\n(?:[^\n]*\n)*?      enabled: (\S+)/m),
      gate: grab(/^    policy:\n(?:[^\n]*\n)*?      gate: (\S+)/m),
    });
  }
  return out;
}
const declared = await declaredInProfiles();
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
// switched off, and a switch-level report calls both healthy.
{
  const decisions = observed.rows.filter((r) => r.event === 'judge');
  if (decisions.length > 5) {
    const fired = decisions.filter((r) => r.verdict === 'fire').length;
    if (fired === 0) {
      bad('config', 'the judge answered "do not retrieve" on all ' + decisions.length + ' decisions in ' + days + ' d',
        'the automatic path is silent from the second turn on. Check the criteria against real messages (npm run label), or the threshold');
    } else {
      ok('config', 'judge fired on ' + fired + '/' + decisions.length + ' decisions in ' + days + ' d');
    }
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
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
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
process.exit(badCount > 0 ? 1 : 0);
