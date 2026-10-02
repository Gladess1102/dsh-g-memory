/**
 * Shared configuration helpers.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Read a numeric environment variable, rejecting values that would disable a
 * limit instead of tightening it.
 *
 * `Number('abc')` is `NaN`, and every comparison against `NaN` is false, so an
 * unvalidated read silently switches off whichever guard it feeds: a NaN cache
 * size makes the LRU bound unreachable, a NaN candidate count makes every
 * retrieval return nothing, and a NaN timeout makes `AbortSignal.timeout` throw
 * where the caller reports something else entirely. A typo in an environment
 * variable must therefore fall back to the documented default, never remove a
 * bound.
 *
 * @param {string} name environment variable name
 * @param {number} fallback value used when unset, empty, or not finite
 * @param {{ min?: number, max?: number }} [bounds] clamp range, inclusive
 * @returns {number}
 */
export function numberEnv(name, fallback, bounds = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const min = bounds.min ?? -Infinity;
  const max = bounds.max ?? Infinity;
  return Math.min(Math.max(value, min), max);
}

/**
 * Read a boolean-ish environment variable.
 *
 * Accepts the values an operator is likely to type for "off"; anything else,
 * including unset, is `true`, so an unreadable value cannot silently disable a
 * feature the user believes is on.
 *
 * @param {string} name
 * @param {boolean} [fallback]
 * @returns {boolean}
 */
export function boolEnv(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const flag = String(raw).trim().toLowerCase();
  if (flag === '') return fallback;
  return !['off', '0', 'false', 'no'].includes(flag);
}
