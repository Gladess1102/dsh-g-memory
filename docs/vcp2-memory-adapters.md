# VCP 2.0 记忆机制移植：dsh-g-memory 适配器契约

> 来源：VCP 2.0 白皮书 V6 / 本轮升级观察（见 reports/vcp-2.0-memory-study.md）。
> 本文件是并行实现的接口契约。两个模块互相独立，不修改既有文件。

## 目标

给 dsh-g-memory 增加两条 VCP 借鉴来的通道：

1. **时间分层**（对应 VCPTimeLine）：把长期记忆按“月”聚合成低成本索引，召回时给同月命中加权。
2. **精确检索臂**（对应 VCP 第二栈 DailyNoteAPI）：从 query 解析引号短语 / 日期 / tag / 路径，直接匹配原文，作为向量、词法之外的第三条 RRF 臂。

两者都必须：纯函数、零依赖、可单测、不触碰网络与文件系统。

---

## 模块 A：lib/timeline.mjs（时间分层）

### 数据形状

`MemoryIndex.data.units` 的每一项（见 lib/store.mjs 的 IndexedUnit）：

```js
{ text: string, role: 'user'|'assistant'|'tool'|'action', session: string,
  seq: number, time: number /* epoch ms */, hash: string, vector: Buffer }
```

### 导出 API

```js
/**
 * @typedef {object} MonthBucket
 * @property {string} month          'YYYY-MM'
 * @property {number} count          该月 unit 数
 * @property {string} summary        抽取式摘要（<= 200 字符）
 * @property {number[]} unitIndices  该月 unit 在 units 数组里的下标
 */

/**
 * @param {Array<{text:string,time:number}>} units
 * @param {{ maxSummaryChars?: number }} [options]
 * @returns {{ months: MonthBucket[], byIndex: Map<number,string> }}
 *   - months 按时间倒序（新→旧）
 *   - byIndex: unitIndex -> 'YYYY-MM'，供召回时快速查月份
 *   - time 非法（<=0 / 超范围）的 unit 归入 'unknown' 月，但**不要**放进 months 顶部
 */
export function buildTimeline(units, options = {})

/**
 * 用 query 选相关月份（关键词级，纯函数，不调 embedding）。
 * 打分：query token 与 month.summary + 该月文本样本的 token 重合。
 *
 * @param {{months: MonthBucket[]}} timeline
 * @param {string} query
 * @param {{ limit?: number, minScore?: number }} [options]
 * @returns {string[]} 选中的月份（'YYYY-MM'），按分数降序；无命中返回 []
 */
export function selectMonths(timeline, query, options = {})
```

### 摘要规则（必须确定性）

- 取该月按 `time` 升序的前 12 条、`text.length >= 20` 的 unit；
- 每条截断到 60 字符，去掉换行，去重后以 ` / ` 连接；
- 总长不超过 `maxSummaryChars`（默认 200），超出则按条目边界截断；
- 同一输入必须得到同一输出（禁止随机、禁止 Date.now）。

### 单测 scripts/test-timeline.mjs

至少覆盖：
- 跨月分组正确（含 'unknown' 月）；
- 摘要确定性（两次调用 deepEqual）；
- 摘要长度上限；
- selectMonths 命中中文查询（用 tokenize 的 bigram 语义不必在乎，但中文子串应能命中）；
- 空 units / 全非法 time 不抛错。

---

## 模块 B：lib/exact.mjs（精确检索臂）

### 导出 API

```js
/**
 * @typedef {object} ExactQuery
 * @property {string[]} phrases  引号内短语（去引号），原文大小写不敏感 includes
 * @property {{year:number,month?:number,day?:number}[]} dates  '2026-10' / '2026-10-22' / '2026/10/22'
 * @property {string[]} tags     '#tag' 或 'tag:xxx' 的标签名（不含前缀）
 * @property {string[]} paths    含 '/' 或常见扩展名（.md .js .json .pr .ts .py）的 token
 * @property {string} rest       去掉上述精确 token 后的 query（可空串）
 */

/** @param {string} query */
export function parseExactQuery(query)

/**
 * 对 units 做精确匹配。评分规则（确定性、可解释）：
 * - phrase: 每个命中 +3；多个 phrase 同时命中累加
 * - path:   每个命中 +2
 * - tag:    +2
 * - date:   unit.time 落在该日 +3 / 该月 +1
 * 返回按 score 降序、同分按 index 升序，最多 limit 条。
 *
 * @param {Array<{text:string,time:number}>} units
 * @param {ExactQuery} parsed
 * @param {{limit?: number}} [options]
 * @returns {{index:number, score:number, kind:string}[]}
 */
export function searchExact(units, parsed, options = {})
```

### 解析细节

- 引号：支持 `"..."`、`'...'`、`“...”`、`「...」`；
- 日期：`\b(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?\b`，校验月 1-12、日 1-31；
- tag：`#([\p{L}\p{N}_-]+)` 与 `tag:([\p{L}\p{N}_-]+)`（不区分大小写）；
- path：token 含 `/` 且长度 >= 3，或匹配 `\.[a-z0-9]{1,5}\b` 的扩展名；
- `rest`：把已识别的 span 从 query 中替换为空格后合并多余空白；
- 任何解析失败都返回空结构（不抛错）。

### 单测 scripts/test-exact.mjs

至少覆盖：
- 中英文引号短语解析；
- 日期 / 日期+日 解析与非法月日不误判；
- tag 与 path；
- rest 正确剥离；
- searchExact：短语命中、日期命中（同月）、多 kind 混合排序；
- 无精确意图时返回 []，且 parse.exact 为空。

---

## 代码风格

- 与现有 lib/*.mjs 一致：JSDoc 类型、解释“为什么”的注释（不是复述代码）、无第三方依赖；
- 不要 import embedder / network / fs；
- 文件头写模块用途与来源（VCP 2.0 对照）；
- 测试用 `node:assert/strict` 与现有 `check()` 模式，输出 ✅/❌，失败退出码 1。

## 边界

- 只写自己的两个文件（lib/<module>.mjs + scripts/test-<module>.mjs）；
- 不改 store.mjs / auto-recall.mjs / config.mjs / package.json（集成由 Lead 做）；
- 完成后运行 `node scripts/test-<module>.mjs` 必须全绿。
