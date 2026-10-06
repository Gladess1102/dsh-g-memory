/**
 * Automatic recall.
 *
 * Goal: memory that shows up without being asked for, without ever costing the
 * conversation latency.
 *
 * The trigger is split in two on purpose:
 *
 *   `agent/inbox/inserted`  (once per user message)
 *       Kick off embedding + retrieval + synthesis in the BACKGROUND. The
 *       embedding and synthesis calls are network round-trips; awaiting them
 *       here would be fine, but awaiting them in the step path would not.
 *
 *   `agent/pre-step`        (once per model step, waterfall)
 *       Read whatever is ready and, at most, prepend one context message. This
 *       handler must never await network work — it sits directly on the critical
 *       path, so a slow embedding server would otherwise stall every step.
 *
 * Consequences of that split, both intentional:
 *
 *   - If recall is not ready in time, nothing is injected. Memory is an
 *     enhancement; it must never delay or block a turn.
 *   - Recall runs once per user message, not once per step, so a long tool loop
 *     does not re-query memory on every iteration. (Some production agents
 *     explicitly warn against speculative per-step retrieval for this reason.)
 *
 * Injection is bounded by `lib/inject.mjs`: at most a few short entries, an
 * explicit untrusted-content notice, and a global kill switch.
 *
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from 'node:crypto';
import { readIndex, defaultIndexDir, prepareQueryVector, rrfFloor, reportIndexDamage } from './store.mjs';
import { embedBatch, resolveConfig } from './embedder.mjs';
import { renderRecall, isInjectionEnabled } from './inject.mjs';
import { selectByPolicy, resolvePolicy, autoInjectEnabled, needsSynthesis } from './policy.mjs';
import { rerankEntries } from './rerank.mjs';
import { ConsolidationTracker, consolidateSession, readConsolidationState, writeConsolidationState } from './consolidate.mjs';
import { readCards, cardEntries, defaultCardPath } from './cards.mjs';
import { synthesize, isRefusal } from './synthesize.mjs';
import { SynthesisCache, indexFingerprint } from './cache.mjs';
import { numberEnv, boolEnv } from './env.mjs';
import { record } from './telemetry.mjs';
import { textOf } from './session-source.mjs';

/** Skip recall for very short or obviously conversational messages. */
const MIN_QUERY_CHARS = 8;
/**
 * Hard cap on the query sent to the embedder and to synthesis.
 *
 * The minimum above is a floor, not a cap: without this, one pasted document or
 * CI log turns a single message into an arbitrarily large embedding request and
 * an arbitrarily large synthesis prompt. The explicit tool path has always
 * capped at 500 chars; the automatic path must not be the loose one.
 */
const MAX_QUERY_CHARS = 500;
/** Ignore a recall that took longer than this — the turn has moved on. */
const RESULT_TTL_MS = 120_000;

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
function defaultAutoConfig() {
  return {
    enabled: boolEnv('DSH_G_MEMORY_AUTO'),
    /**
     * Default threshold: the rank-fusion band floor.
     *
     * This was once `0.02`, which sits *above* the floor of 0.01639 and therefore
     * discarded every memory that only one retrieval arm found. Measured on a real
     * index, three of five ordinary queries injected nothing at all — the
     * automatic path was effectively dead, and silently so.
     *
     * The floor is the honest default: it admits any hit and leaves ranking to
     * decide what is shown. Raise it to the *next* band, `2/(rrfK+1)` = 0.03279,
     * to require that both arms agree — a real precision/recall trade rather than
     * an accident of scale.
     */
    minScore: numberEnv('DSH_G_MEMORY_AUTO_MIN_SCORE', rrfFloor()),
    /** Candidate pool depth handed to synthesis. */
    candidates: numberEnv('DSH_G_MEMORY_AUTO_CANDIDATES', 8, { min: 1, max: 64 }),
    };
}

/**
 * Opt-in decision log for measuring how often automatic recall actually fires.
 *
 * Off unless `DSH_G_MEMORY_AUTO_STATS` names a file, and even then the write is
 * fire-and-forget so a failure can never affect a turn. It exists because the
 * rate cannot be recovered from the session logs: `agent/inbox/inserted` fires
 * once per user message merely to arm the background embed, so counting it
 * overstates the rate by roughly 3x, and an injection that is decided against
 * leaves no trace at all. The only place the real decision is visible is here.
 *
 * @param {string} event
 * @param {Record<string, unknown>} [detail]
 */


/**
 * Build the recall context message the loop will admit into the step.
 *
 * `agent/pre-step` returns `UserMessage[]`, and a `Message` requires a stable
 * `id` that the Harness mints through `createUserMessage`. That factory lives in
 * `@deepseek-ai/dsh-llm`, which this plugin deliberately does not depend on, so
 * the shape it produces is reproduced here: a fresh uuid identity, the
 * producer-owned source kind (v4 retired the `kind: 'plugin'` wrapper — DSH
 * 0.1.7's persistence layer refuses it), and a frozen message.
 *
 * `form: 'recall'` is the Harness's own category for retrieved context, so the
 * transcript groups the injection as context rather than as user input — which
 * is what the model should conclude it is.
 * @param {string} rendered framed block from `renderRecall`
 * @returns {any}
 */
function newUserMessage(rendered) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: rendered }],
    source: { kind: 'plugin:dsh-g-memory', form: 'recall' },
  };
  // Deep-freeze to match `freezeMessage`: everything downstream treats an
  // admitted message array as immutable.
  Object.freeze(message.source);
  Object.freeze(message.content[0]);
  Object.freeze(message.content);
  return Object.freeze(message);
}

export class AutoRecall {
  /**
   * @param {any} ctx
   * @param {{ indexDir?: string, embed?: object, synthesis?: object, auto?: Partial<ReturnType<typeof defaultAutoConfig>> }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.auto = { ...defaultAutoConfig(), ...(options.auto || {}) };
    /** Age-tiered gate, two-tier sizing and recall mode; see lib/policy.mjs. */
    this.policy = resolvePolicy(options.policy);
    /**
     * Payloads already injected into a session, by agent.
     *
     * At the measured 100% trigger rate the same memory re-enters the window
     * every turn — 1200 characters of unchanging text competing with the live
     * task, which is the "上下文污染" VCP's docs warn about. A repeated payload
     * buys nothing, so it is suppressed. An explicit `/recall` bypasses this by
     * calling `arm()` directly.
     */
    this.injected = new Map();
    /**
     * Decides when a finished session becomes a durable card. `consolidate:
     * false` removes it entirely; otherwise it runs only when enabled — by the
     * composition's `consolidate.enabled`, or by the module default
     * `DSH_G_MEMORY_CONSOLIDATE=on`. See lib/consolidate.mjs for the gate and why
     * it is compound rather than per-turn.
     */
    this.consolidation = options.consolidate === false ? null : new ConsolidationTracker(options.consolidation);
    this.indexDir = options.indexDir || defaultIndexDir();
    this.cache = new SynthesisCache(options.cache);
    /** @type {Map<string, { status: 'pending'|'ready'|'empty', text?: string, at: number }>} */
    this.pending = new Map();
    this.index = null;
    this.fingerprint = '';
    this.indexLoadedAt = 0;
    this.disposers = [];
  }

  /** Lazily (re)load the index, refreshing on a coarse TTL. */
  async loadIndex() {
    if (this.index && Date.now() - this.indexLoadedAt < 30_000) return this.index;
    this.index = await readIndex(this.indexDir);
    reportIndexDamage(this.ctx.logger);
    this.fingerprint = indexFingerprint(this.index);
    this.indexLoadedAt = Date.now();
    return this.index;
  }

  /**
   * Start background recall for one user message.
   * @param {string} agentId
   * @param {string} query
   */
  start(agentId, rawQuery) {
    const trimmed = String(rawQuery ?? '').trim();
    if (trimmed.length < MIN_QUERY_CHARS) return;
    // Cap, don't reject: a long message is still a legitimate query, it just
    // must not become an unbounded embedding request or synthesis prompt.
    const text = trimmed.slice(0, MAX_QUERY_CHARS);

    this.pending.set(agentId, { status: 'pending', at: Date.now() });

    // Fire and forget: the caller (an emit listener) must not await this.
    void this.#run(agentId, text).catch((error) => {
      this.pending.set(agentId, { status: 'empty', at: Date.now() });
      const message = String(error?.message || error);
      // Record it. This catch used to leave nothing but a debug line, and a
      // debug line is not a signal: with the embedding engine down, every turn
      // produced `armed` and then silence — no injection, no event, no warning —
      // so the memory system looked healthy while retrieving nothing. Telemetry
      // is the channel that actually gets read, so the failure goes there
      // (trimmed, so the file stays bounded).
      record('error', { where: 'run', message: message.slice(0, 200) });
      this.ctx.logger?.debug?.(`[dsh-g-memory] auto recall failed: ${message}`);
    });
  }

  /**
   * @param {string} agentId
   * @param {string} query
   */
  async #run(agentId, query) {
    const index = await this.loadIndex();
    if (index.size === 0) {
      this.pending.set(agentId, { status: 'empty', at: Date.now() });
      return;
    }

    const cached = this.cache.get(query, this.fingerprint);
    if (cached) {
      this.pending.set(agentId, { status: 'ready', text: cached, at: Date.now() });
      return;
    }

    const [vector] = await embedBatch([query], resolveConfig(this.options.embed));
    const queryVector = prepareQueryVector(vector);
    const hits = index.recall(queryVector, query, { k: this.auto.candidates });
    // Durable cards ride the same path: same pool, same reranker, same gate.
    const cards = await readCards(defaultCardPath()).catch(() => []);
    const cardHits = cards.length > 0 ? cardEntries(cards, queryVector) : [];
    if (hits.length === 0) {
      this.pending.set(agentId, { status: 'empty', at: Date.now() });
      return;
    }

    const entries = [...cardHits, ...hits.map(({ index: i, score }) => {
      const unit = index.unit(i);
      return {
        text: unit.text,
        role: unit.role,
        time: unit.time,
        session: unit.session,
        seq: unit.seq,
        // Travels with the entry so injection can mark it unverifiable.
        orphaned: unit.orphaned === true,
        score,
      };
    })];

    // Cross-encoder reranking, then the age-tiered policy gate.
    //
    // The automatic path used to read the fused RRF score against `rrfFloor()`,
    // which measured out as a no-op: the two bands overlap almost entirely, so
    // every turn injected. Reranking is what gives this path a scale that can
    // actually say no — the same scale the tool path has used since §2.23 of the
    // security review. Both paths now share `policy.mjs` so they cannot drift.
    const { entries: ordered, reranked } = await rerankEntries(query, entries, {
      config: this.options.rerank,
      onFailure: (error) => this.ctx.logger?.debug?.(`[dsh-g-memory] auto rerank unavailable: ${error.message}`),
    });
    //
    // Without a reranker there is no discriminating scale, so the fused RRF score
    // stands in behind `rrfFloor()`. Sending `-Infinity` instead — the first
    // version of this — silently emptied the automatic path for every deployment
    // that had not configured a reranker, which is the default. A missing
    // reranker must degrade the gate, never disable it.
    const scored = reranked
      ? ordered.map(({ rerankScore, ...e }) => ({ ...e, score: rerankScore }))
      : ordered;
    const gate = reranked
      ? this.options.policy
      : { ...resolvePolicy(this.options.policy), gate: rrfFloor(), midGate: rrfFloor(), recentGate: rrfFloor(),
          // The margin reads the *separation* between the top candidates, which
          // only means something on the cross-encoder's unbounded scale. On the
          // fused RRF scale every score sits within 1/61 of the next, so applying
          // it here would reject every turn — the same all-or-nothing failure the
          // floors above are pinned to avoid.
          marginGate: 0 };

    const selected = selectByPolicy(scored, { policy: gate, limit: this.auto.maxEntries, reranked });
    record('gate', { verdict: selected.selected.length > 0 ? 'pass' : 'drop', tier: selected.tier,
      reranked, kept: selected.selected.length, dropped: selected.dropped });
    if (selected.selected.length === 0) {
      // Keep the reason: "nothing cleared the threshold" and "there was no
      // memory" look identical from the outside otherwise, and that ambiguity is
      // what let a mis-scaled threshold go unnoticed.
      this.pending.set(agentId, { status: 'empty', reason: selected.reason, at: Date.now() });
      return;
    }

    let body = '';
    // Only when the entries must be assembled: a clear leader among them already
    // answers the question, and paraphrasing it would replace verbatim text — which
    // is checkable — with prose that is not. Measured: that is 92.8% of recalls.
    if (this.options.synthesize !== false && needsSynthesis(selected.selected, gate)) {
      const outcome = await synthesize(
        query,
        selected.selected.map((s) => ({ role: s.role, when: Number.isFinite(s.time) ? new Date(s.time).toISOString() : '', text: s.text })),
        { config: this.options.synthesis, apiKey: this.options.apiKey },
      ).catch(() => ({ ok: false, reason: 'threw' }));
      if (!outcome.ok) {
        // Surface why. A wrong key and an unconfigured endpoint both produce
        // empty synthesis, and an operator cannot tell them apart from silence.
        this.ctx.logger?.debug?.(`[dsh-g-memory] synthesis unavailable: ${outcome.reason}`);
      } else if (!isRefusal(outcome.text)) {
        body = outcome.text;
      }
    }

    // One renderer for both paths: the answer from synthesis, or the framed
    // fallback. Framing is not optional, so it is not left to the caller.
    const payload = renderRecall(
      body ? [{ role: 'synthesis', source: 'synthesis', text: body, time: Date.now(), score: 1 }] : selected.selected,
    );
    if (!payload) {
      this.pending.set(agentId, { status: 'empty', reason: 'nothing survived framing', at: Date.now() });
      return;
    }
    this.cache.set(query, this.fingerprint, payload);
    this.pending.set(agentId, { status: 'ready', text: payload, at: Date.now() });
  }

  /**
   * Arm a precomputed recall for this agent's next step.
   *
   * Used by the human `/recall` command: the memory was already retrieved and
   * shown to whoever asked, and this makes the same block available to the
   * model. It deliberately does not consult `DSH_G_MEMORY_AUTO`, because an
   * explicit request is not speculation — but it is still consumed exactly once,
   * by the same `take()` the automatic path uses, so a manual recall cannot
   * persist across turns any more than an automatic one can.
   *
   * @param {string} agentId
   * @param {string} text already-framed block from `renderRecall`
   */
  arm(agentId, text) {
    if (!this.auto.enabled) return;
    this.pending.set(agentId, { status: 'ready', text, at: Date.now() });
  }

  /**
   * Consume a ready recall exactly once. Returns the text to inject, or ''.
   * @param {string} agentId
   * @returns {string}
   */
  take(agentId) {
    const entry = this.pending.get(agentId);
    if (!entry) return '';
    if (entry.status !== 'ready') return '';
    if (Date.now() - entry.at > RESULT_TTL_MS) {
      this.pending.delete(agentId);
      return '';
    }
    // Consume: a single recall should colour one turn, not every later step.
    this.pending.delete(agentId);
    const text = entry.text || '';
    if (text) {
      const seen = this.injected.get(agentId) ?? new Set();
      const signature = text.slice(0, 400);
      if (seen.has(signature)) {
        record('repeat-suppressed', { chars: text.length });
        return '';
      }
      seen.add(signature);
      // Bounded: a long session must not accumulate every payload it ever saw.
      if (seen.size > 40) seen.delete(seen.values().next().value);
      this.injected.set(agentId, seen);
    }
    return text;
  }


  /**
   * Read one session's transcript from disk.
   *
   * The agent id is the session directory name in a DSH home, which is what the
   * index build already relies on. Read here rather than cached: a session that
   * has gone idle is no longer in this process, and keeping transcripts around
   * to summarise them later is how a memory plugin becomes a memory leak.
   *
   * The log is located through `listSessionLogs`, the same discovery the index
   * uses, rather than by matching file names here. This function used to accept
   * exactly `session.jsonl.zstd` and `session.v3.jsonl.zstd`, and DSH 0.1.7 began
   * writing `session.v4.jsonl.zstd` — so on a current machine **it read nothing at
   * all**, every distillation was skipped as "too short", and the durable-card
   * layer produced no cards for a week without a single warning. The index build
   * had already been taught the version rule; this path had its own copy of the
   * rule, which is how the two drifted apart.
   *
   * Returns the locator alongside the text, because "no log" and "an empty log"
   * are different problems and the caller has to report them differently: the
   * first is retried, the second is a session that simply has no material.
   *
   * @param {string} agentId
   * @returns {Promise<{ text: string, log: string|null }>}
   */
  async transcriptFor(agentId) {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { decompressZstdFile, extractUnits } = await import('./session-source.mjs');
    const { listSessionLogs } = await import('./live-index.mjs');
    const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh');
    const wanted = String(agentId);
    const found = (await listSessionLogs(join(home, 'sessions')))
      .find((file) => file.includes(wanted)) ?? null;
    if (found === null) return { text: '', log: null, coveredFrom: null, coveredTo: null };
    const jsonl = found.endsWith('.zstd')
      ? await decompressZstdFile(found)
      : await readFile(found, 'utf8');
    // Both halves of the tool traffic are excluded, and the authoring half is the
    // one that has to be excluded deliberately: the index now reads `write`/`edit`
    // arguments, so "the units the extractor produces" is no longer the same thing
    // as "the conversation". The transcript is capped at 12,000 characters, and a
    // single session can write 200 KB of code — including it would push out exactly
    // what a card is for (what was decided, what was rejected, what is still open).
    // The tool call's *path* is the useful part and it is not in here; the card
    // prompt asks for prose, so prose is what it gets.
    const { units } = extractUnits(jsonl, { includeToolResults: false, includeToolCalls: false });
    // The window's time range travels with the card, so a reader can tell how fresh
    // the summary is instead of assuming it describes "now".
    const times = units.map((u) => Number(u.time)).filter((t) => Number.isFinite(t) && t > 0);
    return {
      text: units.map((u) => u.text).join('\n\n'),
      log: found,
      coveredFrom: times.length > 0 ? Math.min(...times) : null,
      coveredTo: times.length > 0 ? Math.max(...times) : null,
    };
  }

  /**
   * Distil the named sessions into durable cards, off the critical path.
   *
   * The transcript is read from disk here rather than kept in memory: a session
   * that has gone idle is by definition no longer in this process, and holding
   * transcripts in memory to summarise them later is how a memory plugin becomes
   * a memory leak.
   *
   * @param {string[]} _agentIds agent ids, used as session locators
   */
  async distill(_agentIds) {
    const { defaultCardPath } = await import('./cards.mjs');
    const path = defaultCardPath();
    // The whole synthesis config travels: baseUrl and model decide *what* answers,
    // while apiKeyName/headers/thinking/timeout decide whether an answer arrives at all.
    const endpoint = { ...(this.options.synthesis || {}) };
    /** @type {string[]} */
    const failed = [];
    for (const agentId of _agentIds) {
      try {
        const { text: transcript, log, coveredFrom, coveredTo } = await this.transcriptFor(agentId);
        if (log === null) {
          // Not "nothing to remember": no log was read at all, so the material may
          // well be there. Treated as a failure rather than a skip, which keeps the
          // turns and retries — bounded by `maxAttempts`, so a stale agent id
          // cannot cycle forever. It used to fall into the "too short" branch and
          // be discarded silently, which is what hid the v4 defect.
          failed.push(String(agentId));
          record('consolidate-error', {
            session: String(agentId).slice(0, 16),
            message: `no session log found for this agent id`,
          });
          continue;
        }
        if (transcript.length < 200) {
          // A real session with real material to answer for; recorded so that a
          // "why was this never remembered?" question has an answer on disk.
          record('consolidate-result', {
            session: String(agentId).slice(0, 16),
            stored: false,
            reason: `transcript too short (${transcript.length} chars)`,
          });
          continue;
        }
        const result = await consolidateSession(
          { session: agentId, text: transcript, coveredFrom, coveredTo, embed: async (t) => (await embedBatch([t], resolveConfig()))[0] },
          endpoint,
          { path },
        );
        record('consolidate-result', { session: String(agentId).slice(0, 16), ...result.stored ? { stored: true, chars: result.card.summary.length } : { stored: false, reason: result.reason } });
        // A distillation that reported failure by *value* — the model was down, the
        // HTTP call failed, nothing usable came back — used to be settled as though
        // it had succeeded, which cleared the session's material and lost it. Only an
        // outcome that cannot improve is allowed to end the attempt count.
        if (result.stored === false && result.retryable !== false) {
          failed.push(String(agentId));
          this.ctx.logger?.debug?.(`[dsh-g-memory] distillation failed for ${agentId}: ${result.reason} — will retry`);
        }
      } catch (error) {
        // One session's failure must not take the batch with it: the other sessions
        // hold material too, and previously a single throw (an embedding endpoint
        // that is down is enough — it happened twice in one day here) aborted the
        // loop with the turns already cleared, so that material was simply gone.
        failed.push(String(agentId));
        const message = String(error?.message || error).slice(0, 200);
        record('consolidate-error', { session: String(agentId).slice(0, 16), message });
        this.ctx.logger?.debug?.(`[dsh-g-memory] consolidation failed for ${agentId}: ${message}`);
      }
    }
    return failed;
  }

  /** Register listeners; every one is fibre-owned and dispose-safe. */
  attach() {
    const onInsert = (payload) => {
      if (!isInjectionEnabled() || !this.auto.enabled) return record('skip', { why: 'disabled' });
      if (!autoInjectEnabled(this.policy, true)) return record('skip', { why: `mode-${this.policy.mode}` });
      const agent = payload && payload.agent;
      const message = payload && payload.message;
      if (!agent || !message) return record('skip', { why: 'malformed' });
      // Only genuine user turns; plugin-injected context is not a query.
      const source = message.source;
      if (source && source.kind && source.kind !== 'user') return record('skip', { why: 'not-user' });
      record('armed');
      this.consolidation?.note(agent.id);
      this.start(String(agent.id), textOf(message.content));
    };

    const onPreStep = (payload, next) => {
      // Never await here: this runs on the critical path of every step.
      try {
        if (isInjectionEnabled() && this.auto.enabled && payload && payload.agent) {
          const text = this.take(String(payload.agent.id));
          if (text) {
            record('inject', { chars: text.length });
            const context = newUserMessage(text);
            return next().then((decision) => {
              if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
              return { ...decision, messages: [context, ...decision.messages] };
            });
          }
        }
      } catch (error) {
        this.ctx.logger?.debug?.(`[dsh-g-memory] injection skipped: ${error?.message || error}`);
      }
      record('pass');
      return next();
    };

    this.disposers.push(this.ctx.on('agent/inbox/inserted', onInsert));

    // The self-cycling part. DSH emits no session-end event, so "finished" is
    // inferred from idle time; the interval and material gates are evaluated here
    // rather than per turn, because consolidation costs a model call.
    if (this.consolidation) {
      // A switched-off loop is recorded once, on purpose. `shouldRun()` returns
      // `{run: false, why:'disabled'}` and the tick then returns before writing
      // anything, so a deployment where cards were switched off looked exactly
      // like one where nothing had finished a session yet — the durable-card layer
      // was dead for a week and every signal stayed green. One line per process
      // makes the difference visible without turning the tick into a log spammer.
      if (!this.consolidation.config.enabled) {
        record('consolidate-skip', { why: 'disabled' });
      }
      // Restore when the loop last ran. This used to be read from an environment
      // variable nothing wrote, and the fix for that is only complete if the value
      // is read back — an import that is never called is the same bug wearing a
      // different hat, which is exactly how this line came to be written twice.
      // The tick cannot fire for at least 30s, so this read always lands first.
      void readConsolidationState()
        .then((state) => {
          if (state.lastRunAt > this.consolidation.lastRunAt) this.consolidation.lastRunAt = state.lastRunAt;
        })
        .catch(() => { /* no state yet: the interval gate starts open, as before */ });

      const tick = async () => {
        try {
          const verdict = this.consolidation.shouldRun();
          if (!verdict.run) return;
          const ids = this.consolidation.pick();
          if (ids.length === 0) return;
          record('consolidate', { sessions: ids.length, why: verdict.why });
          let failed;
          try {
            failed = await this.distill(ids);
          } catch (error) {
            // `distill` isolates per session, so reaching here means the batch
            // itself failed: every session in it keeps its material for a retry.
            failed = ids;
            record('consolidate-error', { message: String(error?.message || error).slice(0, 200) });
          }
          this.consolidation.settle(ids, failed);
          // Marked only after the batch has been dealt with. It used to be marked
          // before distillation started, so a run that never reached the model still
          // silenced the gate for the next 24 hours.
          this.consolidation.markRun();
          await writeConsolidationState(this.consolidation.lastRunAt).catch(() => {});
        } catch (error) {
          this.consolidation?.releaseAll?.();
          this.ctx.logger?.debug?.(`[dsh-g-memory] consolidation tick failed: ${error?.message || error}`);
        }
      };
      const timer = setInterval(() => { void tick(); }, this.consolidation.config.tickMs);
      timer.unref?.();
      this.disposers.push(() => clearInterval(timer));
    }
    this.disposers.push(this.ctx.on('agent/pre-step', onPreStep));
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose?.(); } catch { /* already gone */ }
    }
    this.pending.clear();
    this.cache.clear();
  }

}
