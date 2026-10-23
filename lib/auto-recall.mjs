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
 * "Not ready in time" turned out to have a second half, and it is the reason
 * `carried` exists. The pipeline measures 2.2-11 s (the reranker and the deep pool
 * dominate; the embedding itself is ~10 ms), while `take()` is synchronous and a
 * single-step turn has exactly one `pre-step` to consume from. So a turn whose
 * recall finished *after* its last step had the result thrown away by the next
 * message — recorded as `late-drop`, and gone. A tool loop hid this because its
 * later steps eventually consumed the result; a plain question-and-answer turn has
 * no later step. Now a finished-but-unconsumed result is carried to the next turn
 * instead of dropped, which costs one turn of staleness and no latency at all.
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
import { parseExactQuery, searchExact } from './exact.mjs';
import { buildTimeline, selectMonths } from './timeline.mjs';
import { synthesize, isRefusal } from './synthesize.mjs';
import { SynthesisCache, indexFingerprint } from './cache.mjs';
import { numberEnv, boolEnv } from './env.mjs';
import { record, setTelemetrySession } from './telemetry.mjs';
import { judgeTurn, resolveJudgeConfig } from './judge.mjs';
import { selectResidentCards, residentEntries, resolveResidentConfig } from './resident.mjs';
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
/** Whether the judge-missed path injects its one-line hint. See renderHint(). */
const hintEnabled = boolEnv('DSH_G_MEMORY_HINT', true);

/**
 * The hint injected when the turn wants memory but retrieval found nothing usable.
 *
 * This is the answer to the measurement in the attribution report: on this
 * corpus neither retrieval score can decide whether a turn has memory —
 * rerank top1 sits at 0.02 for narrative memories and cosine cannot separate
 * the classes at all — and 0 of 80 real turns cleared the gate. Asking the
 * scores to decide produced silence. Asking the *model* costs a line of text.
 *
 * So the automatic path gets three outcomes instead of two:
 *
 *   gate passes          inject the memory (unchanged)
 *   judge fired, no hit  inject this hint and let the model call memory_recall
 *   judge skipped        inject nothing (unchanged)
 *
 * The hint is deliberately not a summary, not a guess and not a memory: it
 * says what exists, what the tool is, and leaves the decision where the
 * evidence says it belongs. `DSH_G_MEMORY_HINT=off` disables it.
 *
 * @param {'none'|'recall_user'|'recall_project'|'explicit'} kind
 * @param {{ fallback?: boolean }} [options] `fallback` says the decision layer
 *   failed rather than declined, which changes the first sentence and nothing else
 * @returns {string}
 */
function renderHint(kind, { fallback = false } = {}) {
  const about = kind === 'explicit'
    ? '你提到的内容'
    : kind === 'recall_user' ? '你的偏好或习惯' : '这一轮正在做的事';
  // A fallback is not the retrieval deciding against this turn: the decision layer
  // was asked and did not answer, so the ordinary wording ("自动检索没能确认哪一条
  // 可用") would describe work that never ran. The hint still points at the tool,
  // because the turn may genuinely want memory — what changed is only that nothing
  // can vouch for whether it does.
  const lead = fallback
    ? '[dsh-g-memory] 这一轮的记忆判定没有结果（判定后端不可用），自动召回没有运行。'
    : '[dsh-g-memory] 长期记忆里可能有与' + about + '相关的记录，但自动检索没能确认哪一条可用。';
  return lead
    + '如果确实需要过往上下文，调用 memory_recall 工具，query 写成一句话问句（例如"上次我们怎么处理 X 的"）。'
    + '不需要就忽略这条。';
}

/**
 * How much of a session locator two ids must share to be the same session.
 *
 * See {@link isSameSession}; the two forms of a session id agree character for
 * character, so this is a floor on what "the same session" can mean, not a fuzzy
 * match.
 */
const SESSION_PREFIX_CHARS = 16;

/** A session id with the namespace prefix the layers disagree about removed. */
function bareSessionId(id) {
  return id.replace(/^(?:session|agent)-/i, '');
}

/**
 * Two locators that name one session, allowing for how each layer writes it.
 *
 * An id is exact, equal in the first 16 characters, or one is a prefix of the other.
 * The last case is deliberate rather than sloppy: an agent id may be a truncated
 * form of the session directory name, and the *only* truncation the harness applies
 * is at the front. Containment elsewhere is not a match, so `abc-session` does not
 * name `session-abc`.
 */
function sameLocator(left, right) {
  if (left === right) return true;
  if (left.slice(0, SESSION_PREFIX_CHARS) === right.slice(0, SESSION_PREFIX_CHARS)) return true;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Whether two session locators name the same session.
 *
 * The automatic path knows a session as the harness agent id, while a stored unit
 * carries the session *directory* name the index read — one is sometimes
 * `session-<uuid>` and sometimes the bare `<uuid>` (see lib/session-source.mjs,
 * which records the three shapes as a known hazard), and telemetry has always
 * kept only the first 16 characters. Comparing the raw forms covers the equal
 * case; comparing the bare forms covers the prefixed one. Both are needed: a
 * filter that silently matches nothing would look like "self-recall is already
 * gone", which is the failure mode this plugin keeps fixing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameSession(a, b) {
  const left = String(a ?? '').trim();
  const right = String(b ?? '').trim();
  if (!left || !right) return false;
  return sameLocator(left, right) || sameLocator(bareSessionId(left), bareSessionId(right));
}

/** Provenance class of an injected entry, for counting rather than for labelling. */
function kindOf(entry) {
  if (entry?.source === 'synthesis') return 'synthesis';
  if (entry?.source === 'card') return 'card';
  if (entry?.role === 'action') return 'action';
  return 'excerpt';
}

/**
 * Describe what was actually injected, for the decision log.
 *
 * The 2026-10-24 review counted 425 injected blocks and could not answer "which
 * memory was this?" from the log: `inject` recorded a character count and a
 * session, so every entry had to be recovered by re-parsing session logs. `ids`
 * fixes that with the identity the rest of the log already uses — a card id or a
 * unit content hash, first 8 characters as `resident` does — and the other fields
 * make a block countable without storing its text ("kept" entries, the provenance
 * classes present, whether a model wrote the body).
 *
 * Exported because the explicit `/recall` path injects through the same event and
 * should be attributable in the same way — it hands the description to `arm()`.
 *
 * @param {any[]} entries the entries the block was built from
 * @param {boolean} synthesis whether the injected body was model-written prose
 */
export function injectionMeta(entries, synthesis) {
  const list = Array.isArray(entries) ? entries : [];
  const ids = [...new Set(list
    .map((entry) => String(entry?.cardId ?? entry?.hash ?? '').trim().slice(0, 8))
    .filter(Boolean))];
  const kinds = [...new Set(list.map(kindOf))];
  const scores = list.map((entry) => Number(entry?.score)).filter((score) => Number.isFinite(score));
  return {
    ids,
    kept: list.length,
    kinds: synthesis ? [...new Set(['synthesis', ...kinds])] : kinds,
    synthesis,
    ...(scores.length > 0 ? { top1: Number(Math.max(...scores).toFixed(3)) } : {}),
  };
}

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
     * Candidate pool depth handed to retrieval.
     *
     * `minScore` was declared here and read by nothing. The automatic path has
     * gone through `selectByPolicy` — and therefore `policy.gate` — since the two
     * paths were merged onto one gate, so the fused-score floor this field
     * described never applied to anything; the README documented it anyway. A
     * knob with no consumer is worse than no knob, which is the same reason
     * `embed.batchSize` was removed rather than quietly honoured.
     */
    candidates: numberEnv('DSH_G_MEMORY_AUTO_CANDIDATES', 8, { min: 1, max: 64 }),
    /**
     * Exact arm (VCP 2.0's second stack): quoted phrases, dates, tags and file
     * paths parsed out of the query and matched literally against the stored
     * text. searchExact returns [] when nothing literal was named, so ordinary
     * conversation is unaffected - the arm only votes when the user names
     * something a vector similarity would gloss over (a filename, a PR number,
     * "that thing from 2026-10").
     */
    exact: boolEnv('DSH_G_MEMORY_EXACT', true),
    /**
     * Timeline nudge (VCP 2.0's VCPTimeLine). After fusion, a unit whose month
     * matches the query's month digest is multiplied by 1 + this value. Zero
     * disables it. Deliberately a nudge and not a filter: a wrong month guess
     * must never be able to hide a correct unit.
     */
    timelineBoost: numberEnv('DSH_G_MEMORY_TIMELINE_BOOST', 0.15, { min: 0, max: 1 }),
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
    /**
     * Results that finished too late to be consumed, parked for the next turn.
     *
     * Separate from `pending` on purpose: `#run` assigns `pending` at nine
     * different points, and threading a carry-over through all of them is how the
     * next rewrite loses it. Here only `start`/`arm` (a turn begins) and `take`
     * (a step consumes) touch it, which is the whole lifecycle.
     *
     * @type {Map<string, { text: string, at: number }>}
     */
    this.carried = new Map();
    /**
     * Why the last `take()` returned nothing.
     *
     * A `pass` event used to carry no information at all: "nothing was ready"
     * and "an injection was decided against" and "the session had moved on" all
     * looked identical, and 4000+ of them accumulated that way. The consumer
     * (`agent/pre-step`) reads this and records it.
     * @type {'none'|'pending'|'empty'|'expired'|'repeat-suppressed'|'no-armed-result'|'empty-text'|'ready'|'carried'|'injection-disabled'|'error'}
     */
    this.lastTakeWhy = 'none';
    /**
     * User turns seen per agent, so the judge knows a first turn when it sees one.
     * In memory only: a restarted host re-counts from one, which is the right
     * answer for "is this the opening of a conversation".
     * @type {Map<string, number>}
     */
    this.turnCounts = new Map();
    /**
     * Sessions that have already been told the judge fell back.
     *
     * A fallback means the backend was asked and did not answer, which is not a
     * decision about the turn. Per session and not per turn, because the failure
     * is a property of the backend: one line points at the tool, and repeating it
     * every turn is the context pollution this plugin is built not to be.
     * @type {Set<string>}
     */
    this.fallbackHinted = new Set();
    /**
     * What the payload `take()` is about to hand over actually contained.
     *
     * `take()` returns a string — the contract the loop and the tests read — so the
     * identity of what was injected has to travel beside it. Without it the
     * `inject` event said how many characters arrived and nothing about *which*
     * memory: the 2026-10-24 review could only trace 425 injected blocks back to a
     * card or a unit by re-parsing the session logs.
     * @type {{ ids?: string[], top1?: number, kept?: number, kinds?: string[], synthesis?: boolean } | null}
     */
    this.lastInjectMeta = null;
    /**
     * Inject identity parked next to a cached payload.
     *
     * `SynthesisCache` stores the rendered block only, so without this an injection
     * served from cache would be as unattributable as one from before the review.
     * Bounded with the same entry count as the cache it shadows.
     * @type {Map<string, ReturnType<typeof injectionMeta>>}
     */
    this.cacheMeta = new Map();
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
   * Exact retrieval arm for one query, or null when nothing literal was named.
   *
   * The parse runs first because it is what decides whether the O(units) scan is
   * worth doing at all. An empty arm must not enter the fusion: a 0-score
   * ranking would drown the other two arms with an arbitrary index order.
   *
   * @param {import('./store.mjs').MemoryIndex} index
   * @param {string} query
   * @returns {number[] | null}
   */
  _exactArm(index, query) {
    if (!this.auto.exact) return null;
    const hits = searchExact(index.data.units, parseExactQuery(query), { limit: this.auto.candidates });
    return hits.length > 0 ? hits.map((hit) => hit.index) : null;
  }

  /**
   * Month buckets for the loaded index, rebuilt only when the index changes.
   *
   * buildTimeline is O(units) and allocates a digest per month, so it must not
   * run per turn. builtAt alone would miss a same-millisecond rebuild and size
   * alone would miss an in-place edit, so the cache key carries both.
   *
   * @param {import('./store.mjs').MemoryIndex} index
   */
  _timelineFor(index) {
    const fingerprint = index.data.builtAt + ':' + index.size;
    if (!this._timeline || this._timeline.fingerprint !== fingerprint) {
      this._timeline = { fingerprint, timeline: buildTimeline(index.data.units) };
    }
    return this._timeline.timeline;
  }

  /**
   * Nudge fused hits from months the query appears to be talking about.
   *
   * A multiplicative nudge and not a filter, on purpose: month selection is
   * keyword-level and can be wrong, and a wrong guess must never hide a correct
   * unit. When nothing matches, the fused order is returned untouched.
   *
   * @param {{ index: number, score: number }[]} hits
   * @param {import('./store.mjs').MemoryIndex} index
   * @param {string} query
   */
  _boostByTimeline(hits, index, query) {
    const boost = this.auto.timelineBoost;
    if (!(boost > 0) || hits.length === 0) return hits;
    const timeline = this._timelineFor(index);
    const months = selectMonths(timeline, query, { limit: 3 });
    if (months.length === 0) return hits;
    const wanted = new Set(months);
    let touched = false;
    const ranked = hits.map((hit) => {
      const month = timeline.byIndex.get(hit.index);
      if (!month || !wanted.has(month)) return hit;
      touched = true;
      return { ...hit, score: hit.score * (1 + boost) };
    });
    return touched ? ranked.sort((a, b) => b.score - a.score) : hits;
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
    this.turnCounts.set(agentId, (this.turnCounts.get(agentId) ?? 0) + 1);

    // A recall that finished but was never consumed is not the same thing as one
    // that never ran. The new message used to overwrite it silently, and that is
    // exactly how the one `gate: pass` of 2026-10-13 disappeared without a trace:
    // the result was ready at 00:41:11, no step came along to take it, and the
    // 00:41:57 message replaced it. It was recorded, and then still thrown away.
    // Now it is carried into this turn instead — the event stays, with the outcome
    // in `why`, so "how many recalls die waiting" and "how many were rescued" are
    // both answerable from the log.
    const previous = this.pending.get(agentId);
    if (previous && previous.status === 'ready') this.#carry(agentId, previous);
    setTelemetrySession(String(agentId).slice(0, 16));

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
    // A session starts with its working set, not with a search.
    //
    // Measured on this deployment: every retrieval score fails to decide whether
    // a turn has memory — rerank top1 p50 0.020 (the gate injected 0 of 80 real
    // turns), cosine top1 0.800 for turns that want memory against 0.825 for
    // turns that do not, raw n-gram tag coverage 0.023 against 0.042. Asking any
    // of them at turn one produced silence.
    //
    // Cards are small, curated, named, and governed, so they can be ranked by
    // *names* — a path or project the opening message and the card share — which
    // is a signal that means what we need it to mean. This is also what the
    // systems that work do: Anthropic's memory tool reads its directory before a
    // task, Letta keeps memory blocks resident.
    //
    // Runs before the judge: when the working set is on the table there is
    // nothing for a per-turn decision to add, and the retrieval that follows it
    // is the part that measurably finds nothing.
    if (this.turnCounts.get(agentId) === 1) {
      const residentConfig = resolveResidentConfig(this.options.resident || {});
      if (residentConfig.enabled) {
        try {
          const cards = await readCards(defaultCardPath());
          if (cards.length > 0) {
            const [rawVector] = await embedBatch([query], resolveConfig(this.options.embed), { purpose: 'query' });
            const hits = selectResidentCards(cards, {
              message: query,
              cwd: this.options.cwd || process.cwd(),
              queryVector: prepareQueryVector(rawVector),
              config: this.options.resident || {},
            });
            const payload = hits.length > 0
              ? renderRecall(residentEntries(hits, { maxChars: residentConfig.entryChars }), { maxTotalChars: residentConfig.maxTotalChars })
              : '';
            if (payload) {
              const ids = hits.map((hit) => String(hit.card.id).slice(0, 8));
              this.pending.set(agentId, { status: 'ready', text: payload, at: Date.now(),
                // No top1: resident selection ranks by a name match, not by a score
                // on the gate's scale, and mixing the two would make top1 meaningless.
                meta: { ids, kept: hits.length, kinds: ['card'], synthesis: false } });
              record('resident', {
                cards: hits.length,
                ids,
                scores: hits.map((hit) => hit.score),
                why: hits.flatMap((hit) => hit.why).slice(0, 8),
                chars: payload.length,
                session: String(agentId).slice(0, 16),
              });
              return;
            }
          }
        } catch (error) {
          // An unreadable card store must not take the turn down with it; fall
          // through to the ordinary path, which has its own failure reporting.
          this.ctx.logger?.debug?.('[dsh-g-memory] resident selection skipped: ' + (error?.message || error));
        }
      }
    }

    // Ask whether this turn wants memory at all, before doing any of the work.
    //
    // This is the fix for the failure of 2026-10-08..13: the automatic path used
    // to answer that question with the retrieval score, and on real traffic the
    // score says no to everything (median top-1 of -1.49 against a floor of 3),
    // so the channel was silently closed while the log showed a healthy gate.
    // The judge costs one decision call and can skip the whole pipeline below —
    // embedding, recall, rerank — which measured 3-11 s per turn.
    //
    // Default is `off`: nothing changes for a deployment that does not ask for
    // it, and every deployment still gets the new telemetry fields.
    const judgeConfig = resolveJudgeConfig(this.options.judge || {});
    /** @type {{ fire: boolean, kind: string, confidence: number, source: string } | null} */
    let judgeVerdict = null;
    if (judgeConfig.provider !== 'off') {
      const startedAt = Date.now();
      const verdict = await judgeTurn(
        { message: query, firstTurn: this.turnCounts.get(agentId) === 1 },
        {
          config: this.options.judge || {},
          onFailure: (error, layer) => this.ctx.logger?.debug?.(`[dsh-g-memory] judge ${layer}: ${error.message}`),
        },
      );
      record('judge', {
        verdict: verdict.fire ? 'fire' : 'skip',
        kind: verdict.kind,
        confidence: Number(verdict.confidence.toFixed(3)),
        source: verdict.source,
        ms: Date.now() - startedAt,
        ...(verdict.why ? { why: String(verdict.why).slice(0, 120) } : {}),
        // `source: 'fallback'` is not a layer deciding: it is every model layer
        // failing and the rules answering without a model. Recorded as such so the
        // daily fallback share is answerable from the log (16.8% after 2026-10-22,
        // up from 5.4%), together with the reason the judge classified.
        ...(verdict.source === 'fallback'
          ? { fallback: true, fallbackReason: String(verdict.why || 'unknown').slice(0, 120) }
          : {}),
        session: String(agentId).slice(0, 16),
      });
      judgeVerdict = verdict;
      if (!verdict.fire) {
        // A fallback must not read as "this turn does not want memory". Nothing
        // asked the question — so the turn gets the same one-line hint the gate
        // uses (once per session, see `fallbackHinted`), which points at the tool
        // and costs a line of text, instead of the silence that made 21 fallback
        // turns on 2026-10-23 indistinguishable from "there was no memory".
        if (verdict.source === 'fallback' && hintEnabled && !this.fallbackHinted.has(agentId)) {
          this.fallbackHinted.add(agentId);
          const hint = renderHint(verdict.kind, { fallback: true });
          this.pending.set(agentId, { status: 'ready', text: hint, at: Date.now(),
            meta: { ids: [], kept: 0, kinds: ['hint'], synthesis: false } });
          record('hint', {
            kind: verdict.kind,
            confidence: Number(Number(verdict.confidence || 0).toFixed(3)),
            source: 'fallback',
            why: String(verdict.why || 'judge fallback').slice(0, 120),
            chars: hint.length,
            session: String(agentId).slice(0, 16),
          });
          return;
        }
        this.pending.set(agentId, { status: 'empty', reason: 'judge: ' + verdict.kind, at: Date.now() });
        return;
      }
    }

    const index = await this.loadIndex();
    if (index.size === 0) {
      this.pending.set(agentId, { status: 'empty', at: Date.now() });
      return;
    }

    // The cache key carries the excluded session, and it has to. A block built while
    // filtering one session leaves that session's own units out, while the cache is
    // keyed by query and index only — so a payload built for session A would be
    // served to session B (thinner than it should be) or, worse, served back to A
    // with A's own units inside, which is the self-recall this filter removes.
    const cacheQuery = query + '\u0000' + agentId;
    const cached = this.cache.get(cacheQuery, this.fingerprint);
    if (cached) {
      this.pending.set(agentId, {
        status: 'ready',
        text: cached,
        at: Date.now(),
        // `{ cached: true }` when the meta is gone (a different process, or the
        // shadow map was pruned): the block is still injected, and saying it came
        // from cache is better than inventing an identity for it.
        meta: this.cacheMeta.get(this.cache.key(cacheQuery, this.fingerprint)) ?? { cached: true },
      });
      return;
    }

    const [vector] = await embedBatch([query], resolveConfig(this.options.embed), { purpose: 'query' });
    const queryVector = prepareQueryVector(vector);
    // Third arm (opt-in): exact literals the user actually typed. `searchExact`
    // returns [] when nothing was named, so ordinary conversation is untouched.
    const exactArm = this._exactArm(index, query);
    const hits = this._boostByTimeline(index.recall(queryVector, query, {
      k: this.auto.candidates,
      exactArm,
    }), index, query);
    // Durable cards ride the same path: same pool, same reranker, same gate.
    //
    // Self-recall exclusion. A unit from the session that is receiving the
    // injection is already in the window, so re-injecting it spends the budget on
    // text the model just read: 16.6% of the entries injected by 0.12.0 came from
    // the session that got them. Filtered before the reranker, so such a unit
    // cannot occupy a candidate slot either. `isSameSession` bridges the two
    // locator formats — the loop's agent id and the session directory name stored
    // on the unit.
    const fromThisSession = (session) => isSameSession(session, agentId);
    const cards = await readCards(defaultCardPath()).catch(() => []);
    const cardHits = (cards.length > 0 ? cardEntries(cards, queryVector) : [])
      .filter((entry) => !fromThisSession(entry.session));
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
        // The only stable name a unit has, and what `inject` reports as its id.
        hash: unit.hash,
        score,
      };
    }).filter((entry) => !fromThisSession(entry.session))];

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
    // `top1` and `reason` travel with the decision from now on. Without them a
    // drop reads as "the gate said no" and nothing else — which is why the
    // 2026-10-13 investigation had to re-derive the score distribution offline
    // before it could tell a mis-scaled threshold from a query with no memory.
    // `selectByPolicy` was already computing `reason`; it was simply discarded.
    const top1 = scored.reduce((max, entry) => (Number.isFinite(entry.score) && entry.score > max ? entry.score : max), Number.NEGATIVE_INFINITY);
    record('gate', {
      verdict: selected.selected.length > 0 ? 'pass' : 'drop',
      tier: selected.tier,
      reranked,
      kept: selected.selected.length,
      dropped: selected.dropped,
      // What the content filter and the degraded card rule threw away, key by key.
      // The reason below names them only when the whole pool is rejected; a partial
      // pass would otherwise hide that retrieval handed over fragments.
      ...(selected.droppedReasons && Object.keys(selected.droppedReasons).length > 0
        ? { droppedReasons: selected.droppedReasons }
        : {}),
      ...(Number.isFinite(top1) ? { top1: Number(top1.toFixed(3)) } : {}),
      ...(selected.reason ? { why: String(selected.reason).slice(0, 160) } : {}),
      session: String(agentId).slice(0, 16),
    });
    if (selected.selected.length === 0) {
      // The scores cannot say "there is memory here" on this corpus (see the
      // attribution report), so when the judge wanted memory and retrieval found
      // nothing it can vouch for, hand the decision to the only component that
      // can read the conversation: the model. That is what the tool path has
      // always been for; until now nothing ever pointed at it.
      if (judgeVerdict && judgeVerdict.fire && hintEnabled) {
        const hint = renderHint(judgeVerdict.kind);
        this.pending.set(agentId, { status: 'ready', text: hint, at: Date.now(),
          meta: { ids: [], kept: 0, kinds: ['hint'], synthesis: false } });
        record('hint', {
          kind: judgeVerdict.kind,
          confidence: Number(judgeVerdict.confidence.toFixed(3)),
          source: judgeVerdict.source,
          gateWhy: String(selected.reason || '').slice(0, 120),
          chars: hint.length,
          session: String(agentId).slice(0, 16),
        });
        return;
      }
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
      } else if (isRefusal(outcome.text)) {
        // An abstention is an outcome, not a no-op: the model was asked to assemble
        // these entries, declined, and the raw entries are what gets injected
        // instead. Recorded because "synthesis ran and declined" and "synthesis
        // never ran" are the same two frames in a log that only counts blocks.
        record('synthesis-refusal', {
          chars: String(outcome.text ?? '').length,
          kept: selected.selected.length,
          session: String(agentId).slice(0, 16),
        });
      } else {
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
    // The identity travels with the payload instead of being recomputed at
    // injection time: `take()` hands over a string, and the block that reaches the
    // model was rendered from these entries (or from the synthesised answer they
    // fed), so this is the last point where both are known.
    const meta = injectionMeta(selected.selected, body !== '');
    this.cache.set(cacheQuery, this.fingerprint, payload);
    // Parked beside the cache entry: `SynthesisCache` stores the rendered block
    // only, so a cache hit would otherwise be unattributable.
    this.cacheMeta.set(this.cache.key(cacheQuery, this.fingerprint), meta);
    while (this.cacheMeta.size > this.cache.maxEntries) {
      const oldest = this.cacheMeta.keys().next();
      if (oldest.done) break;
      this.cacheMeta.delete(oldest.value);
    }
    this.pending.set(agentId, { status: 'ready', text: payload, at: Date.now(), meta });
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
   * @param {ReturnType<typeof injectionMeta> | null} [meta] what the block was built
   *   from; the `/recall` handler has it at hand, and without it that injection is
   *   the one `inject` event the log could not attribute
   */
  arm(agentId, text, meta = null) {
    if (!this.auto.enabled) return;
    // Same treatment as a new user message: a result that finished too late is
    // parked rather than discarded, so an explicit /recall does not destroy the
    // automatic one that preceded it.
    const previous = this.pending.get(agentId);
    if (previous && previous.status === 'ready') this.#carry(agentId, previous);
    setTelemetrySession(String(agentId).slice(0, 16));
    this.pending.set(agentId, { status: 'ready', text, at: Date.now(), ...(meta ? { meta } : {}) });
  }

  /**
   * Consume a ready recall exactly once. Returns the text to inject, or ''.
   *
   * Three outcomes for a step, in order of preference: this turn's result, a
   * result carried over from the previous turn, or nothing at all. The carry-over
   * is offered only while this turn's own recall is still in flight — see the
   * class note for why a single-step turn needs it.
   *
   * @param {string} agentId
   * @returns {string}
   */
  take(agentId) {
    const entry = this.pending.get(agentId);
    if (!entry) {
      // No turn was armed for this agent: a message below the arming floor, or a
      // step that arrived before any message did. A carried result is deliberately
      // not injected here — the carry-over rescues a recall that this turn's own
      // window missed, it does not attach memory to a turn that never asked.
      this.lastTakeWhy = 'no-armed-result';
      return '';
    }

    if (entry.status === 'ready') {
      // This turn's memory outranks the previous turn's: it is the one that is
      // about this turn. A parked one has lost its race and is recorded as such.
      const stale = this.carried.get(agentId);
      if (stale) {
        this.carried.delete(agentId);
        this.#recordCarryDrop(agentId, 'carry-over-superseded-by-fresh', stale);
      }
      if (Date.now() - entry.at > RESULT_TTL_MS) {
        this.pending.delete(agentId);
        // The result existed and was never consumed. Recorded, because a silent
        // discard is indistinguishable from "there was nothing to inject" — the
        // single most misleading thing about this log before today.
        record('late-drop', { why: 'expired', ageMs: Date.now() - entry.at,
          chars: String(entry.text ?? '').length, session: String(agentId).slice(0, 16) });
        this.lastTakeWhy = 'expired';
        return '';
      }
      // Consume: a single recall should colour one turn, not every later step.
      this.pending.delete(agentId);
      return this.#consume(agentId, entry);
    }

    const carried = this.carried.get(agentId);
    if (carried) {
      this.carried.delete(agentId);
      if (Date.now() - carried.at > RESULT_TTL_MS) {
        this.#recordCarryDrop(agentId, 'carry-over-expired', carried);
      } else if (entry.status === 'pending') {
        // The window this layer cannot meet: this turn's recall is still running
        // (2.2-11 s of pipeline), and the previous turn's is finished and unused.
        // On a plain question-and-answer turn there is no later step to wait for,
        // so this is the only chance that result ever gets.
        const text = this.#consume(agentId, carried, 'carried');
        if (text) return text;
        return '';
      } else {
        // This turn has already been decided against — the judge said skip, the
        // gate dropped everything, retrieval came back empty. That decision is
        // about *this* turn, and carried memory must not override it.
        this.#recordCarryDrop(agentId, 'carry-over-after-empty-turn', carried);
      }
    }

    this.lastTakeWhy = entry.status;
    return '';
  }

  /**
   * Hand a payload back once, with the repeat suppression this class has always
   * applied. `kind` is the reason recorded when it succeeds.
   *
   * @param {string} agentId
   * @param {{ text?: string, at: number }} entry
   * @param {'ready'|'carried'} [kind]
   * @returns {string}
   */
  #consume(agentId, entry, kind = 'ready') {
    const text = entry.text || '';
    if (text) {
      const seen = this.injected.get(agentId) ?? new Set();
      const signature = text.slice(0, 400);
      if (seen.has(signature)) {
        record('repeat-suppressed', { chars: text.length, session: String(agentId).slice(0, 16) });
        this.lastTakeWhy = 'repeat-suppressed';
        return '';
      }
      seen.add(signature);
      // Bounded: a long session must not accumulate every payload it ever saw.
      if (seen.size > 40) seen.delete(seen.values().next().value);
      this.injected.set(agentId, seen);
    }
    // Read by `onPreStep` for the `inject` event. `take()` stays string-in /
    // string-out because that is the contract the loop and the tests read, so the
    // description rides beside it instead of changing the return type.
    this.lastInjectMeta = entry.meta ?? null;
    this.lastTakeWhy = text ? kind : 'empty-text';
    return text;
  }

  /**
   * Park a finished-but-unconsumed result for the next turn instead of dropping it.
   *
   * @param {string} agentId
   * @param {{ text?: string, at: number }} entry
   */
  #carry(agentId, entry) {
    const session = String(agentId).slice(0, 16);
    const text = String(entry.text ?? '');
    const ageMs = Date.now() - entry.at;
    const previous = this.carried.get(agentId);
    if (previous) this.#recordCarryDrop(agentId, 'carry-over-superseded', previous);
    // Expired and empty are still drops. Memory that is two minutes old, and
    // memory with nothing in it, are both worse than no memory at all.
    if (!text || ageMs > RESULT_TTL_MS) {
      this.carried.delete(agentId);
      record('late-drop', { why: 'superseded-expired', chars: text.length, ageMs, session });
      return;
    }
    // `meta` rides along: a carried payload is still the block that gets injected,
    // so the next turn's `inject` event must describe it rather than the turn it
    // missed.
    this.carried.set(agentId, { text, at: entry.at, ...(entry.meta ? { meta: entry.meta } : {}) });
    record('late-drop', { why: 'carried-to-next-turn', chars: text.length, ageMs, session });
  }

  /**
   * @param {string} agentId
   * @param {string} why
   * @param {{ text?: string, at?: number }|null} [entry]
   */
  #recordCarryDrop(agentId, why, entry = null) {
    record('late-drop', {
      why,
      chars: String(entry?.text ?? '').length,
      ...(entry && Number.isFinite(entry.at) ? { ageMs: Date.now() - entry.at } : {}),
      session: String(agentId).slice(0, 16),
    });
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
   * Rebuild the material gate from the session logs.
   *
   * The tracker counts turns in memory (see ConsolidationTracker), so every restart
   * erased progress toward the gate: a user who restarts twice in an evening watches the
   * same ">= 5 turns, then idle 10 minutes" clock start over each time. The logs already
   * record those turns — distillation reads them anyway — so the counter is derived
   * rather than persisted, and no write is added to the turn path.
   *
   * Only the newest logs are read (a session from last week cannot become "the session
   * that just went quiet"), and only turns newer than the last run count as material,
   * because a session distilled in that run has already been remembered.
   *
   * @returns {Promise<number>} sessions seeded
   */
  async rehydrateMaterial(limit = 5) {
    // A caller may switch it off: the loop's own tests measure the live-event path and
    // must not have the same material arrive twice.
    if (this.options.rehydrate === false) return 0;
    if (!this.consolidation?.config?.enabled) return 0;
    const { readFile, stat } = await import('node:fs/promises');
    const { join, dirname, basename } = await import('node:path');
    const { decompressZstdFile, extractUnits } = await import('./session-source.mjs');
    const { listSessionLogs } = await import('./live-index.mjs');
    const { materialFromUnits } = await import('./consolidate.mjs');
    const home = process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh');
    const found = await listSessionLogs(join(home, 'sessions'));
    const stamped = [];
    for (const file of found) {
      try { stamped.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
    }
    stamped.sort((a, b) => b.mtime - a.mtime);
    const since = this.consolidation.lastRunAt || 0;
    let seeded = 0;
    for (const { file } of stamped.slice(0, limit)) {
      try {
        const jsonl = file.endsWith('.zstd') ? await decompressZstdFile(file) : await readFile(file, 'utf8');
        const { units } = extractUnits(jsonl, { includeToolResults: false, includeToolCalls: false });
        const material = materialFromUnits(units, since);
        if (material.turns === 0) continue;
        if (this.consolidation.seed(basename(dirname(file)), material)) seeded += 1;
      } catch { /* one unreadable log must not stop the others */ }
    }
    if (seeded > 0) {
      this.ctx.logger?.debug?.('[dsh-g-memory] material rebuilt from logs for ' + seeded + ' session(s)');
    }
    return seeded;
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
          // `this.options.embed` and not a bare `resolveConfig()`: the task prefixes
          // live in the composition, and a card embedded without them would sit in a
          // different convention from the query side — silently, since the width is
          // identical and the card store has no way to notice.
          { session: agentId, text: transcript, coveredFrom, coveredTo, embed: async (t) => (await embedBatch([t], resolveConfig(this.options.embed), { purpose: 'doc' }))[0] },
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
      const agentId = String(agent.id);
      setTelemetrySession(agentId.slice(0, 16));
      record('armed', { session: agentId.slice(0, 16) });
      this.consolidation?.note(agent.id);
      this.start(agentId, textOf(message.content));
    };

    const onPreStep = (payload, next) => {
      // Never await here: this runs on the critical path of every step.
      try {
        if (isInjectionEnabled() && this.auto.enabled && payload && payload.agent) {
          const agentId = String(payload.agent.id);
          const text = this.take(agentId);
          if (text) {
            // `why` separates a result from this turn (`ready`) from one carried
            // over from the last (`carried`) — otherwise "memory arrived late"
            // and "memory arrived on time" are the same line in the log.
            // Identity is the half the 2026-10-24 review found missing: `chars` and
            // `why` said how much arrived and nothing about which memory, so 425
            // injected blocks could only be traced by re-parsing session logs.
            record('inject', {
              chars: text.length,
              why: this.lastTakeWhy,
              ...(this.lastInjectMeta ?? {}),
              session: agentId.slice(0, 16),
            });
            const context = newUserMessage(text);
            return next().then((decision) => {
              if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
              return { ...decision, messages: [context, ...decision.messages] };
            });
          }
        } else {
          this.lastTakeWhy = 'injection-disabled';
        }
      } catch (error) {
        this.lastTakeWhy = 'error';
        this.ctx.logger?.debug?.(`[dsh-g-memory] injection skipped: ${error?.message || error}`);
      }
      // `why` turns 4000+ indistinguishable passes into an answer to "did the
      // recall not finish, or was it decided against, or did the turn move on".
      record('pass', { why: this.lastTakeWhy });
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
        .then(async (state) => {
          if (state.lastRunAt > this.consolidation.lastRunAt) this.consolidation.lastRunAt = state.lastRunAt;
          // Material lives in this process, so a restart used to erase progress toward
          // the gate. Rebuild it from the logs, which are the durable record of it.
          await this.rehydrateMaterial().catch(() => { /* a missing log is not fatal here */ });
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
    this.carried.clear();
    this.cache.clear();
    this.cacheMeta.clear();
    this.fallbackHinted.clear();
    this.lastInjectMeta = null;
  }

}
