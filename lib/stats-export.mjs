/**
 * Turning the local decision log into a summary a user can paste into an issue.
 *
 * The plugin keeps its own log (see telemetry.mjs) and nothing leaves the
 * machine. When someone reports a problem, the useful part is aggregate: how
 * many turns, how often the gate passed, whether injections happened at all,
 * where the errors cluster. None of that needs the user's text — and the log
 * deliberately does contain query text, session ids and working directories.
 *
 * So this module is a whitelist, not a redactor: it never copies a string out
 * of an event except the event name and a small set of enumerated fields. If a
 * future event carries a new free-text field, it simply does not appear.
 *
 * SPDX-License-Identifier: MIT
 */

/** Events that mean "something failed", including the per-subsystem aliases. */
const ERROR_EVENTS = new Set(['error', 'live-index-error', 'consolidate-error', 'synthesis-error']);

/** The gate outcomes that decide whether an automatic recall runs. */
const GATE_OUTCOMES = ['pass', 'skip', 'hint'];

/**
 * Parse the JSONL log, ignoring lines that are not objects with an event name.
 *
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function parseStatsLines(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') events.push(parsed);
    } catch { /* a truncated final line is normal after a crash; skip it */ }
  }
  return events;
}

/**
 * Aggregate counts over parsed events.
 *
 * No field that can hold user text is read: q, ws, cwd and why are used for
 * counting at most; session is used only for its cardinality.
 *
 * @param {Array<Record<string, any>>} events
 */
export function summarizeStats(events) {
  const byEvent = Object.create(null);
  const sessions = new Set();
  const days = new Set();
  const judgeSources = Object.create(null);
  let first = null;
  let last = null;
  let injectedChars = 0;
  let injectedTurns = 0;

  for (const event of events) {
    byEvent[event.event] = (byEvent[event.event] ?? 0) + 1;
    const time = Number(event.t);
    if (Number.isFinite(time) && time > 0) {
      if (first === null || time < first) first = time;
      if (last === null || time > last) last = time;
      days.add(new Date(time).toISOString().slice(0, 10));
    }
    if (typeof event.session === 'string' && event.session !== '') sessions.add(event.session);
    if (event.event === 'inject') {
      injectedTurns += 1;
      const chars = Number(event.chars);
      if (Number.isFinite(chars) && chars > 0) injectedChars += chars;
    }
    if (event.event === 'judge' && typeof event.source === 'string') {
      judgeSources[event.source] = (judgeSources[event.source] ?? 0) + 1;
    }
  }

  const gate = {};
  for (const outcome of GATE_OUTCOMES) gate[outcome] = byEvent[outcome] ?? 0;
  const gateTotal = gate.pass + gate.skip + gate.hint;

  let errors = 0;
  for (const [name, count] of Object.entries(byEvent)) {
    if (ERROR_EVENTS.has(name) || name.endsWith('-error')) errors += count;
  }

  return {
    total: events.length,
    first,
    last,
    days: days.size,
    sessions: sessions.size,
    byEvent,
    turns: byEvent.armed ?? 0,
    gate,
    gateTotal,
    passRate: gateTotal > 0 ? Math.round((gate.pass / gateTotal) * 100) : null,
    injections: byEvent.inject ?? 0,
    injectedTurns,
    avgInjectedChars: injectedTurns > 0 ? Math.round(injectedChars / injectedTurns) : 0,
    judgeSources,
    errors,
  };
}

/**
 * Render the summary as Markdown, ready to paste into an issue.
 *
 * @param {ReturnType<typeof summarizeStats>} summary
 * @param {{ version?: string }} [options]
 */
export function renderStatsReport(summary, options = {}) {
  const version = options.version ?? 'unknown';
  const day = (value) => (value === null ? '-' : new Date(value).toISOString().slice(0, 10));
  const lines = [];
  lines.push('### dsh-g-memory usage summary');
  lines.push('');
  lines.push('Aggregate counts from the local decision log. No query text, session ids,');
  lines.push('paths or model output are included.');
  lines.push('');
  lines.push('| field | value |');
  lines.push('|---|---|');
  lines.push('| plugin version | ' + version + ' |');
  lines.push('| log window | ' + day(summary.first) + ' to ' + day(summary.last) + ' (' + summary.days + ' days) |');
  lines.push('| events | ' + summary.total + ' |');
  lines.push('| sessions seen | ' + summary.sessions + ' |');
  lines.push('| turns armed | ' + summary.turns + ' |');
  lines.push('| gate pass / skip / hint | ' + summary.gate.pass + ' / ' + summary.gate.skip + ' / ' + summary.gate.hint
    + (summary.passRate === null ? '' : ' (' + summary.passRate + '% passed)') + ' |');
  lines.push('| injections | ' + summary.injections + ' (avg ' + summary.avgInjectedChars + ' chars) |');
  lines.push('| errors | ' + summary.errors + ' |');
  const sources = Object.entries(summary.judgeSources);
  if (sources.length > 0) {
    sources.sort((a, b) => b[1] - a[1]);
    lines.push('| judge sources | ' + sources.map(([name, count]) => name + ' ' + count).join(', ') + ' |');
  }
  const interesting = ['armed', 'pass', 'skip', 'hint', 'inject', 'resident', 'live-index',
    'index-layer', 'card-reads', 'consolidate'];
  const rows = interesting
    .filter((name) => summary.byEvent[name] !== undefined)
    .map((name) => name + ' ' + summary.byEvent[name]);
  if (rows.length > 0) {
    lines.push('');
    lines.push('Event mix: ' + rows.join(', ') + '.');
  }
  return lines.join('\n');
}
