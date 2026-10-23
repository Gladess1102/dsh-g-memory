# dsh-g-memory 代码自检报告（0.12.0 + 10-22 未发布改动）

- 审查员：code-auditor（task-3）
- 时间：2026-10-24 01:47–02:05（Asia/Shanghai）
- 仓库：`/Users/yangyuxin/.dsh/local-keep/dsh-g-memory`
- 数据目录：`~/.dsh/dsh-g-memory`（只读；未触发 rebuild / 全量 embedding / 任何写操作）
- 代码基线：HEAD `2b75882`（2026-10-22 17:11 docs）+ **工作区未提交改动** `scripts/memory-doctor.mjs`（+271/−8，10-20 的 coldstart/judge 检查）
- package.json 版本 **0.12.0**；HEAD 上另有 10-22 的 `ea3e07c`（VCP 2.0 second stack + month tier，1648 行）未发版

> 结论速览：**索引侧守卫是健康的（audit PASS、prune 0 行、calibration 22/22），缺陷集中在「卡片召回」与「注入侧诊断/测试守卫」**。最高严重度一条：卡片在降级路径上的相似度地板（0.35）在当前 EmbeddingGemma 2 向量空间下已**恒真**——随机 token 查询能让 8 张卡片全部通过（cosine 0.655），实测负面查询被注入 3 张无关卡片。

---

## 1. 执行结果（如实记录）

| 命令 | 退出码 | 结果 | 备注 |
|---|---|---|---|
| `npm run test:unit` | 0 | 7 组全绿 | 不需要索引/模型 |
| `npm test` | **1** | **50/54**，4 项 ❌ | 只有最后一个 stage（`test-plugin.mjs`）红 |
| `npm run test:strict` | 未跑 | — | 与 `npm test` 的区别只是 `test-plugin.mjs --strict`；本次 0 个 skip，按定义会同样红 4 项 |
| `node scripts/memory-doctor.mjs --json --days 7` | 0 | verdict **degraded**（0 problems / 5 warnings） | 见 §2 |
| `node scripts/audit-index-sources.mjs` | 0 | **PASS** | 见 §2 |
| `node scripts/prune-injected-rows.mjs --dry --json` | 0 | `removed: 0` / `refusedHashes: 4201` | 只读 dry-run，无 sideFile |
| `npm run eval:calibration` | 0 | **PASS**，recall@20 22/22（100%） | 真实索引 + 真实嵌入/重排 |

### 1.1 4 个红灯的具体内容

```
❌ execute returns no internal field leakage
❌ an unanswerable query recalls nothing end to end      expected no memory, got 3
❌ /recall returns framed memory                          'No matching memory found.'
❌ /recall arms exactly one injection for the next step    1 !== 2
```

CHANGELOG 0.12.0 已自认这一点：「残留 4 个红灯与本次改动前**逐条一致**（用 `git worktree` 对 HEAD 建基线比对过，IDENTICAL_FAILURES）」。本次复跑结果与之一致，**不是 10-22 改动引入的新回归**。四项的性质必须分开看：

| # | 项 | 性质 | 依据 |
|---|---|---|---|
| 1 | execute 字段泄漏 | **测试守卫过时**（非产品缺陷） | schema 已在 `lib/tools.mjs:365-377` 声明 `source/orphaned/state/stateNote/supersededBy`；白名单断言在 `scripts/test-plugin.mjs:475-482` 仍是旧的 6 字段，未同步 `62676d4`（0.9.2）新增字段 |
| 2 | 不可答查询召回 3 条 | **真实产品行为缺陷**（降级路径） | 复现见 §3 D1；这 3 条是 card，`score: 0`，靠 cosine 门槛进入 |
| 3-4 | `/recall` 返回空 | **测试对环境敏感** | 该检查依赖真实索引 + 真实 reranker 的分数（`test-plugin.mjs:972-1000` 注释自己承认）；本次 reranker 被探测到（`http://127.0.0.1:11436`），rerank 后 `gate` 用的是进程默认 0（未加载 profile 的 −1.0），候选全被 0 地板拒绝 |

复现（隔离生产统计，指向 /tmp）：`/tmp/gm-repro.mjs`、`/tmp/gm-card-sim.mjs`、`/tmp/gm-unit-shape.mjs`（脚本内容见附录 A）。

---

## 2. 健康度现状（只读实测，2026-10-24 01:50–02:00）

### 2.1 index（`audit-index-sources`）

```
audit:index-sources — PASS
  index : /Users/yangyuxin/.dsh/dsh-g-memory/index
  units : 41130   built 2026-10-23 17:47:52   model: embeddinggemma-2
  injected kind 0 / no kind 0 / unlabelled user rows 0
  kinds: 38366 (none) · 2764 user
  role×kind: tool 26396 / assistant 9995 / user 2764 / action 1975
```

说明：非 user 行的 `sourceKind=null` 是预期（harness 不给 assistant/tool 事件打 kind），脚本把「null（写入方明说无来源）」与「undefined（字段引入前写入）」分开计，口径自洽。0.12.0 的白名单修复在现库上成立：**user 行 2764 条全部带 `kind=user`，0 条注入**（对比 10-17 的 1729/3529）。

### 2.2 prune（`--dry`）

```json
{ "indexDir": ".../index", "before": 41130, "removed": 0, "remaining": 41130,
  "refusedHashes": 4201, "byKind": {}, "sideFile": null, "dry": true }
```

从日志反推的「本应被拒」内容 4201 条哈希，索引中命中 0 行 —— 索引与抽取规则一致，没有残留脏行。

### 2.3 doctor（7 天窗口）：degraded，0 problems / 5 warnings

| level | area | 关键内容 |
|---|---|---|
| ok | index | 41153 units，768 dims（比 audit 多 23，因为 live index 在持续增量写入）；「last written 1 min ago」 |
| ok | models | embedder 126 ms 响应；重排器不在本 shell，但宿主在用它（按最近一次 gate 决策推断） |
| ok | cards | 184 张（175 active），180 tagged |
| warn | traffic | 7 天：armed 991 / inject 249 / gate pass 250·drop 149 / judge 762（fire 412）/ resident 108 / hint 149 / late-drop 87（38 carried，**49 lost**） |
| warn | coldstart | n=672，P50 3.6s、P95 5.7s、max **117.7s**；客户端预算 90s（两个 profile 都是 90000ms）→ **最坏一次仍超预算**；另有 **2 次从未 ready**（守护进程 180s 上限） |
| warn | judge | 55/762 判定降级（source=fallback），集中于 10-17/10-18 |
| warn | late-drop | 10-19 一天占 28/87 |
| ok | backups | 无陈旧副本 |
| ok | config | declared：web judge=rules resident=true **gate=3**；desktop judge=chat resident=true **gate=-1.0** |

**交叉验证**：`reports/maintenance-20261020.md` 称「90s 覆盖实测最坏档」；doctor 的 117.7s 与 2 次 ≥180s 证明该结论应修正为「覆盖不到最坏档」（本次 doctor 的 coldstart 检查正是 10-20 未提交的那 271 行改动）。

---

## 3. 缺陷清单

严重度：**S1 = 直接影响召回正确性**；S2 = 影响可维护性/诊断/配置；S3 = 低危或口径问题。

### D1【S1】卡片在降级路径上的相似度地板（0.35）已恒真，无关卡片被注入

- 位置：`lib/inject.mjs:119-123`（卡片分支）与 `lib/policy.mjs:281-288`（同逻辑的第二份），阈值默认 `lib/policy.mjs:197` = 0.35
- 机制：卡片入池时 `score: 0`（不是 RRF 命中，`lib/cards.mjs:505-535`）。降级路径（`reranked === false`）下卡片改判 `similarity >= cardMinSimilarity`；单元判 `rrfFloor()`。
- 实测（`/tmp/gm-card-sim.mjs`，184 张卡、175 active、真实 11439 端点）：

  | 查询 | 通过 0.35 的卡片数 | 最高 cosine |
  |---|---|---|
  | `zqffffffffffffffffff`（随机 token） | **8/8** | 0.6554 |
  | `今天天气怎么样`（完全无关） | **8/8** | 0.5886 |
  | `llama-server token limit`（相关） | 8/8 | 0.7140 |

  当前嵌入模型下卡片 cosine 的**下界约 0.58**，0.35 这个地板不再区分任何东西。
- 端到端复现（`/tmp/gm-repro.mjs`，无 rerank 环境）：
  ```
  query 'llama-server token 上限'  → found 3, 3 张 card, score 0
  query 'zqffffffffffffffffff'      → found 3, 3 张 card, score 0   ← 测试 585-596 断言应为 0
  ```
- 为什么过期：`lib/policy.mjs:191-197` 与 `lib/inject.mjs:126-137` 的注释把 0.35 的依据写成「15 张卡、8 条不可答查询、最好 0.276」。那是 2026-10-02 的旧嵌入空间与 15 张卡的标定；现在是 EmbeddingGemma 2 + 184 张卡，**没有任何回归测试或重新标定脚本守护这个常数**（`test-inject`/`test-policy` 都不含卡片 cosine 分布的用例）。
- 影响：当 reranker 不可用/冷启动失败（doctor 实测 11436 是按需守护，10-19 出现过 117.7s 与 2 次 ≥180s）时，自动召回与 `memory_recall` 会把 3 张无关卡片当记忆注入；这正是 task-2 观察到的「卡片式碎片/无关注入」在代码层的来源。

### D2【S1】rerank 失败的方向是「放宽」而不是「收紧」，与 D1 叠加

- 位置：`lib/rerank.mjs:214-226`（`entries.length < 2` 或 `order === null` → `reranked: false`）、`lib/auto-recall.mjs:525-556`（rerank 与降级 gate）、`lib/index.js:257-265`
- 机制：`reranked` 是布尔降级开关，失败时卡片改用 cosine 0.35（D1 的恒真门槛），单元改用 `rrfFloor()`（0.0163）——**两条都是最宽松的那一档**。README 声明的策略是 "err toward missing a memory rather than inventing one"，但降级路径的选择恰好相反。
- 证据：`test-plugin` 的两次 execute 在 `detectLocalReranker()` 之前执行（`scripts/test-plugin.mjs:463` 早于 `:972`），此时该进程没有 `DSH_G_MEMORY_RERANK_URL` → 走的正是降级路径 → 负样本 3 条。
- 建议（供 lead 转给修复方）：降级路径的卡片地板应改读「分位数/相对 margin」而不是硬 cosine；或至少在 rerank 失败时把卡片上限压到 1 张并标 `unverified`。

### D3【S2】cards 与 transcript 不共用同一地板，且没有中间档

- 位置：`lib/policy.mjs:284-288`、`lib/inject.mjs:119-123`
- 现状分档：

  | 路径 | transcript 单元 | card |
  |---|---|---|
  | reranked | `rerankScore >= floorForAge`（desktop gate −1.0 / midGate −1.5） | 同左（card 的 rerankScore） |
  | degraded | `score >= rrfFloor()` ≈ 0.0163 | `similarity >= 0.35` |
  | 1 条候选（<2） | `rrfFloor()` | 0.35 |

- 后果：有 reranker 时卡片可以被正常打分（好），但 `/recall` 在测试进程里用默认 `gate=0` 时卡片与单元一起被 0 地板全拒（空召回）；没有 reranker 时卡片恒过、单元几乎必过（RRF 单臂 rank-1 恰好 1/61=0.01639，见 `lib/index.js:215-223` 注释）。**同一份 retrieve 在 rerank 有/无之间行为翻转，中间没有校准档**。
- 这与任务书 3e 的答案是同一个：「cards 与 transcript 不共用同一地板，也没有按类型分档」。

### D4【S2】没有 self-recall 排除

- 位置：`lib/index.js:182-190`（`retrieve(query, limit)` 只收 query/limit）、`lib/auto-recall.mjs:500-517`（entries 直接来自 `index.recall` 与 `cardEntries`，无 agentId 过滤）
- 检索结果里 `unit.session` 存在（`index.js:207`），但**没有任何一处把它与当前 `agentId` 比较**；唯一的去重是 `#consume` 的 `repeat-suppressed`（同一 payload 前 400 字符签名，`lib/auto-recall.mjs:732-742`），它防的是「重复注入」，不是「召回自己」。
- 影响：live index 是增量写入的（doctor：last written 1 min ago），当前会话近期刚产生的单元会进入候选池，并被当作「早前会话」注入。这条正好是 task-2 里「来自当前会话自身的比例」的机制解释。

### D5【S2】注入侧没有内容形态过滤（碎片过滤只在抽取侧且很松）

- 注入侧：`lib/inject.mjs:103-176`（`selectForInjection`）只做分数与预算，`renderRecall`（:207-）只做转义/frame；**没有** JSON 片段、裸路径、单行噪声、过短文本的判定。
- 抽取侧：`lib/chunker.mjs:24` `MIN_CHUNK_CHARS = 24`（很低）；tool 结果有 `classifyToolResult` 白名单（`lib/session-source.mjs:230-247`，file-read/json 拒绝），**user 消息没有对等物**。
- 现库形态（`/tmp/gm-unit-shape.mjs`，只读索引）：

  | 指标 | 数值 |
  |---|---|
  | user 单元 | 2765 / 41153 |
  | 字符数 p10 / p50 / p90 / max | 37 / 760 / 797 / 800 |
  | <24 字符 | 0（被 MIN_CHUNK_CHARS 拦住） |
  | <80 字符 | **588（21.3%）** |
  | <120 字符 | 720（26.0%） |
  | 单行单元 | 889（32.1%） |
  | JSON/数组开头 | 9 |
  | 纯裸路径 | 0 |
- 结论：**不是「完全没有碎片过滤」**（24 字符地板确实拦掉了纯噪声），但 24 这个地板对「碎片」这条指标几乎不起作用：每 5 条 user 单元就有 1 条短于 80 字符，且是单行；它们一旦被召回，注入侧不会再筛。

### D6【S2】telemetry 不记录注入内容的身份，无法事后定位

- `lib/auto-recall.mjs:996`：`record('inject', { chars, why, session })` —— 没有 `session#seq`、没有 `cardId`、没有 top1 分数。
- 有 top1 的是 `record('gate')`（`lib/auto-recall.mjs:557-565`，含 `top1/tier/reranked/kept/dropped/why`）；resident 有 `ids/scores`（`:419-426`）。
- 后果：事后问「这一条注入的是哪条记忆、它当时排第几」只能靠重放全日志（task-2 的做法），stats 本身答不了。这正是 `maintenance-20261020` 之后留下的诊断缺口之一。

### D7【S2】测试套件在真实部署上恒红 4 项，红了不知多久

- 位置：`scripts/test-plugin.mjs:475-482`（白名单未同步 `lib/tools.mjs:365-377` 的字段）、`:586-596` 与 `:981-1000`（依赖真实索引/重排分数）。
- 事实：CHANGELOG 0.12.0 记录「残留 4 个红灯与改动前逐条一致」；本次复跑仍是同样 4 项。也就是说 `npm test` 在这台机器上**从来不是绿信号**，而 CI（无索引、无 11436）会把相关检查 skip 掉 → 绿。「绿灯在 CI、红灯在真实环境」是守卫体系的结构性盲区：真正的部署行为没有一条自动化断言覆盖。

### D8【S2】两个 profile 的闸门配置漂移

- doctor config 原文：`declared in profiles: web judge=rules resident=true gate=3 | desktop judge=chat resident=true gate=-1.0`
- `~/.dsh/profiles/web/cordis.patch.yml:147-148` 仍是 `gate: 3 / midGate: 3`，而 desktop 是 `-1.0 / -1.5`（10-22 放宽）。
- 按 desktop profile 注释里自己的实测：「真实流量的 top1 全部落在 0.02-0.03，`gate: 3` 会砍掉 100%…gate: 0 放行 39/39」。web profile 的 3 是 10-13 之前的旧值，留到现在要么是「web 端记忆实际上被静默关闭」，要么说明该 profile 不在用（需 task-1 判断）。无论哪种，**配置漂移没有守卫**（doctor 只并列展示，不比较）。

### D9【S3】合成成功时原始证据被整体替换

- `lib/auto-recall.mjs:604-614`：`body = outcome.text` 后 `renderRecall([{role:'synthesis', ...}])`，selected 里的原文全部不进注入块；`lib/index.js:296-300` 的 `renderResult` 同理。
- 保护：`needsSynthesis` 要求 ≥2 条且分差 < 0.2（`lib/policy.mjs:258-266`），`isRefusal` 拒绝空答（`lib/synthesize.mjs`），注入标签写明 "synthesized answer, may be lossy"（`lib/inject.mjs:252`）。
- 风险：合成是 2B 模型（profile 注释：MiniCPM5-2B@8124），幻觉时**证据已不在注入块里**，模型只能看到失真的转述。属既有设计取舍，记录备查。

### D10【S3】doctor 自身的三个口径问题

1. `scripts/memory-doctor.mjs:642`：`process.exit(badCount > 0 ? 1 : 0)` —— 5 个 warning 时仍 exit 0，与文件头 "Exit code is 0 when nothing is wrong" 不一致（degraded 算不算「wrong」没有定义）。放进 cron 时只能靠解析 JSON 的 verdict。
2. config 区同时打印「declared in profiles: … gate=-1.0」与「policy gate/mid/margin = 0/-1/0」：后者读的是 doctor 进程自己的 env（读不到 profile），数字并列极易被读成「线上是 0」。
3. index 行 `model (unrecorded)`（doctor）与 audit 的 `model: embeddinggemma-2` 冲突：两脚本读的字段不同，doctor 这条 ok 实际没验证「索引模型 == 配置模型」——而 0.10.0 的头号教训正是「同维不同空间」。

### D11【S3】工作区与发布基线不一致

- `git status`：`M scripts/memory-doctor.mjs`（+271/−8，即 10-20 的 coldstart/judge 三检查），其余为未跟踪的 reports。
- `package.json` 仍是 `0.12.0`，而 HEAD 已含 `ea3e07c`（10-22，1648 行，新 `lib/exact.mjs` / `lib/timeline.mjs` / 三支测试）。审核对象「0.12.0 + 10-22 未发布改动」中，doctor 那部分**连 commit 都没有**，任何基于 git 的基线比对（如 CHANGELOG 里的 `git worktree` 做法）都不覆盖它。

### D12【S3】sourceKind 白名单的残余 fail-open 面

- `lib/session-source.mjs:215-220` 只从 `data.source` 取 kind；`isInjected`（:196-200）对「完全无 kind」返回 false（有意：实测 2615 条 user/message 全带 kind）。若 harness 将来把 kind 挪到事件顶层或改名，**整批消息会以 `sourceKind=null` 被当人收录**。
- 现有检测：`audit-index-sources.mjs` 的 `unlabelledUserRows` 会计数（三态里 unlabelled 单独列出，不算 PASS 的豁免——本次 0），但没有门禁/自动告警把「unlabelled 比例突增」变成失败。
- 任务 3f 的答案：**0.12.0 的白名单方向正确且覆盖了已知 14 种注入 kind**（含 tool-jobs / team-message / subagent-settled / compact-checkpoint 等）；未覆盖的不是某个已知 kind，而是「kind 位置/结构变化」这一类故障。

---

## 4. 任务 3 a–g 逐项结论

| 项 | 结论 | 依据 |
|---|---|---|
| a 碎片过滤 | **部分**。抽取侧有 24 字符地板 + tool 结果白名单；注入侧无任何形态过滤。user 侧缺 JSON/单行/裸路径判定 | `chunker.mjs:24`；`session-source.mjs:230-247, 473`；`inject.mjs:103-176`；现库 588 条 <80 字符 / 889 条单行 |
| b self-recall | **无排除**；来源缺失时用 `orphaned` 标 `unverifiable`（已有守卫） | `index.js:182-190, 207`；`auto-recall.mjs:500-517`；`store.mjs:341`；`inject.mjs:273-277` |
| c synthesized answer | 检索失败/不足时**不注入**（needsSynthesis 需 ≥2 条；全 drop 时不合成；isRefusal 拒绝）；但合成成功时**替换**原文 | `policy.mjs:258-266`；`auto-recall.mjs:598-614`；`index.js:296-300` |
| d 首轮 | resident 命中即返回；**未命中则继续跑 judge + 全库检索**（含 embed/recall/rerank） | `auto-recall.mjs:402-437`（return 在 payload 非空分支）→ 继续 `:440` 之后的 judge 与 `:500` 之后的检索 |
| e gate 分档 | cards 与 transcript **不共用**；reranked 时两者共用 rerank score，degraded 时 card 用 0.35 / unit 用 rrfFloor()；无中间档 | `policy.mjs:281-288`；`inject.mjs:119-123`；见 D1/D3 |
| f sourceKind | 白名单（只有 user 算人）覆盖已知 kind，方向正确；残余风险是 kind 位置变化导致批量 null，只可事后审计 | `session-source.mjs:155-220`；audit 实测 PASS |
| g telemetry | gate 有 top1/tier/reranked/kept/dropped/why；resident 有 ids/scores；**inject 无内容 id、无 top1** | `auto-recall.mjs:557-565, 419-426, 996` |

---

## 5. 已有守卫 vs 缺失守卫

**已有（本轮实测有效的）**

| 守卫 | 位置 | 本轮证据 |
|---|---|---|
| sourceKind fail-closed 白名单 + EXTRACTOR_VERSION | `lib/session-source.mjs:155-200` | audit：0 injected / 0 unverified / 2764 user 全带 kind |
| 审计三态（pass/fail/unverified） | `scripts/audit-index-sources.mjs` | PASS |
| prune 从日志反推、dry-run | `scripts/prune-injected-rows.mjs` | 4201 哈希 / 0 行 |
| 注入 frame + 转义 + 控制字符中和 | `lib/inject.mjs:60-96, 207+` | test-plugin 5 项渲染断言全绿 |
| 长度地板 + chunk 上限 | `lib/chunker.mjs:18-24` | 现库 <24 字符 0 条 |
| tool 结果白名单（file-read/json 拒绝） | `lib/session-source.mjs:230-247` | 索引 tool 行 26396，无 blob 主导 |
| repeat-suppressed / carry-over TTL | `lib/auto-recall.mjs:732-742, 680-700` | doctor：38 carried，49 lost 分开计数 |
| rerank minScore 解析缺陷回归 | `lib/index.js:249-265` | test-plugin 两项 gate 断言全绿 |
| synthesis 拒绝协议 | `lib/synthesize.mjs` / `isRefusal` | calibration 22/22 |
| doctor 七域三态 + 三态 skip | `scripts/memory-doctor.mjs` | degraded 正确报出 5 项 |
| 标定门 22 例全过 | `npm run eval:calibration` | 22/22 |

**缺失（本轮定位的）**

| 缺口 | 对应缺陷 | 影响面 |
|---|---|---|
| 卡片 cosine 地板的回归测试/重标定脚本 | D1 | 降级路径误召回（S1） |
| rerank 失败时的收紧策略（当前为放宽） | D2 | 与冷启动耦合（S1） |
| self-session 排除 | D4 | 自我召回（S2） |
| 注入侧内容形态过滤（user 侧） | D5 | 碎片注入（S2） |
| inject 事件的内容身份 | D6 | 诊断不可复现（S2） |
| 真实部署上的自动化断言（CI 绿/本地红） | D7 | 守卫失效（S2） |
| 跨 profile 配置一致性检查 | D8 | web/desktop 闸门漂移（S2） |
| 「kind 位置变化」的自动门禁 | D12 | 静默 fail-open（S3） |

---

## 6. 建议的修复优先级（供 lead 汇总）

1. **（S1）重新标定卡片地板**：用 `/tmp/gm-card-sim.mjs` 的方法在现库上跑「可答/不可答」两组的 cosine 分布，把 `cardMinSimilarity` 改成当前模型下的分位数（实测下界 0.58 意味着应设 ≥0.62-0.65）或改判相对 margin；同时在 `test-policy.mjs` 加一条「随机 token 不得有卡片通过」的断言。若不改阈值，至少在 rerank 失败时把卡片上限压到 1 并标 `unverified`。
2. **（S1/S2）把降级路径的方向改成收紧**：rerank 不可用 → 卡片只保留 top1 且需 `similarity >= 当前分位`；单元保持 rrfFloor（已验证不会误伤）。
3. **（S2）补 self-recall 排除**：`retrieve` 增加可选 `excludeSession`，自动路径传 `agentId`；注意 `unit.session` 与 `agentId` 的格式需对齐（`auto-recall` 里 `String(agentId).slice(0,16)` 的截断习惯可能不够）。
4. **（S2）inject 打点加 `ids` 与 `top1`**（沿用 resident 的 `ids/scores` 格式即可）。
5. **（S2）修复 4 个已知红灯**：至少把 `test-plugin.mjs:475-482` 的白名单改成与 schema 同源；把依赖真实分数的两项明确标 `skip`（或移到 `test:live`），让 `npm test` 在真实部署上也能作为门禁。
6. **（S2）web profile 的 gate=3 要么改成一档，要么在 doctor 里做跨 profile 比较并报 bad**。
7. **（S3）doctor 三处口径**、**提交 doctor 的 271 行改动并 bump 版本**。

---

## 附录 A：复现脚本（只读，均指向 /tmp，未写生产统计）

- `/tmp/gm-repro.mjs`：用 fake Cordis ctx 调 `plugin.apply` + `memory_recall.execute`，打印返回键、负样本 found 数、`/recall` 结果。隔离 `DSH_G_MEMORY_AUTO_STATS` 到临时目录。
- `/tmp/gm-card-sim.mjs`：`readCards` + `cardEntries`，对 4 条查询打印通过 0.35 的卡片数与 top-1 similarity。
- `/tmp/gm-unit-shape.mjs`：`readIndex`，统计 user 单元长度分位、短碎片率、单行/JSON/裸路径占比。

## 附录 B：命令清单（只读）

```
npm run test:unit
npm test
node scripts/memory-doctor.mjs --json --days 7
node scripts/audit-index-sources.mjs
node scripts/prune-injected-rows.mjs --dry --json
npm run eval:calibration
git log/show/blame/diff/status
```
