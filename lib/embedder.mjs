/**
 * Embedding client for a locally served encoder (OpenAI-compatible
 * /v1/embeddings). The deployment serves EmbeddingGemma-300M Q8_0 on 11439; the
 * client is model-agnostic and takes url/model from configuration.
 *
 * The server has a physical batch limit and REJECTS longer input with HTTP 500
 * ("input (N tokens) is too large to process") rather than truncating. The
 * deployment allows 2048 tokens (`-ub 2048`) and a chunk is ~420 tokens, so this
 * should not fire today — but it did while the limit was llama.cpp's default 512,
 * so `embedAdaptive` keeps handling it by bisecting the text and averaging the
 * halves. No input is ever silently lost.
 *
 * SPDX-License-Identifier: MIT
 */

import { sanitizeText } from './chunker.mjs';
import { numberEnv } from './env.mjs';

/** @typedef {{ url: string, model: string, timeoutMs: number, apiKey?: string }} EmbedConfig */

/** @type {EmbedConfig} */
export const DEFAULT_EMBED_CONFIG = {
  // The deployment default, so a fresh clone and the CLI point at a model that
  // actually exists. Overridden by config or by the environment.
  url: process.env.DSH_G_MEMORY_EMBED_URL || 'http://127.0.0.1:11439',
  model: process.env.DSH_G_MEMORY_EMBED_MODEL || 'embed-gemma',
  timeoutMs: numberEnv('DSH_G_MEMORY_EMBED_TIMEOUT_MS', 120_000, { min: 1_000 }),
  apiKey: process.env.DSH_G_MEMORY_EMBED_KEY || undefined,
};

/** Error raised when the embedding endpoint cannot be used at all. */
export class EmbeddingUnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/**
 * @param {Partial<EmbedConfig>} [overrides]
 * @returns {EmbedConfig}
 */
export function resolveConfig(overrides = {}) {
  return { ...DEFAULT_EMBED_CONFIG, ...overrides };
}

/**
 * Last-resort scrub applied at the request boundary.
 *
 * Extraction already sanitises unit text, but a strict JSON parser on the
 * server side rejects any lone UTF-16 surrogate that reaches the wire, and a
 * full build once died at unit 10,000 on exactly that. Rather than depend on
 * every upstream path being clean, the payload is scrubbed here too — a
 * defence that costs one regex pass per batch and removes a whole failure class.
 *
 * This is `sanitizeText` from the chunker rather than a local copy: the two were
 * byte-identical, and a second implementation of a correctness rule is a second
 * place for it to drift.
 */
const scrub = sanitizeText;

/**
 * Embed a batch of texts in one request.
 *
 * @param {string[]} texts
 * @param {Partial<EmbedConfig>} [config]
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, config = {}) {
  const cfg = resolveConfig(config);
  if (texts.length === 0) return [];

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const requestBody = { model: cfg.model, input: texts.map(scrub) };

  let response;
  try {
    response = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (cause) {
    throw new EmbeddingUnavailableError(
      `embedding endpoint unreachable at ${cfg.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`embedding request failed: HTTP ${response.status} ${body.slice(0, 300)}`);
    // 500 from llama-server with this wording means the input exceeded the batch.
    error.name = response.status === 500 && /too large to process/i.test(body)
      ? 'InputTooLargeError'
      : 'EmbeddingRequestError';
    throw error;
  }

  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length !== texts.length) {
    throw new Error(`dsh-g-memory: embedding response size mismatch: asked ${texts.length}, got ${data.length}`);
  }
  // Validate the vectors rather than trusting them into the index. A server that
  // answers with the wrong width, or with NaN/Infinity, produces an index whose
  // rankings are meaningless — and the failure is invisible at build time.
  return data.map((entry, position) => {
    const vector = entry?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error(`dsh-g-memory: embedding response missing vector at position ${position}`);
    }
    if (vector.length === 0) {
      throw new Error(`dsh-g-memory: embedding response returned an empty vector at position ${position}`);
    }
    for (const value of vector) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `embedding response contained a non-finite value at position ${position}; `
          + 'the endpoint is not returning usable vectors',
        );
      }
    }
    return vector;
  });
}

/**
 * Embed one text, bisecting on an over-long rejection and averaging the halves.
 *
 * @param {string} text
 * @param {Partial<EmbedConfig>} [config]
 * @returns {Promise<number[]>}
 */
export async function embedAdaptive(text, config = {}) {
  try {
    const [vector] = await embedBatch([text], config);
    return vector;
  } catch (error) {
    if (error?.name !== 'InputTooLargeError') throw error;
    if (text.length < 128) throw error;

    const half = Math.floor(text.length / 2);
    const [a, b] = await Promise.all([
      embedAdaptive(text.slice(0, half), config),
      embedAdaptive(text.slice(half), config),
    ]);
    return a.map((value, index) => (value + b[index]) / 2);
  }
}

/**
 * Probe the endpoint and report the vector dimension it returns.
 *
 * @param {Partial<EmbedConfig>} [config]
 * @returns {Promise<{ ok: true, dim: number } | { ok: false, error: string }>}
 */
export async function probe(config = {}) {
  try {
    const [vector] = await embedBatch(['dimension probe'], config);
    return { ok: true, dim: vector.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
