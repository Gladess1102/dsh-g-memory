# 0.13.0 实施规格（一次全做）

> 目标：把 [plan.md](plan.md) 的 P0/P1/P2 一次性落到代码。所有改动必须可测试、可回退。
> 约束：不改数据目录；不重建索引；不触发全量 embedding；测试用 node scripts/test-*.mjs 或 npm test。

## 新模块 lib/quality.mjs（T1 创建，T2/T3 只读 import）

```js
export const QUALITY_LIMITS = { minContentChars: 60, maxEntryChars: 1200 };

/** null = 可注入；否则返回拒绝原因（'too-short'|'json'|'path-only'|'log-dump'|'tool-fragment'|'too-long'） */
export function contentRejectReason(entry, limits = QUALITY_LIMITS): string | null;

/** 卡片降级路径：只取 top1，要求 similarity >= cardMinSimilarity 且 top1-top2 >= cardMargin；返回最多 1 张并标 unverified。 */
export function pickDegradedCards(entries, { cardMinSimilarity = 0.68, cardMargin = 0.02 } = {}): { entries: any[], dropped: number, reason?: string };

/** 本地时区 'YYYY-MM-DD HH:mm'（替代 toISOString，修 UTC 偏移 8h） */
export function formatLocalTime(ms: number): string;
```

判定规则（按顺序）：
1. `text.trim().length < limits.minContentChars` → too-short
2. 文本以 `{` 或 `[` 开头，或包含 `"callId"` / `"tool_calls"` / `"arguments":` / `"type":"tool` → tool-fragment
3. 单行且匹配 `/^[\w.~\/-]+$/` 且含 `/` → path-only
4. 多行且（`===` 分隔线 / `[INFO]` / `[WARN]` / `[ERROR]` / 连续 3 行以上以时间戳开头）→ log-dump
5. `text.length > limits.maxEntryChars` → too-long
6. 其余 null

## T1：lib/quality.mjs、lib/inject.mjs、lib/policy.mjs、lib/cards.mjs

- `lib/inject.mjs`：
  - `INJECTION_LIMITS` 增加 `cardMargin: 0.02`、`minContentChars: 60`、`maxEntryChars: 1200`；`maxPreviewChars` 400→800。
  - `selectForInjection`：先 `contentRejectReason` 过滤（计入 `droppedReasons`）；`limits.reranked === false` 时卡片走 `pickDegradedCards`；**不再 slice text**（超长整条丢，已由 too-long 拦截）；预算不够时整条跳过。返回 `{ selected, dropped, droppedReasons, reason }`。
  - `renderRecall`：时间用 `formatLocalTime`；entry.truncated 为 true 时行尾加 ` …[truncated]`；预算仍按整行判断。
- `lib/policy.mjs`：
  - 默认值：`cardMinSimilarity: 0.68`、`cardMargin: 0.02`、`minContentChars: 60`、`maxEntryChars: 1200`。
  - `selectByPolicy`：内容过滤 + 降级卡片逻辑复用 quality；返回 `droppedReasons`。
- `lib/cards.mjs`：两处 `toISOString()` 改 `formatLocalTime`。
- 测试：新增 `scripts/test-quality.mjs`（至少 12 断言：5 类拒绝、卡片 top1/margin、短文本、超长）。

## T2：lib/auto-recall.mjs、lib/index.js、lib/rerank.mjs

- `lib/index.js` `retrieve(query, limit, opts = {})`：新增 `excludeSession`；过滤 `entry.session` 与 excludeSession 同会话（按前 16 字符匹配，任一为前缀即算）；把 `minContentChars/maxEntryChars/cardMargin` 传给 `selectForInjection`。
- `lib/auto-recall.mjs`：
  - recall 调用传 `excludeSession: agentId`。
  - judge 返回 `source === 'fallback'` 时：record('judge', {..., fallback:true, fallbackReason})；**每会话最多一次**注入 hint（复用 renderHint），不再静默 skip。
  - synthesis 返回 refusal（isRefusal）时：record('synthesis-refusal')，body 置空走原文注入（已接近现有逻辑，确认并补打点）。
  - `record('inject')` 增加 `ids`（card.id 或 unit.hash 前 8 位）、`top1`、`kept`、`kinds`（去重来源类型）、`synthesis: boolean`。
  - 降级路径（reranked=false）：调用 selectByPolicy 时传 reranked，由 policy 收紧卡片；补 record('gate', { reranked:false }) 已有。
- `lib/rerank.mjs`：保持返回契约；新增导出 `rerankAvailable` 或注释说明失败方向由调用方收紧（不要改行为）。
- 测试：`scripts/test-inject.mjs` / `test-policy.mjs` 补降级负样本断言（不依赖 11436）。

## T3：lib/judge.mjs、scripts/test-plugin.mjs、scripts/memory-doctor.mjs、新脚本

- `lib/judge.mjs`：失败路径统一返回 `{ fire:false, kind:'none', confidence:0, source:'fallback', why: <分类原因> }`；新增 `classifyJudgeFailure(error)` 返回 'timeout'|'http-<status>'|'parse'|'network'。
- `scripts/test-plugin.mjs`：白名单同步 tools.mjs schema（source/orphaned/state/stateNote/supersededBy）；依赖真实 rerank 的 2 项改为「有 reranker 才断言，否则 skip 并打印原因」。
- `scripts/memory-doctor.mjs`：增加 profile diff 检查（desktop vs web 的 gate/judge 关键值）；fallback 日占比 >10% 记 warning；exit code 改为 degraded 也 exit 1（或 --allow-degraded）。
- 新脚本：
  - `scripts/eval-card-gate.mjs`：184 张卡 + 10 条负样本/10 条正样本，输出不同 cardMinSimilarity/cardMargin 下的通过率，用于复核 0.68/0.02。
  - `scripts/eval-quality.mjs`：从 stats + 会话日志算碎片率/截断率/自召回率/漏召回率，输出 JSON + 退出码（门禁）。
  - `scripts/eval-exact.mjs`：exact 臂在 PR 号/日期/路径查询上的命中率。
  - `scripts/audit-structure.mjs`：卡片/单元的连通度轻量审计（同会话/tag 共现）。
- 所有脚本只读，不写数据目录。

## 接口契约

- `selectForInjection(entries, limits)` 向后兼容：不传新参数时行为=内容过滤+不截断（这是行为变更，需在 CHANGELOG 注明）。
- `selectByPolicy(entries, options)` 同上。
- `quality.mjs` 不得 import inject/policy/index（避免循环）。
- 所有新 env：`DSH_G_MEMORY_CARD_MARGIN`、`DSH_G_MEMORY_MIN_CONTENT_CHARS`、`DSH_G_MEMORY_MAX_ENTRY_CHARS`。

## 验收

1. `node scripts/test-quality.mjs` 全绿；`node scripts/test-inject.mjs`、`test-policy.mjs` 全绿。
2. `npm test` 从 50/54 提升到全绿（或仅剩环境项且打印 skip 原因）。
3. `node scripts/eval-card-gate.mjs` 证明负样本在 0.68/0.02 下 0 通过。
4. 冒烟：`node -e` 构造含 JSON 碎片/短文本/当前会话单元的 entries，断言 0 注入。
