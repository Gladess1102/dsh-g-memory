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
import { createForgetTool, createNoteTool, createRecallTool, MAX_QUERY_CHARS } from './tools.mjs';
import { resolvePolicy, needsSynthesis } from './policy.mjs';
import { LiveIndex } from './live-index.mjs';
import { embedBatch, resolveConfig } from './embedder.mjs';
import { selectForInjection, renderRecall, isInjectionEnabled } from './inject.mjs';
import { synthesize, isRefusal } from './synthesize.mjs';
import { AutoRecall, isSameSession, injectionMeta } from './auto-recall.mjs';
import { rerankEntries, rerankAvailable, resolveRerankConfig, DEFAULT_RERANK_CANDIDATES } from './rerank.mjs';
import { readCards, cardEntries, defaultCardPath } from './cards.mjs';
import { createIndexLayer, resolveIndexLayerConfig } from './index-layer.mjs';
import { record } from './telemetry.mjs';




export const name = 'dsh-g-memory';

/**
 * Parse the optional `expires` argument into epoch ms (0 = no expiry).
 *
 * Accepts `YYYY-MM-DD` and anything `Date.parse` understands; an unparseable value
 * means "no expiry" rather than a card that silently never lapses.
 */
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
/**
 * The options the automatic path is constructed with.
 *
 * Built here, in one place, because "declared in the schema but never passed at
 * the wiring point" is this plugin's most repetitive defect. `rerank` and
 * `policy` were dropped once (the automatic path silently fell back to the RRF
 * floor while the telemetry said `reranked: false`), and `consolidate` was
 * dropped the same way — so the durable-card loop could not be switched on from a
 * composition at all and its only remaining switch was an environment variable,
 * which is why cards had stopped appearing while every health signal stayed
 * green. `scripts/test-plugin.mjs` asserts every option AutoRecall reads is
 * present here, so the next dropped key fails a test instead of going quiet.
 *
 * @param {Record<string, any>} options validated plugin config
 * @param {string} indexDir
 */
export function autoRecallOptions(options, indexDir) {
  return {
    indexDir,
    embed: options.embed,
    rerank: options.rerank,
    policy: options.policy,
    // Added 2026-10-13, and only a live rehearsal caught the omission: the schema
    // accepted these, --dump-config printed them, the offline rehearsal passed,
    // and production still ran with both switches off because this projection
    // never passed them on. The guard test below now derives itself from the
    // class instead of repeating this list by hand.
    judge: options.judge,
    resident: options.resident,
    synthesis: options.synthesis,
    // The composition spells this `consolidate`; the class reads `consolidation`.
    // A spread would not have caught the mismatch either, which is why the two
    // names are spelled out next to each other here.
    consolidation: options.consolidate,
    apiKey: options.apiKey,
    auto: options.autoConfig,
  };
}

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
   * @param {{ excludeSession?: string }} [opts] `excludeSession` drops entries that
   *   came from this session: the caller is asking about *earlier* sessions, and a
   *   unit it just produced is already in the window. The automatic path passes the
   *   agent id; the tool call has no session in hand and passes nothing.
   */
  async function retrieve(query, limit, opts = {}) {
    const index = await loadIndex();
    // Resolved once: two separate `resolvePolicy(options.policy)` calls used to sit
    // in this function, and the content limits below are the third consumer.
    const policy = resolvePolicy(options.policy);
    const [vector] = await embedBatch([query], resolveConfig(options.embed), { purpose: 'query' });
    // Recall more than we return: the arms only guarantee the answer is in the
    // candidate pool, not at rank 1. With a reranker configured the pool goes
    // deeper, because a reranker can only reorder what it is handed — measured,
    // a 20-deep pool plus reranking takes top-1 from 4/8 to 7/8 where a 12-deep
    // pool cannot, since the answer is sometimes at fused rank 13.
    // `rerankAvailable` and not a bare `options.rerank.url` check: the reranker is
    // also configurable through the environment, and reading only the composition
    // sized the pool for "no reranker" while `rerankEntries` below did rerank.
    const rerankOn = rerankAvailable(options.rerank);
    const poolSize = rerankOn ? DEFAULT_RERANK_CANDIDATES : Math.max(limit * 4, 12);
    const queryVector = prepareQueryVector(vector);
    const hits = index.recall(queryVector, query, { k: poolSize });
    // Self-recall exclusion, for the same reason as the automatic path (see
    // AutoRecall.#run): a unit from this session is already in the window. Applied
    // before the reranker so such a unit cannot take a candidate slot.
    const excludeSession = String(opts.excludeSession ?? '').trim();
    const fromThisSession = (session) => excludeSession !== '' && isSameSession(session, excludeSession);
    // Durable cards join the pool. They are the layer that survives the
    // transcript being deleted, so they must be reachable by the same query,
    // through the same reranker, under the same gate.
    const cards = await readCards(defaultCardPath()).catch(() => []);
    // Explicit recall asks for everything, including memories that are no longer
    // current — labelled by `state`, so a corrected fact arrives with its
    // correction visible instead of masquerading as the latest word.
    const cardHits = (cards.length > 0 ? cardEntries(cards, queryVector, { includeInactive: true }) : [])
      .filter((entry) => !fromThisSession(entry.session));
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
        // The identity `inject` telemetry reports; a unit has no other stable name.
        hash: unit.hash,
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
    }).filter((entry) => !fromThisSession(entry.session))];
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
      cardMinSimilarity: policy.cardMinSimilarity,
      // The degraded card rule is relative now (top1 must be separated from top2
      // by cardMargin) and the content filter lives in lib/quality.mjs, so both
      // have to be handed over here — the caller owns where the entries came from.
      cardMargin: policy.cardMargin,
      minContentChars: policy.minContentChars,
      maxEntryChars: policy.maxEntryChars,
    });

    // Synthesis is optional: when it is unavailable the raw entries still answer
    // the call, so memory never becomes a hard dependency.
    let synthesis = '';
    if (options.synthesize !== false && needsSynthesis(selected.selected, policy)) {
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


  const noteTool = createNoteTool({ ctx, embed: options.embed });
  const forgetTool = createForgetTool({ ctx, embed: options.embed });
  const tool = createRecallTool({ maxResults, previewChars, retrieve });
  const dispose = tools.register(tool);
  const disposeNote = tools.register(noteTool);
  const disposeForget = tools.register(forgetTool);

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
          // `excludeSession` for the same reason the automatic path excludes it: the
          // command searches *past* sessions, and this session's own units are
          // already in the window. `invocation.agent` is optional in the documented
          // handler contract, so the filter is armed only when there is an id.
          const result = await retrieve(query, maxResults, {
            ...(invocation?.agent?.id ? { excludeSession: String(invocation.agent.id) } : {}),
          });
          const rendered = renderResult(result);
          if (!rendered) return { kind: 'success', text: 'No matching memory found.' };
          // An explicit request arms the same injection automatic recall uses,
          // so the memory reaches the model on its next step rather than only
          // being printed for the person who asked. The automatic switches are
          // deliberately not consulted: this is a direct instruction, not
          // speculation. The master kill switch still applies.
          // `invocation.agent` is optional (see the `excludeSession` filter above),
          // and dereferencing it here turned a successful recall into
          // `{ kind: 'error' }` — the outer catch reported a working search as a
          // failure. Arming is a bonus, not part of the result.
          if (autoRecall !== null && isInjectionEnabled() && invocation?.agent?.id) {
            autoRecall.arm(String(invocation.agent.id), rendered,
              injectionMeta(result.selected, Boolean(result.synthesis)));
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
    disposeForget?.();
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

  // The memory index layer.
  //
  // Everything else in this package reaches the model through a *waterfall*:
  // a recall is judged, retrieved, gated, and injected before some step. That
  // chain is why a session can run for an hour without the model ever learning
  // that memory exists — measured 2026-10-25, 65% of sessions (54 of 83) never
  // injected a single memory. This layer is the one channel that does not
  // depend on any of that: one line per durable memory rides the assembled
  // system prompt, so the model always knows what it remembers and only the
  // *contents* wait for a recall. dsh-auto-memory's author argues the same way
  // (DSH discussion 7790: the index is in every system prompt; the body is
  // fetched on demand).
  //
  // The section is appended, not substituted: `next()` has already produced the
  // deployment's own prompt, and a memory list must never be able to displace
  // it. `interpolate: false` because memory text is user content and a stray
  // `{{...}}` in a summary must stay literal instead of becoming a prompt
  // variable reference (which the renderer rejects with a throw).
  const indexLayerConfig = resolveIndexLayerConfig(options.indexLayer || {});
  if (indexLayerConfig.enabled) {
    const layer = createIndexLayer({ logger: ctx.logger });
    let lastRendered = '';
    const disposeLayer = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      try {
        const rendered = await layer.read(indexLayerConfig);
        if (!rendered.text) return assembled;
        // One telemetry line per *change*, not per step: the waterfall runs on
        // every model step, and a line per step would make the log unreadable.
        if (rendered.text !== lastRendered) {
          lastRendered = rendered.text;
          record('index-layer', { shown: rendered.shown, hidden: rendered.hidden, chars: rendered.chars });
        }
        return {
          ...assembled,
          sections: [
            ...assembled.sections,
            { name: 'memory:index', order: 3050, interpolate: false, text: rendered.text },
          ],
        };
      } catch (error) {
        // Prompt assembly is on the critical path of every request. A memory
        // store that cannot be read must cost a section, never the turn.
        ctx.logger?.debug?.(`[dsh-g-memory] index layer skipped: ${error?.message || error}`);
        return assembled;
      }
    });
    ctx.effect?.(() => disposeLayer);
  }

  // Automatic recall is separate from the explicit tool: it runs on the inbox
  // event and injects at most one bounded context message per user turn.
  // Disabled with DSH_G_MEMORY_AUTO=off, or globally with DSH_G_MEMORY_ENABLED=off.
  if (options.auto !== false) {
    autoRecall = new AutoRecall(ctx, autoRecallOptions(options, indexDir));
    autoRecall.attach();
    ctx.effect?.(() => () => {
      autoRecall?.dispose();
      autoRecall = null;
    });
    ctx.logger?.info?.('[dsh-g-memory] automatic recall attached');
  }

  ctx.logger?.info?.(`[dsh-g-memory] memory_recall registered (index: ${indexDir})`);
}
