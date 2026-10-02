/**
 * Tokenization for the lexical (keyword) retrieval arm.
 *
 * Why this exists: DSH's built-in FTS5 index tokenizes with `unicode61`, which
 * splits on script boundaries and therefore treats a whole run of CJK as one
 * token. Measured consequence: naive matching scored 4/8 top-1 on a Chinese
 * query set. Adjacent-character bigrams over CJK raised that to 5/8, beating
 * the pure-vector arm (4/8). Latin words and numbers are also emitted whole.
 *
 * SPDX-License-Identifier: MIT
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /[a-z0-9][a-z0-9._-]*/g;

/**
 * Produce the token multiset for a piece of text.
 *
 * CJK runs contribute every adjacent character pair (a bigram). Latin/digit
 * runs contribute whole words. The result intentionally keeps duplicates so a
 * caller can compute term frequency; use `tokenSet` when only presence matters.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return [];

  /** @type {string[]} */
  const tokens = [];

  for (const match of lower.matchAll(LATIN_WORD)) {
    tokens.push(match[0]);
  }

  // Bigrams over adjacent CJK characters, ignoring non-CJK separators so that
  // "会话 日志" still yields the "会话" and "日志" bigrams within each run.
  let run = '';
  for (const char of lower) {
    if (CJK.test(char)) {
      run += char;
    } else {
      pushBigrams(run, tokens);
      run = '';
    }
  }
  pushBigrams(run, tokens);

  return tokens;
}

/**
 * @param {string} run
 * @param {string[]} out
 */
function pushBigrams(run, out) {
  if (run.length === 1) {
    out.push(run);
    return;
  }
  for (let i = 0; i + 1 < run.length; i += 1) {
    out.push(run.slice(i, i + 2));
  }
}

/**
 * Distinct tokens, for presence-based scoring.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenSet(text) {
  return new Set(tokenize(text));
}
