/**
 * The judgement layer: "does this turn need memory at all?"
 *
 * The automatic path used to answer that question with the retrieval score —
 * a cross-encoder logit compared against an absolute floor. That is a category
 * error, and it failed twice: on 2026-10-08 the floor stopped letting anything
 * through (real chat messages score a median of -1.49, the floor was 3), and
 * the statistic it replaced (a head margin) measured out at AUC 0.02-0.04 on
 * this corpus. The score can rank candidates. It cannot decide whether the turn
 * deserves to look at memory.
 *
 * So the decision moves here, and it is made before retrieval runs:
 *
 *   deterministic rules  →  a decision model  →  safe default (do not retrieve)
 *
 * Rules go first because they cost nothing and cover the cases that matter most
 * (an explicit "remember when…", a session that just resumed, a follow-up that
 * clearly points backwards). Only what the rules cannot settle is sent to a
 * model — the same discipline VCP's JEV tool-call experiment arrived at
 * ("deterministic templates first, JEV only for the residual choice").
 *
 * Two decision backends are supported, in this order:
 *
 *   `jev`   TypeSafe System One, served by OpenCode at
 *           https://opencode.ai/inference/v1/systemone. A decision model, not a
 *           chat model: it answers typed questions (noul / choice / score) with
 *           calibrated probabilities and never generates prose, which is exactly
 *           the shape this question has. 70-500 ms, $0.042/M input.
 *   `chat`  any OpenAI-compatible chat endpoint, asked for one line of JSON.
 *           Slower and wordier, but it is what is available when System One is
 *           not (see below).
 *
 * Known deployment constraint, measured 2026-10-13: the System One endpoint
 * answers **HTTP 451 "Upstream request failed: Endpoint is unavailable."** from
 * a mainland-China egress — the gateway forwards to TypeSafe and TypeSafe
 * refuses the region. The same credential lists `jev-1.13-free` and works
 * against the chat endpoint, so the failure is geographic, not a key or schema
 * problem. `provider: 'auto'` therefore tries System One, falls back to chat,
 * and finally to rules — and every answer carries `source` so a caller can tell
 * which one produced it.
 *
 * Failure policy, copied from the same experiment: a decision backend that is
 * down, slow or answers out of contract must degrade to **not retrieving**, never
 * to retrieving everything. Memory is an enhancement; guessing is not.
 *
 * SPDX-License-Identifier: MIT
 */

import { numberEnv } from './env.mjs';

/**
 * What the turn wants. Ordered by increasing certainty, which is also the order
 * the injection layer uses to size the payload.
 * @typedef {'none'|'recall_user'|'recall_project'|'explicit'} RecallKind
 */

/**
 * @typedef {object} JudgeVerdict
 * @property {boolean} fire whether the turn should retrieve memory at all
 * @property {RecallKind} kind what it wants, for sizing the injection
 * @property {number} confidence 0-1; from the backend when it reports one
 * @property {'rules'|'jev'|'chat'|'fallback'|'off'} source which layer decided
 * @property {string} [why] short human-readable reason, for the decision log
 */

/** The rule channel's patterns. Deliberately small and explainable. */
const EXPLICIT_PATTERNS = [
  /记得|记不记得|还记得|别忘|上次|之前(说|提|定|写)|早先|当初|以前(说|提|定)的?/,
  /我们(说好|约定|定过|做过)|我(写|说)过|规则里(写|说)/,
  /\bremember\b|\blast time\b|\bearlier you\b|\bwe agreed\b|\bpreviously\b/i,
];

/** Follow-ups that point backwards without naming anything. */
const REFERENCE_PATTERNS = [
  /^(那|这|它|他|她|这个|那个|这些|那些)(个|件|事|东西)?/,
  /继续|接着(上|之前)|还有呢|后来呢|然后呢|结果呢/,
  /^那你|^所以呢|^为什么(呢|不)/,
];

/**
 * Configuration, read per call (a later `process.env` change must win — this
 * module is imported by the plugin, by scripts, and by tests in one process).
 *
 * @param {Record<string, any>} [overrides]
 */
export function resolveJudgeConfig(overrides = {}) {
  const base = {
    /** auto | jev | chat | rules | off */
    provider: (process.env.DSH_G_MEMORY_JUDGE || 'auto').trim().toLowerCase(),
    /** Below this confidence a non-explicit verdict does not fire. */
    threshold: numberEnv('DSH_G_MEMORY_JUDGE_THRESHOLD', 0.5, { min: 0, max: 1 }),
    // A chat backend answering one line of JSON measured 1.3 s/message on this
    // deployment; 4 s was close enough to the tail to time out on real traffic.
    timeoutMs: numberEnv('DSH_G_MEMORY_JUDGE_TIMEOUT_MS', 8_000, { min: 200 }),
    /** The first user turn of a session has no local context to answer from. */
    fireOnFirstTurn: (process.env.DSH_G_MEMORY_JUDGE_FIRST_TURN || 'off') === 'on',
    jev: {
      url: process.env.DSH_G_MEMORY_JEV_URL || 'https://opencode.ai/inference/v1/systemone',
      model: process.env.DSH_G_MEMORY_JEV_MODEL || 'jev-1.13-free',
      apiKey: process.env.OPENCODE_API_KEY || process.env.DSH_G_MEMORY_JEV_KEY || '',
      session: process.env.DSH_G_MEMORY_JEV_SESSION || 'dsh-g-memory',
    },
    chat: {
      url: process.env.DSH_G_MEMORY_JUDGE_CHAT_URL || 'https://opencode.ai/zen/go/v1/chat/completions',
      model: process.env.DSH_G_MEMORY_JUDGE_CHAT_MODEL || 'deepseek-flash',
      apiKey: process.env.OPENCODE_GO_API_KEY || process.env.DSH_G_MEMORY_JUDGE_CHAT_KEY || '',
      session: process.env.DSH_G_MEMORY_JUDGE_CHAT_SESSION || 'dsh-g-memory',
    },
  };
  return {
    ...base,
    ...overrides,
    jev: { ...base.jev, ...(overrides.jev || {}) },
    chat: { ...base.chat, ...(overrides.chat || {}) },
  };
}

/**
 * The decision question, in one place so both backends ask the same thing.
 * The descriptions are what a decision model reasons over, so they are written
 * as class definitions rather than keywords.
 */
export const KIND_CRITERIA = {
  none: '闲聊、寒暄、情绪表达、写作或风格反馈（"太AI味了""再来几段""继续"）、'
    + '纯知识或数学题、终端粘贴、对上一句的简单追问（"然后呢""为什么"）：'
    + '仅凭本轮对话就能回答，不需要过去会话里的任何内容',
  recall_user: '需要用户的既往偏好、事实或习惯，且这些内容不在本轮对话里'
    + '（他说过喜欢什么、他住在哪、他的工作方式）',
  recall_project: '用户正在推进或交接某件具体的工作，需要此前项目、决策、产物或结论的上下文'
    + '（之前定过的方案、写过的文件、跑出来的结论、还没做完的事）',
  explicit: '用户明确要求回忆（"记得…"、"上次那个"、"我们之前定的"）',
};

/**
 * Negative examples for the chat backend.
 *
 * Measured, and the reason they are here: the first criteria list ("does it need
 * prior context?") fired on 21 of 40 real turns — "太AI味了", "继续吧" and
 * "听不懂，演示一个给我看看" were all read as project context. The decision models
 * lean on whatever the class description lets them, so the description has to
 * say what "none" looks like, not just what the other three look like.
 */
const NONE_EXAMPLES = '反例（都算 none）："想的这么多啊，有趣，继续吧"、"你这几段还是很AI味儿啊，再来"、'
  + '"听不懂，演示一个给我看看"、"这样就算修好了么？"、"今天天气不错"。';

/**
 * The state handed to a decision backend.
 *
 * Deliberately short: the recent user turns plus the tail of the last assistant
 * reply, not recalled memory itself. Two reasons — the question is about the
 * *turn*, and stuffing memory into the question would make the judge answer
 * "is this memory relevant" instead of "was memory wanted". VCP's registry spec
 * arrived at the same rule for a different reason (keep the decision prompt to
 * the decision; load plugin detail only once it is a candidate).
 *
 * @param {{ message?: string, previousUser?: string, assistantTail?: string, firstTurn?: boolean }} input
 * @returns {string}
 */
export function buildState(input = {}) {
  const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const lines = [];
  if (input.firstTurn) lines.push('这是本会话的第一条用户消息。');
  if (input.previousUser) lines.push('上一轮用户说：' + clip(input.previousUser, 200));
  if (input.assistantTail) lines.push('上一轮助手回答的结尾：' + clip(input.assistantTail, 200));
  lines.push('本轮用户消息：' + clip(input.message, 400));
  return lines.join('\n');
}

/** What the rules alone say. Exported because the label script reuses it. */
export function ruleVerdict(input = {}) {
  const text = String(input.message ?? '');
  if (EXPLICIT_PATTERNS.some((re) => re.test(text))) {
    return { fire: true, kind: 'explicit', confidence: 1, source: 'rules', why: 'explicit recall phrasing' };
  }
  if (input.resumed === true) {
    return { fire: true, kind: 'recall_project', confidence: 1, source: 'rules', why: 'session resumed after a gap' };
  }
  if (input.firstTurn === true && input.fireOnFirstTurn) {
    return { fire: true, kind: 'recall_project', confidence: 1, source: 'rules', why: 'first turn of a session' };
  }
  if (REFERENCE_PATTERNS.some((re) => re.test(text))) {
    return { fire: false, kind: 'none', confidence: 0.5, source: 'rules', why: 'backward reference, left to the model' };
  }
  return { fire: false, kind: 'none', confidence: 0, source: 'rules', why: 'no rule matched' };
}

/**
 * How many times System One may fail in a row before this process stops asking.
 *
 * Measured on 2026-10-13: every request to the System One endpoint answers 451
 * from this deployment's egress — a geographic refusal, not a transient error.
 * Retrying it once per user message costs ~0.9 s each and produces nothing, so
 * the layer trips open and the log says so. Reset per process; a real outage and
 * a regional block look the same from here, and only one of them is permanent.
 */
let jevFailuresInARow = 0;
const JEV_TRIP_AFTER = numberEnv('DSH_G_MEMORY_JEV_TRIP_AFTER', 3, { min: 1 });

/** Exposed for tests and for a caller that knows the environment changed. */
export function resetJudgeHealth() {
  jevFailuresInARow = 0;
}

/** Parse a decision model's choice into the shared verdict shape. */
function verdictFromChoice(choice, confidence, source, threshold) {
  const kind = Object.prototype.hasOwnProperty.call(KIND_CRITERIA, choice) ? choice : 'none';
  const conf = Number.isFinite(confidence) ? confidence : 0;
  const fire = kind !== 'none' && (kind === 'explicit' || conf >= threshold);
  return { fire, kind: fire ? kind : 'none', confidence: conf, source, why: 'model chose ' + kind };
}

/**
 * Ask a TypeSafe System One endpoint.
 *
 * One `choice` question with a confidence, because a bare yes/no ("noul") was
 * measured to be too conservative: on 17 real messages it fired once, and it
 * missed the cross-session hand-off ("我给你 session ID，你去对应工作区查")
 * entirely. Naming the *kind* of memory wanted gives the model somewhere to put
 * "this needs project context" without also having to be brave.
 *
 * @param {string} state
 * @param {ReturnType<typeof resolveJudgeConfig>} cfg
 * @param {typeof fetch} [fetchImpl]
 */
export async function judgeWithJev(state, cfg, fetchImpl = fetch) {
  if (!cfg.jev.url) throw new Error('no jev url');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.jev.apiKey) headers.Authorization = 'Bearer ' + cfg.jev.apiKey;
  // Measured: this gateway answers 400 MissingSessionID without it.
  if (cfg.jev.session) headers['x-opencode-session'] = cfg.jev.session;
  const response = await fetchImpl(cfg.jev.url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      model: cfg.jev.model,
      state,
      questions: {
        memory: {
          type: 'choice',
          instructions: '回应这条用户消息，是否需要长期记忆（过去会话里存下的内容）？',
          criteria: KIND_CRITERIA,
        },
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('jev HTTP ' + response.status + ' ' + body.slice(0, 120));
  }
  const payload = await response.json().catch(() => null);
  const answer = payload?.answers?.memory;
  if (!answer || typeof answer.choice !== 'string') throw new Error('jev response out of contract');
  return verdictFromChoice(answer.choice, Number(answer.confidence), 'jev', cfg.threshold);
}

/**
 * Ask any OpenAI-compatible chat endpoint, in JSON.
 *
 * `thinking: { type: 'disabled' }` is not optional on this gateway: without it
 * the model spends the whole budget on reasoning and returns empty content —
 * measured, 7 of 17 answers failed to parse before it was added and 0 after.
 *
 * @param {string} state
 * @param {ReturnType<typeof resolveJudgeConfig>} cfg
 * @param {typeof fetch} [fetchImpl]
 */
export async function judgeWithChat(state, cfg, fetchImpl = fetch) {
  if (!cfg.chat.url || !cfg.chat.model) throw new Error('no chat judge configured');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.chat.apiKey) headers.Authorization = 'Bearer ' + cfg.chat.apiKey;
  if (cfg.chat.session) headers['x-opencode-session'] = cfg.chat.session;
  const response = await fetchImpl(cfg.chat.url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      model: cfg.chat.model,
      max_tokens: 400,
      temperature: 0,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content:
          '你是记忆系统的判定器。判断为了正确回应本轮用户消息，agent 是否需要检索长期记忆。'
          + '只能在给定的四个类别中选择：' + JSON.stringify(KIND_CRITERIA) + '。' + NONE_EXAMPLES
          + '拿不准时选 none。只输出一行 JSON：'
          + '{"kind":"none|recall_user|recall_project|explicit","confidence":0-1,"reason":"不超过15字"}。' },
        { role: 'user', content: state },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('chat HTTP ' + response.status + ' ' + body.slice(0, 120));
  }
  const payload = await response.json().catch(() => null);
  const text = String(payload?.choices?.[0]?.message?.content ?? '')
    .replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(text);
  return verdictFromChoice(parsed.kind, Number(parsed.confidence), 'chat', cfg.threshold);
}

/**
 * Decide whether this turn should look at memory.
 *
 * Never throws: every backend failure lands on the previous layer, and the last
 * layer is "do not retrieve". The returned `source` is what makes a degraded
 * decision distinguishable from a confident one in the log.
 *
 * @param {{ message?: string, previousUser?: string, assistantTail?: string, firstTurn?: boolean, resumed?: boolean }} input
 * @param {{ config?: Partial<ReturnType<typeof resolveJudgeConfig>>, onFailure?: (error: Error, layer: string) => void, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<JudgeVerdict>}
 */
export async function judgeTurn(input = {}, options = {}) {
  const cfg = resolveJudgeConfig(options.config || {});
  if (cfg.provider === 'off') {
    return { fire: false, kind: 'none', confidence: 0, source: 'off', why: 'judge disabled' };
  }
  const rules = ruleVerdict({ ...input, fireOnFirstTurn: cfg.fireOnFirstTurn });
  if (cfg.provider === 'rules' || rules.source === 'rules' && rules.confidence >= 1) return rules;

  const state = buildState(input);
  const layers = cfg.provider === 'jev' ? ['jev']
    : cfg.provider === 'chat' ? ['chat']
      : ['jev', 'chat'];
  for (const layer of layers) {
    if (layer === 'jev' && jevFailuresInARow >= JEV_TRIP_AFTER) {
      options.onFailure?.(new Error('system one tripped open after ' + jevFailuresInARow + ' failures'), 'jev-circuit-open');
      continue;
    }
    try {
      const verdict = layer === 'jev'
        ? await judgeWithJev(state, cfg, options.fetchImpl)
        : await judgeWithChat(state, cfg, options.fetchImpl);
      if (layer === 'jev') jevFailuresInARow = 0;
      return verdict;
    } catch (error) {
      if (layer === 'jev') jevFailuresInARow += 1;
      options.onFailure?.(error instanceof Error ? error : new Error(String(error)), layer);
    }
  }
  // Every model layer failed. Fall back to what the rules said without claiming
  // a model agreed with it.
  return { ...rules, source: rules.confidence >= 1 ? 'rules' : 'fallback', why: rules.why + ' (model layers unavailable)' };
}
