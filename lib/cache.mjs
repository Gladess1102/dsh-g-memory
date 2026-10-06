/**
 * Synthesis cache.
 *
 * Purpose: make repeated questions free. Without it, asking the same thing twice
 * pays the synthesis cost twice; with it, the second call costs zero tokens.
 *
 * Keys combine the normalised query with a fingerprint of the index. The index
 * fingerprint is essential: a cached answer derived from a stale index would
 * silently contradict current memory, which is worse than a cache miss.
 *
 * Bounded by entry count and TTL so a long-lived process cannot grow without
 * limit.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto';
import { numberEnv } from './env.mjs';

/**
 * Defaults, read at call time.
 *
 * This used to be a module-level constant, which froze whatever the environment
 * held at import. `DSH_G_MEMORY_*` is how the CLI, the eval scripts and the
 * tests configure the package, so a later `process.env` change — a test
 * stubbing an endpoint, a shell that exports a different URL — silently did
 * nothing. That is the same shape that shipped a dead embedding endpoint in
 * 0.9.1; the embedder was fixed then, the rest of the config surface was not.
 *
 * @returns the defaults for this call, environment included.
 */
export function defaultCacheConfig() {
  return {
    maxEntries: numberEnv('DSH_G_MEMORY_CACHE_ENTRIES', 256, { min: 1 }),
    ttlMs: numberEnv('DSH_G_MEMORY_CACHE_TTL_MS', 24 * 60 * 60 * 1000, { min: 1_000 }),
    };
}

/**
 * Normalise a query so trivial phrasing differences share a cache entry.
 * Lowercases, collapses whitespace, and strips trailing punctuation.
 *
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。！？!?.,;；，、]+$/u, '')
    .trim();
}

/**
 * Stable fingerprint of the index contents.
 *
 * Uses unit count plus the first and last content hashes: cheap to compute and
 * changes whenever units are added or removed at either end, which is exactly
 * what an append-only index does.
 *
 * The embedding model and dimension are part of it too. Content hashes do not
 * change when the model does, so without them the same corpus re-embedded by a
 * different model produced an identical fingerprint — and a cached answer
 * synthesised from the old model's retrieval was served for the new one's.
 *
 * @param {{ size: number, data?: { model?: string, dim?: number }, unit: (i: number) => { hash: string } }} index
 * @returns {string}
 */
export function indexFingerprint(index) {
  const identity = `${index.data?.model ?? '?'}/${index.data?.dim ?? '?'}`;
  if (index.size === 0) return `empty:${identity}`;
  const first = index.unit(0).hash;
  const last = index.unit(index.size - 1).hash;
  return createHash('sha256').update(`${identity}:${index.size}:${first}:${last}`).digest('hex').slice(0, 16);
}

/**
 * LRU + TTL cache for synthesis results.
 */
export class SynthesisCache {
  /** @param {{ maxEntries?: number, ttlMs?: number }} [options] */
  constructor(options = {}) {
    const config = { ...defaultCacheConfig(), ...options };
    this.maxEntries = config.maxEntries;
    this.ttlMs = config.ttlMs;
    /** @type {Map<string, { value: string, at: number }>} */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** @param {string} query @param {string} fingerprint */
  key(query, fingerprint) {
    return `${fingerprint}\u0000${normalizeQuery(query)}`;
  }

  /**
   * @param {string} query
   * @param {string} fingerprint
   * @returns {string | undefined}
   */
  get(query, fingerprint) {
    const key = this.key(query, fingerprint);
    const hit = this.entries.get(key);
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh recency for LRU ordering.
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  /**
   * @param {string} query
   * @param {string} fingerprint
   * @param {string} value
   */
  set(query, fingerprint, value) {
    if (!value) return;
    const key = this.key(query, fingerprint);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }

  clear() {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
