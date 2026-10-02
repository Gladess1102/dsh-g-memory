/**
 * Text chunking for the memory index.
 *
 * Two strategies, both governed by the serving constraint: the local engine has a
 * physical batch limit and REJECTS longer input (HTTP 500) rather than truncating
 * it. Measured density on this corpus is **0.522 tokens/char** (re-measured
 * against the current EmbeddingGemma tokenizer: 1,687 characters → 881 tokens),
 * so an 800-char chunk is ~418 tokens.
 *
 * The chunk size is kept as measured rather than re-tuned now that the limit has
 * moved: chunking decides what a unit *is*, so changing it invalidates the index
 * and every calibration built on it.
 *
 * SPDX-License-Identifier: MIT
 */

/** Characters per chunk for conversational text. */
export const CHUNK_CHARS = 800;
/** Characters per chunk for tool output (fact-dense, tolerates larger chunks). */
export const CHUNK_CHARS_TOOL = 1200;
/** Overlap carried into the next chunk so facts are not split across a boundary. */
export const CHUNK_OVERLAP = 120;
/** Chunks shorter than this are dropped as noise. */
export const MIN_CHUNK_CHARS = 24;

/** Sentence terminators for both CJK and Latin punctuation, plus newlines. */
const SENTENCE_END = /(?<=[。！？!?；;.\n])/;

/**
 * Split text at sentence boundaries, packing sentences up to `budget` characters.
 *
 * Packing at sentence boundaries (rather than a fixed character window) is what
 * lets a single chunk hold a fact together with its context. Measured effect:
 * combined with RRF fusion this raised top-20 recall from 7/8 to 8/8, because
 * fixed-width cutting had separated values from the labels that explain them.
 *
 * A single sentence longer than the budget is hard-split as a last resort.
 *
 * @param {string} text
 * @param {number} [budget]
 * @param {number} [overlap]
 * @returns {string[]}
 */
/**
 * A private key in PEM form, which must never be split across chunks.
 *
 * The redactor matches `-----BEGIN…` and `-----END…` as a *pair*, and it runs over
 * one fragment at a time. A key longer than a chunk therefore loses the pairing —
 * measured on a real 1,707-character RSA key, the material survived redaction in
 * the chunk that held the BEGIN line, and the README's promise that private keys
 * are redacted before anything is sent did not hold for the candidates it was
 * about. Keeping the block whole keeps the pairing intact; the block is then
 * redacted to a placeholder and, being short, is not worth injecting either.
 */
const PEM_BLOCK = /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g;

export function chunkBySentence(text, budget = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  // `step = budget - overlap` collapses to 1 when overlap >= budget, which turns
  // the loop into one chunk per character — a 10k input becomes ~10k chunks. No
  // caller does this today; the guard is here so a future one cannot.
  if (overlap >= budget) throw new RangeError(`overlap (${overlap}) must be smaller than budget (${budget})`);
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (t.length <= budget) return [t];

  // Keys are carved out before anything else splits, then re-inserted in order, so
  // no chunk boundary can land inside one.
  if (PEM_BLOCK.test(t)) {
    PEM_BLOCK.lastIndex = 0;
    const pieces = [];
    let cursor = 0;
    for (const match of t.matchAll(PEM_BLOCK)) {
      if (match.index > cursor) pieces.push(...chunkPlain(t.slice(cursor, match.index), budget, overlap));
      pieces.push(match[0].trim());
      cursor = match.index + match[0].length;
    }
    if (cursor < t.length) pieces.push(...chunkPlain(t.slice(cursor), budget, overlap));
    return pieces.filter((c) => c.length > 0);
  }
  return chunkPlain(t, budget, overlap);
}

/** The sentence-boundary chunker, without the private-key carve-out. */
function chunkPlain(t, budget, overlap) {

  const sentences = t.split(SENTENCE_END);
  /** @type {string[]} */
  const out = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence) continue;

    if (sentence.length > budget) {
      if (current) {
        out.push(current);
        current = '';
      }
      const step = Math.max(1, budget - overlap);
      for (let i = 0; i < sentence.length; i += step) {
        out.push(sentence.slice(i, i + budget));
      }
      continue;
    }

    if (current.length + sentence.length <= budget) {
      current += sentence;
    } else {
      out.push(current);
      const tail = overlap > 0 && current.length > overlap ? current.slice(-overlap) : '';
      current = tail + sentence;
    }
  }
  if (current) out.push(current);

  return out.map((c) => c.trim()).filter((c) => c.length >= MIN_CHUNK_CHARS);
}

/**
 * Collapse runs of whitespace without destroying sentence structure.
 * Newlines are kept as weak boundaries by the splitter, so only spaces/tabs
 * are normalised here.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/[ \t\u00a0]+/g, ' ').trim();
}

/**
 * Remove unpaired UTF-16 surrogates.
 *
 * Session logs can contain lone surrogates (truncated emoji, mojibake). They are
 * legal in a JavaScript string, so `JSON.stringify` emits them verbatim as
 * `\uD8xx` escapes — and a strict JSON parser on the other end rejects the
 * payload with "surrogate U+DC00..U+DFFF must follow U+D800..U+DBFF". Observed
 * for real: an embedding run failed at unit 10,000 for exactly this reason.
 *
 * `String.prototype.toWellFormed` does this natively where available.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  const value = String(text ?? '');
  if (typeof value.toWellFormed === 'function') return value.toWellFormed();
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Whether a chunk carries anything worth retrieving.
 *
 * Deterministic and deliberately conservative: the cost of keeping noise is a
 * 1 KB vector and some dilution, while the cost of dropping a real fact is
 * permanent and invisible. So this only rejects text that cannot carry a fact —
 * acknowledgements, filler, and pure punctuation.
 *
 * It exists because the index is where cost accumulates. Measured: the index is
 * 0.68x its source (620 KB per session) while a durable card is 1.9 KB, so the
 * index is the layer that has to be stingy about what it admits. Retrieval
 * quality and disk both improve together here; there is no trade to weigh.
 *
 * @param {string} text
 * @returns {boolean} true when the chunk is not worth indexing
 */
export function isLowInformation(text) {
  const t = String(text ?? '').trim();
  if (t === '') return true;

  // Filler is checked first, and anchored, so it can only ever match a chunk
  // that is *entirely* acknowledgement. Testing the "can carry a fact" rules
  // first let "ok" through, because two letters look like an identifier.
  const stripped = t.replace(/[\s，。、！？~～…,.!?]/g, '');
  if (stripped.length === 0) return true;
  const FILLER = /^(好|好的|好吧|行|可以|嗯|哦|噢|是|是的|对|对的|没错|谢谢|感谢|收到|明白|明白了|知道了|继续|接着|来吧|开始|完成|ok|okay|yes|no|thx|thanks|continue|goon|next)+$/i;
  if (FILLER.test(stripped)) return true;

  // Everything below returns false, so nothing here filters anything: the branches
  // document *why* a chunk survives rather than deciding it. Only empty text and
  // pure filler are dropped, and the cost of a wrong drop (permanent, invisible) is
  // the reason the bar is set that low.
  //
  // Anything with a number, path, identifier, URL or code punctuation can carry
  // a fact — ports, versions, sizes, error codes, file names. Never drop those.
  if (/[0-9]/.test(t)) return false;
  if (/[/\\_.@#:`{}[\]()=<>|~$%^&*+\-]/.test(t)) return false;
  if (/[A-Za-z]{2,}/.test(t)) return false;
  if (t.length > 80) return false;

  // What is left is short, CJK, and carries no digits or symbols. Keep it: the
  // cost of a false drop is permanent and invisible, the cost of a false keep is
  // one vector.
  return false;
}
