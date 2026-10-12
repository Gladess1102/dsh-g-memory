#!/usr/bin/env node
/**
 * The judgement layer, tested at the wire.
 *
 * The layer's whole job is to fail safely, so the interesting cases are the
 * failures: System One returns 451 (measured behaviour from a mainland-China
 * egress), the chat backend returns prose instead of JSON, both are down. In
 * every one of those the answer must be "do not retrieve" — a judge that
 * degrades into "retrieve everything" would be worse than no judge at all.
 *
 * Hermetic: two stub endpoints on ephemeral ports, no network, no model.
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { judgeTurn, judgeWithJev, judgeWithChat, resolveJudgeConfig, ruleVerdict, buildState, KIND_CRITERIA, resetJudgeHealth } from '../lib/judge.mjs';

/** Every request the stubs saw, so we can assert what was sent. */
const seen = [];
let jevResponder = () => [200, { answers: { memory: { type: 'choice', choice: 'recall_project', confidence: 0.9 } } }];
let chatResponder = () => [200, { choices: [{ message: { content: '{"kind":"recall_user","confidence":0.8,"reason":"偏好"}' } }] }];

const DEFAULT_JEV = () => [200, { answers: { memory: { type: 'choice', choice: 'recall_project', confidence: 0.9 } } }];
const DEFAULT_CHAT = () => [200, { choices: [{ message: { content: '{"kind":"recall_user","confidence":0.8,"reason":"偏好"}' } }] }];

const jev = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ endpoint: 'jev', headers: req.headers, body: JSON.parse(body || '{}') });
    const [status, payload] = jevResponder();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
const chat = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ endpoint: 'chat', headers: req.headers, body: JSON.parse(body || '{}') });
    const [status, payload] = chatResponder();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => jev.listen(0, '127.0.0.1', r));
await new Promise((r) => chat.listen(0, '127.0.0.1', r));
const jevUrl = 'http://127.0.0.1:' + jev.address().port + '/v1/systemone';
const chatUrl = 'http://127.0.0.1:' + chat.address().port + '/v1/chat/completions';

let failures = 0;
async function check(name, fn) {
  seen.length = 0;
  // Responders are stateful on purpose (a test can make one endpoint fail), so
  // every check starts from the happy path — otherwise one test's 500 leaks into
  // the next and the failure looks like a code bug.
  jevResponder = DEFAULT_JEV;
  chatResponder = DEFAULT_CHAT;
  // The circuit breaker is per-process state on purpose (a regional block looks
  // like an outage, and retrying it per message is pure latency), so a check that
  // trips it has to hand the next check a fresh one.
  resetJudgeHealth();
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

const cfg = (over = {}) => resolveJudgeConfig({
  provider: 'auto', threshold: 0.5, timeoutMs: 3000,
  jev: { url: jevUrl, model: 'jev-1.13-free', apiKey: 'test-key', session: 'test-session' },
  chat: { url: chatUrl, model: 'deepseek-flash', apiKey: 'test-key', session: 'test-session' },
  ...over,
});

console.log('judgement layer');

await check('an explicit "remember…" never reaches a model', async () => {
  const v = await judgeTurn({ message: '你还记得我们上次定的那个规则吗' }, { config: cfg() });
  assert.equal(v.source, 'rules');
  assert.equal(v.kind, 'explicit');
  assert.equal(v.fire, true);
  assert.equal(seen.length, 0, 'the rules channel must not spend a request');
});

await check('system one is asked with a choice question and a session header', async () => {
  const v = await judgeTurn({ message: '帮我看看那个索引重建的脚本' }, { config: cfg() });
  assert.equal(v.source, 'jev');
  assert.equal(v.kind, 'recall_project');
  assert.equal(v.fire, true);
  assert.equal(seen.length, 1, 'one request, to system one');
  const [req] = seen;
  assert.equal(req.headers['x-opencode-session'], 'test-session');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.body.model, 'jev-1.13-free');
  assert.equal(req.body.questions.memory.type, 'choice');
  assert.deepEqual(Object.keys(req.body.questions.memory.criteria).sort(), Object.keys(KIND_CRITERIA).sort());
  assert.ok(!('input' in req.body), 'system one takes state, not messages');
});

await check('a 451 from system one falls through to chat', async () => {
  jevResponder = () => [451, { error: { type: 'server_error', message: 'Upstream request failed: Endpoint is unavailable.' } }];
  const failuresSeen = [];
  // A message with no rule-shaped wording: anything containing "上次" or "记得"
  // is answered by the rules layer without spending a request, which is the
  // behaviour the first check pins down.
  const v = await judgeTurn({ message: '帮我看看索引重建脚本里的重排部分' }, { config: cfg(), onFailure: (e, layer) => failuresSeen.push(layer) });
  assert.equal(v.source, 'chat');
  assert.equal(v.fire, true);
  assert.deepEqual(failuresSeen, ['jev']);
  assert.equal(seen.length, 2, 'system one then chat');
});

await check('chat is asked with thinking disabled and parsed from JSON', async () => {
  jevResponder = () => [500, { error: 'down' }];
  const v = await judgeTurn({ message: '统计脚本那个众数逻辑' }, { config: cfg() });
  assert.equal(v.source, 'chat');
  assert.equal(v.kind, 'recall_user');
  const req = seen.find((s) => s.endpoint === 'chat');
  assert.deepEqual(req.body.thinking, { type: 'disabled' }, 'without this the gateway returns empty content');
  assert.equal(req.body.temperature, 0);
});

await check('both backends down degrades to "do not retrieve"', async () => {
  jevResponder = () => [451, { error: 'unavailable' }];
  chatResponder = () => [503, { error: 'overloaded' }];
  const v = await judgeTurn({ message: '今天天气不错' }, { config: cfg() });
  assert.equal(v.source, 'fallback');
  assert.equal(v.fire, false, 'a broken judge must not inject everything');
});

await check('prose instead of JSON is a failure, not a verdict', async () => {
  jevResponder = () => [500, { error: 'down' }];
  chatResponder = () => [200, { choices: [{ message: { content: '这条消息需要长期记忆，因为……' } }] }];
  const v = await judgeTurn({ message: '那个记忆插件的闸门' }, { config: cfg() });
  assert.equal(v.fire, false);
  assert.equal(v.source, 'fallback');
});

await check('a choice below the confidence threshold does not fire', async () => {
  const low = resolveJudgeConfig({ jev: { url: jevUrl }, chat: { url: chatUrl }, threshold: 0.8 });
  const v = await judgeWithJev(buildState({ message: '嗯' }), { ...low, jev: { ...low.jev, apiKey: '', session: '' } });
  assert.equal(v.fire, true, 'recall_project at 0.9 clears 0.8');
  const strict = { ...low, threshold: 0.95 };
  const v2 = await judgeWithJev(buildState({ message: '嗯' }), { ...strict, jev: { ...strict.jev, apiKey: '', session: '' } });
  assert.equal(v2.fire, false);
  assert.equal(v2.kind, 'none');
});

await check('an unknown choice is treated as none', async () => {
  jevResponder = () => [200, { answers: { memory: { type: 'choice', choice: 'something_else', confidence: 0.99 } } }];
  const v = await judgeTurn({ message: '随便聊聊' }, { config: cfg() });
  assert.equal(v.fire, false);
  assert.equal(v.kind, 'none');
});

await check('the state carries the previous turn but not recalled memory', async () => {
  const state = buildState({ message: '那它呢', previousUser: '上一个问题是什么', assistantTail: '答案是 42', firstTurn: false });
  assert.match(state, /上一轮用户说/);
  assert.match(state, /本轮用户消息/);
  assert.ok(state.length < 1000, 'the decision prompt stays small');
});

await check('a resumed session fires on the rules layer', async () => {
  const v = await judgeTurn({ message: '我们接着弄吧', resumed: true }, { config: cfg() });
  assert.equal(v.source, 'rules');
  assert.equal(v.fire, true);
});

await check('provider=off never fires and never calls out', async () => {
  const v = await judgeTurn({ message: '记得我上次说的吗' }, { config: cfg({ provider: 'off' }) });
  assert.equal(v.fire, false);
  assert.equal(v.source, 'off');
  assert.equal(seen.length, 0);
});

await check('the rules channel alone can be selected', async () => {
  const v = await judgeTurn({ message: '今天几号' }, { config: cfg({ provider: 'rules' }) });
  assert.equal(v.source, 'rules');
  assert.equal(v.fire, false);
  assert.equal(seen.length, 0);
});

await check('a persistently failing system one trips the breaker instead of retrying per message', async () => {
  jevResponder = () => [451, { error: 'Endpoint is unavailable.' }];
  resetJudgeHealth();
  for (let i = 0; i < 4; i += 1) {
    await judgeTurn({ message: '索引重建脚本第 ' + i + ' 个问题' }, { config: cfg() });
  }
  const jevCalls = seen.filter((s) => s.endpoint === 'jev').length;
  assert.equal(jevCalls, 3, 'three attempts, then the layer is skipped');
  assert.ok(seen.some((s) => s.endpoint === 'chat'), 'chat still answers');
});

await check('ruleVerdict is usable on its own (the label script reuses it)', async () => {
  assert.equal(ruleVerdict({ message: '你还记得上次那个格式吗' }).kind, 'explicit');
  assert.equal(ruleVerdict({ message: '在吗' }).fire, false);
});

jev.close();
chat.close();

console.log('');
console.log(failures === 0 ? 'judge: all checks passed' : 'judge: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
