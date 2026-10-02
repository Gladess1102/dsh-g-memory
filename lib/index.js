/**
 * dsh-g-memory — Host half.
 *
 * Registers a model-callable `memory_recall` tool that searches the local
 * cross-session memory index. The index itself is built and maintained by the
 * `dsh-g-memory` CLI (see bin/dsh-g-memory.mjs); this plugin only reads it.
 *
 * Design choices worth noting:
 *
 * - Read-only and opt-in. The tool is only useful when the model chooses to
 *   call it, so a missing or stale index can never break a conversation.
 * - Results are bounded. Every recall returns at most `maxResults` entries and
 *   each preview is truncated, so a single call cannot flood the context —
 *   the failure mode reported against other memory plugins.
 * - No transcript copy is stored; only a preview plus a locator, so the caller
 *   can go back to the session log for the full text.
 *
 * SPDX-License-Identifier: MIT
 */

import { readIndex, defaultIndexDir, prepareQueryVector, rrfFloor, reportIndexDamage } from './store.mjs';
import { resolvePolicy, needsSynthesis } from './policy.mjs';
import { LiveIndex } from './live-index.mjs';
import { embedBatch, resolveConfig } from './embedder.mjs';
import { selectForInjection, renderRecall, isInjectionEnabled } from './inject.mjs';
import { synthesize, isRefusal } from './synthesize.mjs';
import { AutoRecall } from './auto-recall.mjs';
import { rerankEntries, resolveRerankConfig, DEFAULT_RERANK_CANDIDATES } from './rerank.mjs';
import { readCards, cardEntries, defaultCardPath, parseCard, writeCards, withVector } from './cards.mjs';

export const name = 'dsh-g-memory';

/**
 * Declared config schema.
 *
 * Cordis validates through `Config["~standard"]` (Standard Schema), so this is
 * hand-written rather than zod — see lib/config.mjs. Exporting it is what turns
 * a mistyped option into a load-time error naming the field, instead of a silent
 * fallback discovered during a recall.
 *
 * Still no default export: `unwrapExports` prefers `default`, so adding one
 * would discard every named export including `inject` and `Config`.
 */
export { Config } from './config.mjs';

/**
 * Declared dependency on the tool registry.
 *
 * This export is what makes the service reachable, and it is not optional. The
 * Loader resolves plugin dependencies at runtime and derives each fiber's epoch
 * from these names: a service not declared here is absent while `apply()` runs,
 * even when its provider mounted earlier. An undeclared dependency therefore
 * fails *silently* — `ctx.get('tools')` is undefined, the plugin returns, and
 * the fiber still reports `active`.
 *
 * Two traps compound it, both reproduced against the real Cordis and Loader:
 *   - `unwrapExports` prefers `default` (`exports.default ?? exports`), so a
 *     `export default { name, apply }` discards every named export, `inject`
 *     included. This module must therefore export NO default.
 *   - without `inject`, load ordering does not help: the service is undefined
 *     whether its provider mounted before this plugin or after it.
 */
export const inject = ['tools'];

/** Hard caps on what a single recall may inject. */
const MAX_RESULTS = 5;
const PREVIEW_CHARS = 400;
const MAX_QUERY_CHARS = 500;

/**
 * @param {any} ctx
 * @param {{ indexDir?: string, maxResults?: number, previewChars?: number, embed?: object }} [options]
 */
export function apply(ctx, options = {}) {
  const maxResults = Math.min(options.maxResults ?? 3, MAX_RESULTS);
  const previewChars = Math.min(options.previewChars ?? PREVIEW_CHARS, PREVIEW_CHARS);
  // Deliberately not `??` like the two lines above: an empty string here is a
  // configuration mistake, and falling back to the default index is friendlier
  // than resolving to the current working directory. Written out so the
  // difference from its neighbours reads as intent, not as an oversight.
  const indexDir = String(options.indexDir ?? '').trim() !== ''
    ? options.indexDir
    : defaultIndexDir();

  /** Lazily loaded and cached; reloaded when `memory_recall` sees a stale mtime. */
  let cached = null;
  let cachedAt = 0;
  const CACHE_TTL_MS = 30_000;

  async function loadIndex() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
    cached = await readIndex(indexDir);
    cachedAt = now;
    // A damaged index still answers, just with less in it. Say so rather than
    // letting the missing units be discovered by their absence.
    reportIndexDamage(ctx.logger);
    return cached;
  }

  // Tool registration path.
  //
  // `ctx.tools.register(definition)` is the SERVICE-level API and the correct one
  // for an installed profile plugin: it is a normal Cordis service, reachable
  // because `inject` above names it, and its disposer is owned by this fiber.
  //
  // `harness.defineTool` is a RESTRICTED BUILTIN supplied to the *dynamic*
  // plugin evaluator; an installed plugin cannot see it.
  //
  // The check below throws rather than returning. Reaching it means `inject` is
  // not being honoured, and a memory plugin that silently contributes nothing is
  // far worse than one that fails loudly: the whole point of this package is
  // that absence is otherwise invisible. A throw marks the fiber failed, which
  // the Loader reports at startup and `plugin_manager list_plugins` shows as a
  // non-active `fiberPhase`.
  const tools = ctx.get('tools');
  if (tools == null || typeof tools.register !== 'function') {
    throw new Error(
      'dsh-g-memory: the `tools` service is unavailable, so memory_recall cannot be registered. '
      + 'This means `inject` was not honoured by the Loader (see lib/index.js).',
    );
  }

  /**
   * Run one recall end to end: retrieve, select, optionally synthesise.
   *
   * Shared by the model-callable tool and the human `/recall` command. Keeping
   * one implementation is what stops the two from drifting apart in what they
   * consider a memory — the framing, the caps and the score threshold all have
   * to mean the same thing however the recall was asked for.
   *
   * @param {string} query already length-capped
   * @param {number} limit
   */
  async function retrieve(query, limit) {
    const index = await loadIndex();
    const [vector] = await embedBatch([query], resolveConfig(options.embed));
    // Recall more than we return: the arms only guarantee the answer is in the
    // candidate pool, not at rank 1. With a reranker configured the pool goes
    // deeper, because a reranker can only reorder what it is handed — measured,
    // a 20-deep pool plus reranking takes top-1 from 4/8 to 7/8 where a 12-deep
    // pool cannot, since the answer is sometimes at fused rank 13.
    const rerankOn = String(options.rerank?.url ?? '').trim() !== '';
    const poolSize = rerankOn ? DEFAULT_RERANK_CANDIDATES : Math.max(limit * 4, 12);
    const queryVector = prepareQueryVector(vector);
    const hits = index.recall(queryVector, query, { k: poolSize });
    // Durable cards join the pool. They are the layer that survives the
    // transcript being deleted, so they must be reachable by the same query,
    // through the same reranker, under the same gate.
    const cards = await readCards(defaultCardPath()).catch(() => []);
    const cardHits = cards.length > 0 ? cardEntries(cards, queryVector) : [];
    const entries = [...cardHits, ...hits.map(({ index: i, score }) => {
      const unit = index.unit(i);
      return {
        role: unit.role,
        // Coerced for the same reason the index loader coerces: one malformed
        // unit must not be able to take down a recall.
        text: String(unit.text ?? ''),
        time: Number.isFinite(unit.time) && unit.time > 0 ? unit.time : 0,
        session: unit.session,
        seq: unit.seq,
        // Travels with the entry so injection can mark it unverifiable.
        orphaned: unit.orphaned === true,
        // NOTE: `toFixed(6)` here is not cosmetic, and "fixing" it to
        // `Number(score)` changes gate behaviour: a single-arm rank-1 match
        // scores exactly 1/61 = 0.0163934426…, so rounding to 0.016393 puts it
        // *below* `rrfFloor()` and the degraded gate admits only documents both
        // arms found. That is stricter than the `score >= rrfFloor()` the
        // comment below describes, and the suite's "an unanswerable query
        // recalls nothing" check depends on it. Left as is deliberately —
        // whether the degraded gate should admit single-arm matches is a policy
        // decision, not a rounding cleanup.
        score: Number(score.toFixed(6)),
      };
    })];
    // Cross-encoder reranking, when configured. It returns a new ORDER and, on
    // success, stamps each entry with the cross-encoder's own score. A failure
    // leaves the fused order and the fused scores intact.
    const { entries: ordered, reranked } = await rerankEntries(query, entries, {
      config: options.rerank,
      onFailure: (error) => ctx.logger?.debug?.(`[dsh-g-memory] rerank unavailable: ${error.message}`),
    });

    // The relevance gate, and the reason it reads two different scales.
    //
    // It has to read a scale that separates an answer from a near-miss, and on
    // this corpus only the cross-encoder's does: measured over 8 answerable and
    // 8 deliberately unanswerable queries, fused RRF scored them 0.0159-0.0315
    // and 0.0145-0.0298 — one overlapping band, because a query hitting a single
    // arm at a low rank lands near the 1/61 floor however irrelevant it is. A
    // gate on that scale can therefore only admit everything or drop half the
    // real answers. The cross-encoder puts the same two sets at a median of 5.64
    // and -4.41, so when it ran, its score is what the gate reads.
    //
    // Without a reranker there is no such scale, so the RRF floor stands in.
    // That is the same threshold auto-recall uses, and it errs toward missing a
    // memory rather than inventing one — the trade this plugin states it wants.
    // Passing no minimum at all is not an option that exists here: the filter is
    // `score >= minScore`, so a default of 0 admits every candidate that any
    // arm ranked at any depth, which is what fed the synthesiser irrelevant
    // chunks and produced a 25% fabrication rate on unanswerable queries.
    // The gate reads the *resolved* config, not the caller's object. A
    // composition that sets only `{ url, model }` leaves `minScore` undefined,
    // and `score >= undefined` is false for every candidate — a gate that
    // silently rejects everything rather than admitting everything.
    const rerankMinScore = resolveRerankConfig(options.rerank).minScore;
    const gated = reranked
      ? ordered.map(({ rerankScore, ...entry }) => ({ ...entry, score: rerankScore }))
      : ordered;
    const selected = selectForInjection(gated, {
      maxEntries: limit,
      maxPreviewChars: previewChars,
      minScore: reranked ? rerankMinScore : rrfFloor(),
      reranked,
      cardMinSimilarity: resolvePolicy(options.policy).cardMinSimilarity,
    });

    // Synthesis is optional: when it is unavailable the raw entries still answer
    // the call, so memory never becomes a hard dependency.
    let synthesis = '';
    if (options.synthesize !== false && needsSynthesis(selected.selected, resolvePolicy(options.policy))) {
      const outcome = await synthesize(
        query,
        selected.selected.map((s) => ({
          role: s.role,
          when: s.time ? new Date(s.time).toISOString() : '',
          text: s.text,
        })),
        { config: options.synthesis, apiKey: options.apiKey },
      ).catch((error) => ({ ok: false, reason: `threw: ${error?.message || error}` }));
      if (!outcome.ok) {
        // A rejected key and an unconfigured endpoint both yield empty
        // synthesis; without this the operator cannot tell them apart.
        ctx.logger?.debug?.(`[dsh-g-memory] synthesis unavailable: ${outcome.reason}`);
      } else if (!isRefusal(outcome.text)) {
        synthesis = outcome.text;
      }
    }
    return { selected: selected.selected, synthesis, dropped: selected.dropped };
  }

  /**
   * Render a retrieval result through the shared framing.
   * @param {{ selected: any[], synthesis: string }} result
   */
  function renderResult(result) {
    const entries = result.synthesis
      ? [{ role: 'synthesis', source: 'synthesis', text: result.synthesis, time: Date.now(), score: 1 }]
      : result.selected;
    return renderRecall(entries);
  }


  /**
   * The write path.
   *
   * Every other way a memory entered this system was a byproduct: a fragment
   * sliced out of a finished transcript, or a card distilled from one. Neither
   * can carry a judgement formed *while the session is still running*, because
   * both run after it ends — consolidation is gated on idle time by design.
   *
   * That gap was found the hard way. A lesson learned mid-session ("the
   * auto-generated cases are semantically invalid, do not use them") reached a
   * following session by no route at all: not the index (built before), not a
   * card (written at handoff, and by then I recorded state rather than
   * judgement), not the handoff file. A later session rebuilt the very thing the
   * lesson warned against. The information did not degrade or get overlooked; it
   * had nowhere to go.
   *
   * The tool exists so that "nowhere to go" stops being true. It costs one
   * embedding call — about 29 ms, no model invocation, because the caller *is*
   * the model.
   */
  const noteTool = {
    name: 'memory_note',
    description:
      'Write one durable memory card for future sessions. Use it the moment you reach a '
      + 'conclusion that a later session would need and could not re-derive: a judgement, '
      + 'an approach you REJECTED and why, a pitfall with its symptom, a decision and its '
      + 'reason. Do NOT use it for facts already visible in the code or the transcript — '
      + 'those are indexed automatically. The value here is judgement, not data. Write it '
      + 'self-contained: assume the reader has not seen this conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The memory, self-contained and under 600 characters. State what was concluded '
            + 'or rejected, and why. Avoid "above", "earlier", "this session".',
        },
        tags: {
          type: 'string',
          description: 'Optional comma-separated stable tags, e.g. "memory, benchmark".',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          stored: { type: 'boolean' },
          reason: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['stored'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stored
          ? `Noted for future sessions. Tags: ${(value.tags ?? []).join(', ') || 'none'}`
          : `Not stored: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const raw = String(args?.text ?? '').trim();
      if (raw.length < 20) return { stored: false, reason: 'too short to be a memory' };
      const tagList = String(args?.tags ?? '')
        .split(/[,，、]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
      // The Tag line is reconstructed so parseCard applies the same normalisation
      // and limits as the distilled path — one card format, two ways in.
      const card = parseCard(
        tagList.length > 0 ? `${raw}\nTag: ${tagList.join(', ')}` : raw,
        { session: `note/${new Date().toISOString().slice(0, 10)}`, time: Date.now() },
      );
      if (card === null) return { stored: false, reason: 'nothing worth storing' };
      const [vector] = await embedBatch([card.summary], resolveConfig(options.embed));
      const storePath = defaultCardPath();
      const result = await writeCards([withVector(card, vector)], storePath);
      // `stored: true` used to be returned without checking anything: the write
      // could refuse the card (a refusal-shaped note), fail on disk, or be lost to
      // a concurrent writer, and the model would still be told the memory was
      // saved — after which it stops carrying the fact. Verify it landed.
      if (result.duplicates > 0 && result.added === 0) {
        return { stored: true, duplicate: true, reason: 'already remembered: the same content is in the store' };
      }
      if (result.added === 0) {
        return { stored: false, reason: 'not stored: the text reads as a non-answer rather than a memory' };
      }
      const persisted = (await readCards(storePath).catch(() => [])).some((c) => c.id === card.id);
      if (!persisted) return { stored: false, reason: 'not stored: the write did not persist' };
      ctx.logger?.debug?.(`[dsh-g-memory] noted ${card.summary.length} chars, tags ${card.tags.join(',')}`);
      return { stored: true, tags: card.tags };
    },
  };

  const tool = {
    name: 'memory_recall',
    description:
      'Search long-term memory of past sessions for context relevant to the current task. ' +
      'Use it when the user refers to something from an earlier conversation, or when a ' +
      'decision, measurement or error from before may change the answer. Returns short ' +
      'previews with a session locator; read the session log for full text.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to recall, phrased as a question or a topic.',
        },
        limit: {
          // `enum` rather than `minimum`/`maximum`: the Harness schema subset is
          // type/oneOf/properties/required/additionalProperties/items/enum/const
          // plus annotations, and an unsupported keyword makes register() throw
          // — which silently costs the whole tool. Enumerating the accepted
          // values constrains the model at least as tightly.
          type: 'integer',
          description: `How many memories to return (1-${maxResults}).`,
          enum: Array.from({ length: maxResults }, (_, i) => i + 1),
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'integer' },
          synthesis: {
            type: 'string',
            description: 'Condensed answer assembled from the matched memories; empty when unavailable.',
          },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                preview: { type: 'string' },
                role: { type: 'string' },
                when: { type: 'string' },
                session: { type: 'string' },
                seq: { type: 'integer' },
                score: { type: 'number' },
                // Provenance has to travel with the entry through the tool boundary
                // too. Without these two the renderer rebuilt every entry as an
                // anonymous excerpt, so a card the user wrote was presented to the
                // model as "verbatim, checkable against its source" — the exact
                // over-claim the labels exist to prevent.
                source: { type: 'string' },
                orphaned: { type: 'boolean' },
              },
              required: ['preview', 'role', 'session'],
              additionalProperties: false,
            },
          },
        },
        required: ['found', 'memories'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = /** @type {any} */ (value);
        if (!v || (v.found === 0 && !v.synthesis)) {
          return [{ type: 'text', text: 'No matching memory found.' }];
        }
        // Rendered through the same framed, escaped path as automatic recall.
        // Recalled text is untrusted whoever asked for it, so the tool result
        // carries the notice too — previously it carried none.
        const entries = v.synthesis
          ? [{ role: 'synthesis', source: 'synthesis', text: v.synthesis, time: Date.now(), score: 1 }]
          : v.memories.map((m) => ({
            role: m.role,
            text: m.preview,
            time: Date.parse(m.when) || 0,
            session: m.session,
            seq: m.seq,
            score: m.score,
            // Carried through so provenanceOf() can label it: a card is a written
            // memory, and a unit whose session is gone is not checkable at all.
            source: m.source,
            orphaned: m.orphaned === true,
          }));
        const rendered = renderRecall(entries);
        return [{ type: 'text', text: rendered || 'No matching memory found.' }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    execute: async (rawArgs) => {
      const args = /** @type {{ query?: string, limit?: number }} */ (rawArgs || {});
      const query = String(args.query || '').slice(0, MAX_QUERY_CHARS).trim();
      if (!query) return { found: 0, memories: [], synthesis: '' };

      const limit = Math.max(1, Math.min(Number(args.limit) || maxResults, maxResults));
      const result = await retrieve(query, limit);

      return {
        found: result.selected.length,
        synthesis: result.synthesis,
        // Explicitly pick the response fields rather than spreading: spreading
        // would carry anything added to an entry upstream into the result the
        // model sees and the durable log keeps.
        memories: result.selected.map((entry) => ({
          preview: String(entry.text ?? '').slice(0, previewChars),
          role: entry.role,
          when: entry.time > 0 ? new Date(entry.time).toISOString() : '',
          session: entry.session,
          // 卡片（memory_note 写下的记忆）没有会话序号，entry.seq 是 null；而宿主
          // 把 `seq` 声明为 integer 且**非必填** —— 带 null 会让整次 memory_recall
          // 被判为非法输出（value.memories[0].seq must be an integer），所以只在
          // 确实是整数时才带上它。
          ...(Number.isInteger(entry.seq) ? { seq: entry.seq } : {}),
          score: entry.score,
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.orphaned === true ? { orphaned: true } : {}),
        })),
      };
    },
  };

  const dispose = tools.register(tool);
  const disposeNote = tools.register(noteTool);

  /** Filled in below; the `/recall` handler reads it when invoked. */
  let autoRecall = null;

  // ------------------------------------------------------------------ /recall
  //
  // A human-typed trigger, so memory can be asked for explicitly instead of
  // waiting for the model to decide or for automatic recall to fire.
  //
  // `commands` is reached optionally rather than through `inject`: a profile
  // without the commands service (the minimal profiles omit it) must still get
  // the tool. Declaring it in `inject` would leave the whole fiber INACTIVE
  // there — the exact silent-nothing failure this package was built to avoid.
  // The Inspect contract documents `ctx.get("commands")` as the optional access
  // path, requiring an undefined check, which is what this is.
  const commands = ctx.get('commands');
  if (commands != null && typeof commands.register === 'function') {
    commands.register({
      name: 'recall',
      description: 'Search long-term memory of past sessions and show what it finds',
      input: { hint: '<what to recall>' },
      handler: async (invocation) => {
        const query = String(invocation?.rawInput ?? '').slice(0, MAX_QUERY_CHARS).trim();
        if (!query) return { kind: 'error', text: 'usage: /recall <what to recall>' };
        try {
          const result = await retrieve(query, maxResults);
          const rendered = renderResult(result);
          if (!rendered) return { kind: 'success', text: 'No matching memory found.' };
          // An explicit request arms the same injection automatic recall uses,
          // so the memory reaches the model on its next step rather than only
          // being printed for the person who asked. The automatic switches are
          // deliberately not consulted: this is a direct instruction, not
          // speculation. The master kill switch still applies.
          if (autoRecall !== null && isInjectionEnabled()) {
            autoRecall.arm(String(invocation.agent.id), rendered);
          }
          return { kind: 'success', text: rendered };
        } catch (error) {
          // A command result is user-facing, so the reason belongs in the text
          // rather than only in a log line the operator may never read.
          return { kind: 'error', text: `recall failed: ${error?.message || error}` };
        }
      },
    });
    ctx.effect?.(() => () => { /* disposer owned by the commands service */ });
  } else {
    ctx.logger?.debug?.('[dsh-g-memory] commands service unavailable; /recall not registered');
  }

  ctx.effect?.(() => () => {
    cached = null;
    dispose?.();
    disposeNote?.();
  });

  // Live index updates. A manual build was the only way the transcript layer ever
  // grew, and a week of real use showed what that means: the index silently went
  // a week stale while every health check stayed green. The trigger follows the
  // ecosystem (session events mark dirty, a debounced pass does the work) and the
  // work is incremental (only logs whose mtime changed, only events past the
  // watermark) because a no-change rebuild measured 33 s. See lib/live-index.mjs.
  if (options.liveIndex?.enabled !== false) {
    const live = new LiveIndex(ctx, {
      indexDir,
      embed: options.embed,
      liveIndex: options.liveIndex,
    });
    ctx.effect?.(() => live.attach());
  }

  // Automatic recall is separate from the explicit tool: it runs on the inbox
  // event and injects at most one bounded context message per user turn.
  // Disabled with DSH_G_MEMORY_AUTO=off, or globally with DSH_G_MEMORY_ENABLED=off.
  if (options.auto !== false) {
    autoRecall = new AutoRecall(ctx, {
      indexDir,
      embed: options.embed,
      // `rerank` and `policy` were dropped here, and AutoRecall reads both. The
      // effect was silent: `this.options.rerank` came out undefined, reranking
      // resolved to the empty default URL, and the automatic path fell back to
      // the RRF floor — the very no-op gate this design exists to replace. The
      // only trace was `reranked: false` in the decision telemetry while the
      // cross-encoder was never called at all.
      rerank: options.rerank,
      policy: options.policy,
      synthesis: options.synthesis,
      apiKey: options.apiKey,
      auto: options.autoConfig,
    });
    autoRecall.attach();
    ctx.effect?.(() => () => {
      autoRecall?.dispose();
      autoRecall = null;
    });
    ctx.logger?.info?.('[dsh-g-memory] automatic recall attached');
  }

  ctx.logger?.info?.(`[dsh-g-memory] memory_recall registered (index: ${indexDir})`);
}
