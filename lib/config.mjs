/**
 * Plugin configuration: declared, validated, and portable.
 *
 * Cordis validates a plugin's config through `runtime.Config["~standard"]` — the
 * cross-library Standard Schema interface, not a zod-specific shape. That matters
 * here because this plugin has **no dependencies at all**, which is what lets it
 * be installed with `link:` into a profile whose `node_modules` holds no
 * `@deepseek-ai/*` tree and no zod. Importing zod to satisfy the protocol would
 * trade that property away for nothing, since the interface it needs is about
 * twenty lines.
 *
 * Declaring a schema is not ceremony: without it a plugin takes raw `options` and
 * every invalid value fails at the point of use, deep inside a recall, rather
 * than at load with a message naming the field. It is also what makes the knobs
 * discoverable in a composition instead of only in the source.
 *
 * The schema deliberately **allows unknown keys**. A composition written for a
 * newer version, or tinkering that adds a field, should not fail to load — the
 * cost of ignoring an unrecognised key is zero, while the cost of refusing a
 * config is a plugin that will not start.
 *
 * SPDX-License-Identifier: MIT
 */

/** A field spec is a tiny tag, so this file needs no validation library. */
import { INJECTION_MIN_TOTAL_CHARS } from './inject.mjs';

const t = {
  boolean: (fallback) => ({ kind: 'boolean', fallback }),
  number: (fallback, bounds = {}) => ({ kind: 'number', fallback, ...bounds }),
  string: (fallback) => ({ kind: 'string', fallback }),
  // `null` is a meaningful value for the sentinel: "no verbatim abstention
  // token, ask for prose instead".
  stringOrNull: (fallback) => ({ kind: 'stringOrNull', fallback }),
  object: (fields) => ({ kind: 'object', fields }),
};

/** Shape of the whole config. Every field optional; defaults live in each module. */
const FIELDS = {
  /** Automatic recall. `false` disarms it entirely. */
  auto: t.boolean(true),
  /** Recall mode: context | tools | hybrid. */
  mode: t.string('hybrid'),
  /** Embedding endpoint. Any OpenAI-compatible `/v1/embeddings`. */
  embed: t.object({
    url: t.string('http://127.0.0.1:11439'),
    model: t.string('embed-gemma'),
    apiKey: t.stringOrNull(null),
    timeoutMs: t.number(30_000, { min: 500 }),
    // `batchSize` used to live here and was never read by anything: the index
    // build embeds one unit per request, and batching was measured at 1.2× at
    // best (18.5 → 22.9 units/s on 461-character fragments), because the cost is
    // the model's forward pass rather than the round trip. A knob that does
    // nothing is worse than no knob, so it is gone rather than quietly honoured.
  }),
  /** Cross-encoder reranking. Empty `url` disables it, and the gate degrades. */
  rerank: t.object({
    url: t.string(''),
    model: t.string('bge-reranker-v2-m3'),
    /** Some servers expose `/rerank` rather than `/v1/rerank`. */
    path: t.string('/v1/rerank'),
    apiKey: t.stringOrNull(null),
    timeoutMs: t.number(30_000, { min: 500 }),
    minScore: t.number(0),
    maxChars: t.number(300, { min: 0 }),
    candidates: t.number(20, { min: 2, max: 100 }),
  }),
  /**
   * Live index updates: the index used to be refreshed only by a manual build, and
   * a week of real use showed what that costs — nobody runs it, and the transcript
   * layer silently goes stale while every health signal stays green.
   *
   * The trigger follows the ecosystem: session events mark it dirty, a debounced
   * tick does the work, and only sessions whose logs changed are re-read (a
   * no-change rebuild measured 33 s, which is why "just build periodically" is not
   * an option). See lib/live-index.mjs.
   */
  liveIndex: t.object({
    enabled: t.boolean(true),
    /** How often the debounced worker wakes up. */
    debounceMs: t.number(30_000, { min: 5_000 }),
    /** A session must have been quiet this long before it is indexed. */
    quietMs: t.number(90_000, { min: 0 }),
    /** Upper bound on units embedded per pass, so a busy day cannot spike. */
    maxUnitsPerTick: t.number(400, { min: 10, max: 5_000 }),
    /** Wall-clock budget per pass; the rest waits for the next tick. */
    budgetMs: t.number(20_000, { min: 1_000 }),
  }),

  /** Optional synthesis. Off means raw entries are returned instead. */
  synthesis: t.object({
    enabled: t.boolean(false),
    baseUrl: t.string(''),
    model: t.string(''),
    thinking: t.boolean(false),
    // `sentinel` used to be declared here and was never read: the abstention token
    // is a module constant taken from `DSH_G_MEMORY_LLM_SENTINEL`, and threading a
    // composition value through the prompt builder *and* every refusal check (four
    // call sites, one of which has no config in scope) would buy an opt-in escape
    // hatch that the environment already provides. Removed rather than silently
    // half-wired; set `DSH_G_MEMORY_LLM_SENTINEL` to enable it.
    timeoutMs: t.number(60_000, { min: 1_000 }),
    maxOutputChars: t.number(1_200, { min: 100 }),
  }),
  /** The relevance gate: floors, tiers, payload sizing. See lib/policy.mjs. */
  policy: t.object({
    gate: t.number(0),
    recentDays: t.number(0, { min: 0 }),
    midDays: t.number(7, { min: 0 }),
    briefChars: t.number(200, { min: 40 }),
    fullChars: t.number(400, { min: 40 }),
    maxEntries: t.number(3, { min: 1, max: 10 }),
    maxTotalChars: t.number(1_200, { min: INJECTION_MIN_TOTAL_CHARS }),
    // Head-margin floor for the automatic path; 0 disables it. See lib/policy.mjs
    // for the measurement behind the value a deployment would set here.
    marginGate: t.number(0, { min: 0 }),
    // Card eligibility when no reranker is configured: a card has no score on the
    // RRF scale, so its own similarity pre-filter stands in. 0 disables the rule.
    cardMinSimilarity: t.number(0.35, { min: 0, max: 1 }),
    // Head-margin below which a recall is treated as needing assembly, so synthesis
    // runs only where it can add something. 0 never synthesises. See lib/policy.mjs.
    synthesisMargin: t.number(0.2, { min: 0 }),
  }),
  /** Durable cards and the consolidation loop. Off by default. */
  consolidate: t.object({
    enabled: t.boolean(false),
    minIntervalHours: t.number(24, { min: 0 }),
    minTurns: t.number(5, { min: 1 }),
    idleMs: t.number(600_000, { min: 60_000 }),
  }),
  /** Where memory lives. */
  indexDir: t.string(''),
  cardPath: t.string(''),
};

/** Human-readable path, for the message a rejected config produces. */
function label(path) {
  return path.length === 0 ? 'config' : path.join('.');
}

function coerce(value, spec, path, issues) {
  if (value === undefined || value === null) return spec.fallback;
  switch (spec.kind) {
    case 'boolean':
      // Strings are accepted because a composition is often written by hand and
      // `enabled: "true"` is a mistake that should work, not a load failure.
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'on' || value === 1) return true;
      if (value === 'false' || value === 'off' || value === 0) return false;
      issues.push({ message: `${label(path)} must be a boolean, got ${typeof value}`, path });
      return spec.fallback;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        issues.push({ message: `${label(path)} must be a finite number`, path });
        return spec.fallback;
      }
      if (spec.min !== undefined && n < spec.min) {
        issues.push({ message: `${label(path)} must be >= ${spec.min}, got ${n}`, path });
        return spec.fallback;
      }
      if (spec.max !== undefined && n > spec.max) {
        issues.push({ message: `${label(path)} must be <= ${spec.max}, got ${n}`, path });
        return spec.fallback;
      }
      return n;
    }
    case 'string':
      if (typeof value === 'string') return value;
      issues.push({ message: `${label(path)} must be a string`, path });
      return spec.fallback;
    case 'stringOrNull':
      if (typeof value === 'string') return value;
      issues.push({ message: `${label(path)} must be a string`, path });
      return spec.fallback;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ message: `${label(path)} must be an object`, path });
        return { ...value };
      }
      const out = {};
      for (const [key, sub] of Object.entries(spec.fields)) {
        out[key] = coerce(value[key], sub, [...path, key], issues);
      }
      // Unknown keys are carried through rather than rejected: see the note at
      // the top of this file.
      for (const [key, raw] of Object.entries(value)) {
        if (!(key in spec.fields)) out[key] = raw;
      }
      return out;
    }
    default:
      return value;
  }
}

/**
 * Standard Schema implementation.
 *
 * `version: 1` and a synchronous `validate` are the whole contract Cordis uses.
 * Returning `{ issues }` rather than throwing lets the loader raise its own
 * `ValidationError` with the paths intact.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-g-memory',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      const issues = [];
      const out = {};
      for (const [key, spec] of Object.entries(FIELDS)) {
        out[key] = coerce(raw[key], spec, [key], issues);
      }
      for (const [key, v] of Object.entries(raw)) {
        if (!(key in FIELDS)) out[key] = v;
      }
      return issues.length > 0 ? { issues } : { value: out };
    },
  },
};

