/**
 * Reading one session's entries back out of the index, for `memory_read`.
 *
 * Kept separate from the tool and from the mount function for one reason: the
 * anchor arithmetic and the character budget are the parts that can be wrong
 * silently (an off-by-one window still returns text; a bad budget still returns
 * entries), so they are pure functions with direct tests. The mount function
 * only adds caching and the index it already holds.
 *
 * SPDX-License-Identifier: MIT
 */

/** @typedef {{ seq: number|null, time: number, role: string, text: string, orphaned: boolean }} SessionRow */

/**
 * Group every unit in the index by its session, ordered by sequence.
 *
 * A unit without a session id is skipped: it cannot be addressed by
 * `memory_read`, and grouping it under '' would make the empty string match
 * every orphaned unit at once.
 *
 * @param {{ data?: { units?: any[] } }} index
 * @returns {Map<string, SessionRow[]>}
 */
export function collectSessionRows(index) {
  const bySession = new Map();
  const units = index?.data?.units ?? [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const key = String(unit?.session ?? '');
    if (!key) continue;
    let list = bySession.get(key);
    if (!list) { list = []; bySession.set(key, list); }
    list.push({
      seq: Number.isInteger(unit.seq) ? unit.seq : null,
      time: Number(unit.time) || 0,
      role: String(unit.role ?? ''),
      text: String(unit.text ?? ''),
      orphaned: unit.orphaned === true,
    });
  }
  for (const list of bySession.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return bySession;
}

/**
 * Find the session a caller named.
 *
 * Exact match first, then a prefix in either direction: recall reports whatever
 * the index stored, and different producers truncate session ids at different
 * lengths (16 characters in telemetry, the full id in units).
 *
 * @param {Map<string, SessionRow[]>} bySession
 * @param {string} session
 * @returns {SessionRow[]|null}
 */
export function findSession(bySession, session) {
  const target = String(session ?? '').trim();
  if (!target) return null;
  const exact = bySession.get(target);
  if (exact) return exact;
  for (const [key, list] of bySession) {
    if (key.startsWith(target) || target.startsWith(key)) return list;
  }
  return null;
}

/**
 * Cut a window out of one session.
 *
 * Without `seq` the window starts at the first entry — the caller is asking
 * "what is this session", not "what is around here". With `seq` it centres on
 * the nearest entry, which is what a recall result's sequence means: the exact
 * unit may have been merged or dropped since, and refusing to answer over one
 * missing integer would make the tool unusable after any reindex.
 *
 * @param {SessionRow[]} rows
 * @param {number|null} seq
 * @param {number} before
 * @param {number} after
 * @param {number} maxChars
 * @returns {{ entries: any[], truncated: boolean }}
 */
export function sliceSession(rows, seq, before, after, maxChars) {
  let centre = 0;
  if (seq !== null && seq !== undefined) {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rows.length; i += 1) {
      const distance = Math.abs((rows[i].seq ?? 0) - seq);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    centre = best;
  }
  const start = Math.max(0, centre - before);
  const end = Math.min(rows.length, centre + after + 1);

  const entries = [];
  let used = 0;
  let truncated = false;
  for (let i = start; i < end; i += 1) {
    const row = rows[i];
    const room = maxChars - used;
    if (room <= 0) { truncated = true; break; }
    const text = row.text.length > room ? row.text.slice(0, room) + '…' : row.text;
    if (text.length < row.text.length) truncated = true;
    used += text.length;
    entries.push({
      ...(row.seq === null ? {} : { seq: row.seq }),
      ...(row.role ? { role: row.role } : {}),
      ...(row.time > 0 ? { when: new Date(row.time).toISOString() } : {}),
      text,
      ...(row.orphaned ? { orphaned: true } : {}),
    });
  }
  return { entries, truncated };
}
