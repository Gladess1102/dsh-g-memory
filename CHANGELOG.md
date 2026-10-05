# Changelog

## 0.9.1 — 2026-10-06

**CI 抓到一个我自己藏起来的缺陷：新写的蒸馏循环测试不是 hermetic 的。** 同一份提交在 macOS 上全绿，在 Ubuntu / Node 20 上 `expected one card, got 0`。第一次失败只说"0 张卡"，所以先补可观测性，再顺着它找到真因。

### Found — 循环测试连的是真模型，不是那个 stub

`embedder.mjs` 里 `DEFAULT_EMBED_CONFIG` 是**模块加载时求值**的常量：

```js
export const DEFAULT_EMBED_CONFIG = { url: process.env.DSH_G_MEMORY_EMBED_URL || 'http://127.0.0.1:11439', … };
```

测试在第 206 行才把 `DSH_G_MEMORY_EMBED_URL` 指向自己的 stub，而第 24 行的 import 早已把 URL 冻成真实的 `127.0.0.1:11439`：

| 环境 | 现象 | 真因 |
|---|---|---|
| 开发机 | ✅ 通过 | 11439 上真的跑着 embed-gemma：循环连到**真模型**、拿到真向量、卡片照写不误 |
| CI | ❌ 0 张卡、3 次到重试上限 | 11439 无人监听 → `unreachable`（可重试）→ 3 次后放弃 |

README 承诺的 "no network, no models" 被这个测试自己破坏了：它在**恰好装了模型的机器**上通过。这类"只在本机成立"的检查比没有检查更糟——它给绿灯。

### Fixed

- `resolveConfig()` 改为**每次调用读环境**（新的 `defaultEmbedConfig()`）。那个"名字听起来是活的、实际是快照"的 `DEFAULT_EMBED_CONFIG` 常量被移除（模块外无人引用它）。
- 循环测试的 stub 现在统计 `/embeddings` 请求数，并**断言它大于 0**：循环必须走 stub。变异测试（把配置改回"首次调用时冻结"）确认这条守卫会失败——**在开发机上也会失败**，而旧的"卡片数量"断言在本机永远抓不到。
- 保留上一次提交补的可观测性：用 `transcriptFor` 的同一表达式发现夹具、断言 200 字符下限、把 `consolidate-result` 的 `reason` 写进失败消息。正是它把"0 张卡"缩小到了嵌入这一步。

### Known — 同一形状还有两处（本轮未改）

`DEFAULT_RERANK`（`rerank.mjs`）与 `DEFAULT_SYNTHESIS`（`synthesize.mjs`）同样是模块级读环境变量。它们在生产里由配置显式传入，且其常量被测试当作**值**使用（`test-plugin.mjs` 断言 `resolved.minScore === DEFAULT_RERANK.minScore`；`test-synthesis.mjs` 用 `DEFAULT_SYNTHESIS.baseUrl` 决定是否跳过实网部分）。记录在案，改动面与风险另行评估，不混进这次修复。

## 0.9.0 — 2026-10-06

**本轮的主题不是新功能，而是"一个说自己完成了、其实从没跑过的层"。** 耐久卡片（consolidation → cards）是 0.4 起就宣称的能力，实测**在生产里一次都没跑成**，而且沿途三个缺陷每一个都足以单独让它静默；同一轮里增量索引还有一处"把丢弃的单元标记为已处理"的水位错误。修完之后才做了 0.8.0 记录在案的那个结构性缺口（索引不收 tool 参数）。

### Found — 卡片层在生产里从未运行过（三个独立成因）

翻 `cards.ndjson`：57 张卡片里 **55 张是 `memory_note` 手记，只有 2 张来自会话蒸馏**，且都停在 2026-09-23。遥测 `auto-recall-stats.jsonl` 里 **一条 `consolidate` 事件都没有**。逐层查下去：

| # | 成因 | 证据 | 修法 |
|---|---|---|---|
| 1 | **接线处丢配置**：`index.js` 构造 `AutoRecall` 时没传 `consolidate` | 与代码注释里记为已修的 `rerank`/`policy` 完全同类缺陷，第三次出现 | 抽出 `autoRecallOptions()`，并加测试断言"AutoRecall 读的每个 key 都被传入" |
| 2 | **v4 会话日志读不到**：`transcriptFor` 只认 `session.jsonl.zstd` / `session.v3.jsonl.zstd`，而 DSH 0.1.7 起写 **v4** | 机器上 36 个 v4 日志，蒸馏一律拿到空字符串 | 改用索引层同一份 `listSessionLogs()` 发现日志（v4 + 同目录取最高版本）；测试用真 zstd 帧同时放 v3/v4，验证不会读到冻结的 v3 前缀 |
| 3 | **关着与没活儿干无法区分**：`shouldRun()` 返回 `disabled` 时 tick 直接 return，不写任何遥测 | 一周零事件、零日志、零卡片，所有健康信号全绿 | 关闭时进程内记一条 `consolidate-skip`；"读不到日志"改为**失败**（保留材料、有界重试 3 次），"转录太短"仍算成功但写回执 |

第 2 条的真正教训：**发现日志这件事有两份实现，就会漂移**。索引层早就学会了版本规则（0.1.7 那个 bug），蒸馏层自己抄了一份文件名列表，于是再次踩同一个坑。

### Found — 被写错 role 的单元永远不会自我修复（复核者发现，我漏了）

去重只按 `contentHash(text)`——**hash 覆盖文本，不覆盖 role**。所以一条 role 被写错的单元不会自愈：之后每一次重扫都在 hash 上命中并跳过它，错误的 role 跟着每一次重建活下来。这不是假想：**索引被一个 role 白名单里还没有 `action` 的版本读回时，那些单元会被改写成 `tool`**，而"这是过去的一次工具调用"还是"这是对话"恰恰是注入时告诉模型的那句话。

线上实测（我的重扫之后）：索引里 `"role":"action"` 出现 **0 次**，而有 699 条的正文以 `[write] `/`[edit] `/`[str_replace_editor] ` 开头——文本还在（所以检索与那两条治理用例照常通过），**role 被正在运行的旧进程洗掉了**，而重扫救不回来：它恢复文本，恢复不了 role。

修法：一轮里把"已知 hash"从 Set 换成 `Map<hash, unit>`，重读时若同一 hash 的 role 与日志推导出的不同，就**就地把该行改对**；这类修正单独计数（`relabelled`），因为它必须触发一次落盘，却又不能在遥测里伪装成"新增 0 个单元"。回归测试模拟完整现场：先建索引，再把 role 洗成 `tool`，再抹掉 progress 里的 `extractor` 字段（旧进程正是这么干的）→ 断言重扫后 role 回来且**没有重复单元**。

在被洗过的真实状态上端到端验证（线上索引的副本）：**一次重扫修正 1,799 条 role、新增 81 个单元、耗时 8.3 秒**——重读本身很便宜，此前那次 185 秒几乎全花在嵌入上（因为要新增 1,995 个单元）。

这条也修正了本轮对 extractor 版本机制的描述：**版本失效触发的是"重读"，而重读现在同时修复文本与标签**，不只是补新单元。

### Found — 增量索引会把自己丢弃的单元标记为"已处理"

`LiveIndex.runOnce()` 每轮有 `maxUnitsPerTick` 上限，但这个上限会**落在单个日志内部**。原实现在触顶后仍然把该日志的水位推进到日志末尾、mtime 更新为当前值——于是那些没被取走的单元**永远不会再被读**，且下一轮因为 mtime 未变而直接跳过。

复现（3 个日志 × 4 单元，上限 2）：索引停在 **4/12 且永不收敛**。修法：被截断的日志保留旧水位（停在实际取走的最后一个单元的 seq）**并保留旧 mtime**，下一轮从断点续读。同一轮里加测试，改回旧行为立刻失败。

这个缺陷在本轮之前就存在，而本轮的 authoring 改动会让单日志产出的单元数大增，因此必须一起修。

### Added — 索引 tool 的参数（`write`/`edit` 写下过什么）

0.8.0 记下的结构性缺口：**索引收 tool 的结果，不收 tool 的参数**，于是 agent 用 `write`/`edit` 写下的代码除非被某次 `read`/`grep`/测试输出回显，否则根本不进记忆（实测 `supersededBy` 在 19,818 个单元里出现 0 次）。

规则是**按形状识别而不是按工具名**：参数里有"路径"字段 + "新文本/被替换文本"字段即为 authoring 记录。实测在 13,227 次真实 tool 调用里，这条规则恰好只放行三种：`edit`(669)、`write`(306)、`str_replace_editor`(32)，共 1,007 次（其余 12,220 次正确排除）；`read` 有路径无文本、`run_code`/`cordis_define` 有文本无路径、`present` 的路径嵌在数组里。

仓库自己写的渲染进索引：`[write] /path` 抬头 + 内容；`edit` 渲染成 `- 旧` / `+ 新` 的 diff（被删掉的文本只有这里有）。上限 8,000 字符（实测保留 94% 的调用，截断 45 次），防止一个压缩过的 bundle 整份进索引。

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 采样窗口能在索引里找到的比例 | **6.7%** | **97.1%** |
| 整条调用「完全找不到」的比例 | **71%**（714/1,004） | **1%**（9/1,004） |
| 索引文本 | 11,849,211 字符 | 13,668,835 字符（**+15.4%**；其中 authoring 1,661,862 字符 = 1.58 MiB，1,752 个单元） |
| 0.8.0 里标为「结构性无解」的两条治理用例 | **0/2** | **2/2**（`supersededBy` 到 rank 12） |
| 标定集（20 条回归门） | 20/20 | **20/20（无回归）** |

**新增一个来源标签**：注入文本里每条记忆都带来源标签（"transcript excerpt" / "written memory" / "synthesized answer" / "unverifiable"），footer 逐条解释它们。authoring 单元如果沿用 "transcript excerpt"，模型就可以把 `+ const x = 1` 读成"这个文件现在是 x = 1"——**而那是历史**：文件可能早已被改写或删除。现在它有自己的标签 `authored change, verbatim — the file may have changed since`，被撤回的源日志时两个事实同时出现（`…; unverifiable (source deleted)`）。一个错的记忆比没有记忆更糟，所以这条不是文案问题。

**两处蒸馏转录都显式排除 authoring 内容**（`transcriptFor` 与 CLI 的 `sessionText`）：蒸馏提示词有 12,000 字符上限，而一个会话可以写下 200 KB 代码——放进来会把"决定了什么、否决了什么、还悬着什么"挤出去。口诀：**索引记住写了什么，卡片记住决定了什么**。

**extractor 版本号**：水位只对产生它的抽取规则有效。新增 `EXTRACTOR_VERSION`，水位文件记下它，不匹配时下一轮从事件 0 重扫——是**重读而不是重嵌入**，单元按内容 hash 去重，只有真正的新文本花向量。实测（在索引副本上做验收）：105 个日志、6 轮有界处理、185 秒、+1,995 单元，其中 authoring 1,752。随后对**线上索引**执行同一操作：106 个日志、7 轮、188 秒、20,143 → 22,414 单元（authoring 1,783），标定集仍 20/20，两条治理用例 0/2 → **2/2**。

### Added — 评测开始覆盖卡片层

评测此前只对索引 unit 文本判定，而两条生产路径（`memory_recall` 与自动召回）都是把卡片和单元放进**同一个池**再一起重排。现在判定同时看两层，`--no-cards` 可复现旧口径。实测：当前 22 条用例两种口径同分（标定 20/20、前沿 0/2），即**今天没有"只有卡片能答"的用例**——这个改动是让尺子量对池子，不是让分数变好看。

### Fixed — 记忆闸门的注释把"主题过滤"说成了"可答性过滤"

`inject.mjs` 里"0 of 8 unanswerable queries clear it"来自一个**全部离题**的负例集，不能外推。在 57 张卡上重测：13 条离题查询 0 条被放行（95% 置信上界 22.8%，样本薄，已标注），但 6 条**同主题却答不了**的问题放行 4 条，其中一条相似度 0.4606——比 12% 的正例还高。注释已按实测改写：这个预过滤买的是"别把无关卡片塞进交叉编码器批次"，买不到"同主题的卡不会被注入到它答不了的问题上"。

### Measured — `cardMinSimilarity = 0.35` 在 57 张卡上重测：维持

0.8.0 遗留项"0.35 是在 15 张卡上测的"。57 张卡重测：正例 57 / 负例 13 / 边界 6。

| 阈值 | 正例过闸 | 真正注入 | 负例误放行 | 正例平均进批卡数 |
|---|---|---|---|---|
| 0.30 | 56/57 | 53/57 | 0/13 | 5.86 |
| **0.35** | **54/57** | **52/57** | **0/13** | **3.95** |
| 0.40 | 50/57 | 49/57 | 0/13 | 2.07 |
| 0.45 | 46/57 | 45/57 | 0/13 | 1.16 |

15 张卡时最坏负例 0.276，57 张卡时 **0.2724**——库容涨 3.8 倍而天花板没动，0.35 仍落在"负例全挡、正例基本全放行"的位置。降到 0.30 只多救回 **1 条实际注入**，却把最坏负例上方的余量从 +0.0776 砍到 +0.0276，并在重排器可用时把进批卡数抬高 48%（纯成本）。**不改。** 另有一个正交发现：`maxEntries = 3` 是比阈值更硬的帽子——名次第 4 的卡在四个阈值下都过闸，却永远进不了注入。

### Meta — 本轮又有两次「验证性检查本身没被验证」，以及一次被复核者救回的高危缺陷

**独立复核（子代理，对抗性）的收获**：它抓到一个我漏掉的高危项（被写错 role 的单元永不自我修复，见上），并指出 `distill` 的"找不到日志"分支**没有任何测试保护**——它把那段变异成静默 `continue` 后，测试仍然 45/45 全绿。这正是"三成因里第二条的修复无人守"。两处都已修并各有会失败的测试。

它还纠正了我的**语料口径**：我此前统计 authoring 调用时走的是"遍历所有日志文件"，把同一段对话的冻结 v3 前缀与 v4 正文**数了两遍**；索引实际读的是 `listSessionLogs`（每个会话目录只取最新版本）。按正确口径重测后，正文里的数字全部改写为 1,004 次调用 / 2.45 MiB / 6.7% → **97.1%** / 「完全找不到」71% → **1%**（原为 1,015 / 2.48 MiB / 98.9% / 0%）。结论方向不变，但数字必须能复现。

它同时**核实为不成立**的一条：`autoRecallOptions` 不传 `synthesize` 并不构成半旋钮——composition 的 `synthesis.enabled` 由 `synthesize()` 内部读取，关闭是生效的；`synthesize` 是程序化开关，schema 里没有对应键。

而我自己的度量仍然错了两次，且都是**新写的度量**：

1. **回声率度量 v1**：shingle 集合按 20 字符步长建、探针落在任意偏移——**20 个探针里 19 个按构造不可能命中**。一条自证逐字存在于索引里的单元，自回声只有 **0.096**。它给出的"2.3%"是错的（被压缩约 20 倍）。
2. **回声率度量 v2**：探针自己拼渲染文本，忘了 `- `/`+ ` diff 前缀，于是**每一条 edit 都看起来没进索引**。

v3 改为直接 import 被测的 `renderAuthoringCall()` 并用 `includes` 精确询问，才得到上面 6.7% → 98.9% 那组数字。教训与 0.8.0 相同但更强：**度量必须调用被测代码，而不是它的一个复述**；以及**在下结论前，先用一个已知答案喂给度量**（"这条单元自证在索引里，回声率应当是 1.0"）。

### Fixed — 独立复核提出的另外三处（D1/D3/D5）与两处口径修正（D4）

| # | 缺陷 | 复核者的证据 | 修法 |
|---|---|---|---|
| D1 | **extractor 标记会被旧进程抹掉，导致每一轮全库重扫**：我把标记写进了 `.live-progress.json`，而那个文件是"读-改-写"的——一个未加载本轮代码的进程（symlink 挂载下滚动重启时是常态）每轮都会用自己认识的字段重建它，标记被丢掉，下一轮又判定"版本未知"→ 重扫。实测：标记被抹后**每轮 `sessions=40`**（40 个日志），每轮 3.1 秒，且 `fresh=0` 的轮次**不写遥测**，所以完全静默 | 线上采样 6 次，`.live-progress.json` 的 `extractor` 恒为 `undefined` | 标记移到**只有本代码会写的独立文件** `.live-extractor.json`；顺带修掉 `#readProgress` 用模板重建对象（会丢弃一切未建模字段）的形状 |
| D3 | `build --no-tool-calls` **不缩索引，反而把活着的源标成"源已删除"** | 实跑：先 build（`action 1`），再 `--no-tool-calls` → 打印 `[orphan] 1 units kept from sessions that no longer exist on disk`，该行变成 `orphaned: true`，注入标签多出 `unverifiable (source deleted)` | 被本次显式排除的类别**丢弃并单独报告**（`[skip] … a normal build brings them back`），不再走 orphan 结转。实测：开关后索引只剩 user 单元，再跑正常 build 恢复 |
| D5 | `transcriptFor` 改用共享 `listSessionLogs` 后**丢了"不跟随符号链接"这道守卫**（旧实现显式跳过，`bin` 的 walker 也跳过） | 建一个指向 home 之外的 `session.v4.jsonl` 符号链接 → 照样被返回 | 在 `listSessionLogs` 里恢复 `entry.isSymbolicLink()` 跳过 |
| D4 | **前沿集已经被本轮自己清空，文档却还说 0/2** | `--cases cases.challenge.json` 现在 2/2 | 两条治理用例**升入回归门**（现 22 条，实测 22/22），`cases.challenge.json` 置空并在 README 写明"空是一个结果"；评测脚本对空集合给出明确说明而不是报错 |

**另外两处口径修正**：`npm run eval:calibration` 现在固定 `--no-cards`——标定集 20 条里有 9 条也能从卡片答出，而卡片库是本机数据、随使用漂移，门必须可复现（unit 层的回归可能被"恰好能答"的卡片掩盖）；`eval` 的汇总行在只有单元层时如实写 `(units only)`。

### Found — 「失败保留、最多重试 3 次」这个机制对最常见的失败没生效

0.8.0 记的修复是"蒸馏失败不再永久丢材料：`pick()` 改为预留，调用方 `settle(ids, failed)` 成功清空、失败保留并计数，3 次为上限"。写集成测试时才发现**那条路只有抛错才走得通**：模型不可达、HTTP 5xx、空回、解析不出卡片、写盘没落盘——这些在 `consolidateSession` 里都是**返回值**（`{stored:false, reason}`），不是异常，于是 `distill` 把它当成"处理完了" → `settle` 走成功分支 → 会话材料被清空且不再重试。也就是说，模型宕机这个最可能发生的失败，恰好是唯一不被重试的那个。

修法是让两种失败可区分：`consolidateSession` 现在返回 `retryable`——只有「转录太短」是 `false`（同样的日志下次还是一样短），其余（不可达 / HTTP 失败 / 空回 / 无可用内容 / 未落盘）都是 `true`；`distill` 对 `retryable !== false` 的失败保留材料并计入尝试次数，仍受 `maxAttempts = 3` 约束。测试同时断言两半：**失败必须被重试（≥2 次）**，且**重试必须停下（≤3 次）**。

### Added — 蒸馏循环的集成测试（此前完全没有）

`consolidateSession` 有单测，tracker 有单测，**两者之间的循环（`attach()` 的 tick：pick → distill → settle → markRun）一行测试都没有**——而本轮修的三个成因全都在这个循环的接线里，任何 `consolidateSession` 的单测都不可能抓到它们。现在补上：临时 DSH_HOME + 桩模型/桩嵌入端点，从**真实的 inbox 事件**进入（不是直接调 `note()`，因为把会话挡在 `note()` 之外的那道闸门正是要点），跑多个 tick，断言：卡片真的被写出来（并带着模型给的内容与会话名）、成功会话不会被重复蒸馏、失败会话被重试且停在 3 次、`consolidate-state.json` 落盘。

过程中夹具两次骗过我：一份 166 字符、一份 184 字符的转录都低于 `consolidateSession` 的 200 字符下限，于是"测试"从头到尾没碰到模型，而是安静地走了「转录太短」分支。两处都已加长，并把原因写在夹具旁边。

### 复核者列出的 9 个漏网变异，现已全部有守卫

M3（标记不落盘）、M29（重扫用了当前 mtime）、M11（上限夹具自我去重）、M16（关闭时不记录）、M20（接线丢配置复发）、M22（`settle` 失效）、M23/M24（两个工具开关互相吞并）、M25（`fromSeq` 失效）——逐一补测并逐条变异验证：**改坏即变红**。

其中 M11 值得单独记一笔：原来那条"超大写入不会灌爆索引"的断言用的是 `'x'.repeat(200_000)`，而重复字符被 chunker 修剪、被 hash 去重后只剩约 3.9 KB，所以**把 8000 字符上限整个删掉它照样通过**。换成伪随机内容后同一断言才有意义（有上限 8.7 KB / 无上限 222 KB）。

### 另外两条空转点（复核者列的变异 M22/M25）已封

- **M25（`fromSeq` 失效）**：原有测试只看"最终有哪些单元"，而忽略水位时整份日志重读的结果集合完全相同（旧单元按 hash 去重）。新测试先把索引里的一个单元删掉、再追加一条事件，断言那一遍**只取新事件**、被删的单元不会复活。
- **M22（`settle` 失效）**：复核者描述为"每 tick 重复蒸馏、烧模型调用"，实测并非如此——`pick()` 会跳过 `picked` 仍为真的条目，所以去掉 `settle` 的后果是**该会话从此再不被蒸馏**（静默丢失，直到进程重启）。测试按真实不变式断言：失败要回来、且必须停下。

### 上线动作（重要）

插件在本机是通过 symlink 挂载的（`profiles/*/node_modules/dsh-g-memory → local-keep/dsh-g-memory`），所以**旧进程不清掉，新旧代码会共用同一份索引与水位文件互相拉锯**：旧进程每次落盘都会把 `action` 洗成 `tool`（它的 role 白名单里没有这个值），而新进程只在重扫时修得回来。复核者在线上观察到的正是这个拉锯（00:07 `action 1783` → 00:15 `action 0`）。

所以：**重启所有 DSH 进程**。重启后第一次 live pass 会因为没有 `.live-extractor.json` 而重扫一遍（实测：106 个日志、8.3 秒、修正 1,799 条 role、新增 81 个单元，不重嵌入），此后 role 不再被改写。卡片蒸馏的开关已在本机 profile 里打开，重启后满足闸门（≥5 轮、单会话 ≥3 轮且空闲 ≥10 分钟、距上次 ≥24h）才会蒸馏出第一张卡——第一个跑通的会话会出现在 `~/.dsh/dsh-g-memory/receipts.ndjson`。

### 仍未处理（留待判断）

- 蒸馏总开关仍是**默认关闭**（要花模型调用）。本机是否开启是部署决定，不是代码问题。
- `cordis_define` 写下的插件代码仍不进索引：它没有路径字段，一条来自它的记忆说不清"关于什么"。
- shell 命令（+4.0 MiB）与 `run_code`（+6.9 MiB）仍在索引之外。
- 卡片数超过约 150 张、或负例集扩到 ≥40 条时，应重跑一次阈值测量；在那之前动 0.35 属于噪声操作。

## 0.8.0 — 2026-10-06

**Added — 记忆治理层：能改、能过期、能忘**

在此之前这个插件**只会加**。被更正过的事实和它的更正并排躺在库里，可信度一模一样；而且没有任何办法撤回一条记忆 —— 一个只会增长的记忆系统，记得越多就越错。

- 三种生命周期状态，能推导就不落盘：`expired`（过 `expires` 日期）、`superseded`（被新卡片取代，`supersededBy` 指向接班人）、`retired`（被 `memory_forget` 撤回，留作证据）。`retired`/`superseded` **优先于**过期 —— 一条既被撤回又已过期的记忆仍算撤回，否则会丢掉它消失的原因。
- `memory_note` 新增 `supersedes`（id / id 前缀 / 摘要片段）与 `expires`（`YYYY-MM-DD`，按当日 23:59 计时，不会在零点突然失效）。
- **自动取代是不做的**：两张记忆长得像不等于一张更正了另一张，而错误的取代不可恢复。系统只把近似项作为 `overlaps` **提出来**，由写入者决定。
- 新增工具 `memory_forget`：按 id 或按查询撤回一条记忆。默认 retire（留证据），`hard: true` 才真删；引用有歧义时**报告候选而不是猜**。
- 注入只看见当前记忆；**显式召回看得见全部并带标签** —— 被更正的事实到来时带着它的更正痕迹，而不是冒充最新结论。四种状态都进了决策日志。

**Fixed — 三个 bug**

- `memory_note` 一直在返回 `duplicate: true`，而输出 schema 没声明它 → **工具边界把它丢了**，模型从不知道"这条已经记过"。同一类问题（schema 未声明字段）此前在 `source`/`orphaned` 上已经犯过一次。
- 引用解析的长度门槛按**字符数**算，把「索引压缩」这种 4 个汉字的引用判为太短。CJK 字符现在按双字重计 —— 这个库大部分是中文，被拒的恰好是人真正会输入的引用形式。
- 早上给构建加锁时，我把 `appendFile` 从 fs 导入里换掉，却漏了它仍在**恢复检查点**路径上使用 → `[resume] could not write the checkpoint tail: appendFile is not defined`，被 try/catch 吞掉，静默了一下午。已修，并在 `test-incremental-build` 加了"构建不得吞掉错误"的断言（构建输出出现 `could not write` / `is not defined` 即失败）。

**Added — 评测分成"门"与"前沿"两档**

按 Agent Memory Leaderboard 的能力模型（召回／治理／安全执行）扩建了标定集：8 → 22 条，覆盖多跳组合、时间序列、治理维度。

- `scripts/cases.calibration.json`（**回归门**，100% 要求）：**20 条**，全部实测通过。
- `scripts/cases.challenge.json`（**前沿度量**，`npm run eval:challenge`）：未过的用例，附成因。一条永久红的门会没人看，而这些用例的价值恰恰是把短板说准。
- `scripts/cases-personal.local.json`：涉及机器主人私人笔记的用例，**刻意不进仓库**。

**Found — 两个结构性发现（都是评测口径暴露出来的）**

1. **评测只看三层架构的中间层**：判定只针对索引 unit 文本，卡片层不参与评分。而卡片层恰好有措辞完美的答案 —— 这个评测**低估**了产品真实召回能力。
2. **索引收 tool 的结果，不收 tool 的参数**：agent 用 `write`/`edit` 写下的代码，除非被某次 `read`/`grep`/测试输出回显，否则根本不进记忆（实测：`supersededBy` 在 19,818 个单元里出现 **0** 次）。两条治理用例因此**结构性无解**，已如实标注而不是当成检索失败。

## 0.7.0 — 2026-10-02

一周真实使用后的验收快照。这一版的重点不是新算法，而是**让系统在没人管的情况下保持正确**。

**Added — CI（真跑严格测试，不跳过）**

- `.github/workflows/test.yml`：Node 20/22 上跑完整链，`DSH_HOME` 指向临时目录。
  驱动真 Harness 的两段（JSON-schema 校验器、Cordis loader）**照常运行** —— CI 先把它们
  真正加载的两个包装到 `.harness/`（`@deepseek-ai/dsh-tools` + `@deepseek-ai/cordis`，
  约 11 秒），再用 `DSH_CHECKOUT` 指过去。完整 `@deepseek-ai/dsh` 应用包 506 MB，测试链
  一行都不需要它。
- 顺带修掉一个既有缺陷：loader-contract 测试拿 `findCordis()` 与 `null` 比较，而它返回
  `undefined` —— 那段"Cordis 未找到"的兜底**是死代码**，在没有 DSH 的机器上会直接崩在
  `pathToFileURL(undefined)`，而不是给出解释。

**Fixed — 一个把我引到错路上的测量伪影**

接线 CI 时我一度断定"官方包装不上"，并据此写了"CI 只能跳过严格测试"的设计，还写进了
README 与 CHANGELOG。**是错的**：`/tmp/package.json` 里有一个早先留下的 fixture，它的
`name` 正是 `@deepseek-ai/dsh-desktop-runtime` 且依赖未发布的 `dsh-desktop-host`；npm 会
**向上查找 package.json**，于是我在 `/tmp` 下的每次安装都被它劫持，404 的是我自己的文件，
不是 registry。换到 `$HOME` 下：两个叶子包 11 秒装好，完整包 2 分钟装好（538 个包）。

教训（已固化为规则）：**在 `/tmp` 里跑 `npm install` 之前，先确认上层没有 package.json**；
以及"装不上"这类结论必须换一个干净目录复现一次再写进文档。

**Added — 索引自己跟着会话走（不再需要手动构建）**

一周验收发现：索引只在手动跑 `build` 时长，实测**一周没人跑 → 19 个会话 / 17 MB 内容不在索引里**，
而所有健康信号都是绿的（转录层会静默陈旧）。

设计与依据（读源码而非猜测）：

| 参考 | 做法 |
|---|---|
| **VCP 上游** `KnowledgeBaseManager.js` | `chokidar` 监听 + **1 秒批处理窗口** + **每路径 generation 去重** + 延迟落盘 + **启动后追赶刷新**；只有引擎签名变化才全量重建（没有任何定时全量） |
| DSH 生态 `dsh-mnemon`/`dsh-mnemosyne`/`@openviking/dsh-memory-plugin`/`dsh-experience-memory` | `session/event` 捕获 + `agent/turn-stopping`/`session/disposed` 收尾 + `agent/pre-step` 召回，重活防抖 |

dsh-g-memory 采用同样的形状，但落在自己的架构上：

- **触发**：`session/event` 收到 `turn/end` 时只置一个布尔（热路径零 I/O）；`session/disposed` 同样；
  30 秒防抖 tick 干活；启动后 15 秒追赶一次
- **工作量**（关键）：只读**日志 mtime 变过**的会话，且只取**水位之后**的事件（`seq` 单调，水位精确）；
  首次运行从索引自身的 `builtAt` + 每会话已入库的最大 seq**播种**水位，不重扫已覆盖的内容
- **写盘**：仍是单文件索引，压缩级别 `-19 → -9`（实测同体积，**12.5 秒 → 0.45 秒**）
- **安全**：与手动构建**共用锁文件**；模型不匹配时暂停而不是混向量空间；嵌入失败不写半截索引、
  水位也不前进；每轮有单元数与时间预算；任何异常都不进回合

**实测（真实生产索引）**：播种 102 个会话 → 首次只读 2 个变化会话、+66 单元、6.5 秒；
**无变化时 233 毫秒**（全量重建 33 秒，便宜 **140 倍**）。新增 `scripts/test-live-index.mjs`（12 项）。

配置：`liveIndex.{enabled, debounceMs, quietMs, maxUnitsPerTick, budgetMs}`，
环境变量 `DSH_G_MEMORY_LIVE*`。手动 `build` 仍然保留（全量/换模型/压缩整理）。

**Fixed — 自检发现的两处（第五轮）**

- **工具的来源标签在边界上丢失。** `memory_recall` 的渲染层从工具自己的输出重建条目，
  而输出 schema 里没有 `source` / `orphaned`（`additionalProperties: false`，没声明就
  到不了）——于是**用户手写的卡片被呈现给模型时标成 "transcript excerpt"，即"逐字、可
  对照原文核查"**，而这标签本身就是为防这种过度声称而存在的。声明并全程传递这两个字段，
  新增 4 条断言（含卡片必须显示 written memory、源已删除必须显示 unverifiable）。
- **重排器 55.7% 的回合没跑起来。** 分小时看：09-24 11:00 之前全是 `false`（那正是自动
  路径从未调用重排器的旗舰缺陷期），修好后基本全 `true`，但仍每小时有约 2 次退回。
  实测：20 个候选不截断时一次重排要 **4.1 秒**，多个会话并发排队就会超过 30 秒超时，
  于是静默退回 RRF 排序。**截断到 300 字符后：top-1 反而更好（50/60 vs 49/60）、延迟
  1.5 秒（2.7×）**。新增 `rerank.maxChars`（默认 300，0 = 不截断），只截断送给交叉编码器
  的副本，注入的仍是完整条目。

**Changed — 按需端侧模型、单份索引、按需合成（四条要求对齐）**

四项改动，都是先测量再改：

- **合成只在"答案需要拼装"时才跑。** 134 条带标签用例实测：标签出现在注入内容里
  111 条，其中 **103 条（92.8%）在 top-1 单条里就已存在** —— 对这些做转述只能丢细节
  （而且实测 2B 模型会加入无依据的推测）。前二分差把两组分得很开（单条已够 p50 1.26，
  需拼装 p50 0.30），阈值 0.2 是实测最优（82% 正确）。规则刻意偏向"少合成"：多合成
  一次是把逐字文本换成转述，少合成一次仍然把全部条目交给调用方自己拼。
  `policy.synthesisMargin`（`DSH_G_MEMORY_SYNTHESIS_MARGIN`），0 = 从不合成。
- **索引只留一份。** 原来明文（30.7 MB）与压缩（15.8 MB）两份都写，而实测读压缩副本
  **并不更慢**（0.20 s vs 0.25 s，16,769 单元）。现在压缩是主副本，明文只在没有 zstd
  可用时写（`plain: true` 可强制）。生产索引目录 **47 MB → 16 MB**。
- **引擎按需**（原本已实现，本轮核实并修正文档口径）：嵌入/重排/合成三个模型都由
  `title-server-on-demand.py` 托管，空闲 `MLX_ENGINE_IDLE_SECONDS`（默认 300 秒）释放，
  实测冷启动 0.8 s / 1.3 s / 5.6 s。守护日志里写死 "mlx_lm.server" 的措辞改为中性。
- **脱敏与遥测不再依赖启动方式**：`zstd` 在 PATH 缺失时回退到常见绝对路径；决策日志
  默认落盘（原先只有 web 启动器导出环境变量，桌面 App 因此完全没有遥测 —— 一个在
  正常工作却看起来像死掉的插件）。配套：`~/bin/dsh-desktop-quick.sh` 用 `open --env`
  传递环境（`open -a` 不传递），并新增 LaunchAgent 让"点图标启动"等价于终端启动。

**实测的架构口径（供后续判断，避免重复劳动）**：索引文本 11.3 MB + 向量 12.4 MB，
无重复单元（完全重复 0，近似重复 2.1%）；增量构建复用 91.6%；卡片 40 KB、遥测 56 KB。

**Fixed — third review round: redaction gaps, evaluation credibility, and a vacuous test**

Privacy, all three of the same shape (this document claimed coverage the code did
not have):

- **A private key longer than one chunk was never redacted.** The rule matches
  `BEGIN…` against `END…` inside a single string, and the strings being redacted are
  chunks: a measured 1,707-character RSA key split across 27 of them, and the
  fragment holding the BEGIN line survived redaction intact. `chunkBySentence` now
  keeps a PEM block whole — so the pair survives, the block is replaced by a
  placeholder, and the index keeps its verbatim contract — with unterminated-marker
  rules as a backstop for a key that was already split.
- **Stripe keys were matched only in their documented form** (`sk-…`); every key
  actually issued uses underscores (`sk_live_…`, `rk_live_…`).
- **Narrowing the name rule in the previous round lost two families** — `token2=…`
  and `secretValue=…` — while the security review kept describing the wide rule.

Evaluation credibility:

- `build-real-cases.mjs` builds a **synthesis** case set: it keeps only candidates
  whose fragment already contained the answer (17 of 53 dropped) and asks the
  question as a verbatim slice of that fragment. Any retrieval figure derived from
  it is inflated by construction, and the file now says so at the top. (The
  retrieval numbers quoted in this project's reports do not come from it.)
- `eval-real.mjs` printed **"fabrication rate 0%"** when `EVAL_POSITIVE_ONLY=1`
  skipped the negative loop entirely — a skipped measurement reported as a perfect
  score. It now says the rate was not measured.
- Four of the eight calibration cases had labels satisfied by hundreds of units
  (`记忆插件` by 1,217 = 7.9%), and one asked about a model this project no longer
  uses. Replaced with measured, rare labels. **That immediately surfaced a real
  retrieval miss**: the new case "嵌入模型现在是多少维" finds nothing in the top 20
  (calibration 8/8 → 7/8) — the old label had been passing by asking about a
  retired fact.
- `diagnose-surrogates.mjs` counted v3 and v4 of the same session separately, unlike
  the builder; `eval-retrieval.mjs` still parsed five flags with `argv[++i]`;
  `test-synthesis.mjs` returned `undefined` for a flag with no value;
  `build-real-cases.mjs` hardcoded the reranker endpoint.

**Fixed — a test that could not fail**

`scripts/test-redaction.mjs` wrapped its checks in a *synchronous* helper, so the
asynchronous private-key check returned a promise nobody awaited: the assertion
failure became an unhandled rejection and the check printed ✅. It passed with the
fix it was written for removed. Found by mutation testing — 22 mutations, each one
breaking a specific fix and asserting that the suite notices; the first pass caught
19, and the three misses led to this and to a fixture too small to trigger the
head-margin rule.

**Added — two tests that would have caught the above**

- `scripts/test-modules-load.mjs` imports every `lib/` module and the plugin entry
  point. `node --check` only parses: a reference to a name that was never imported
  is a syntax-valid file that throws `ReferenceError` on load, which for
  `lib/config.mjs` means the plugin does not start — and that is exactly how a
  one-line edit during this review broke it.
- `scripts/test-cli-args.mjs` pins the argument behaviour, including that an
  argument error is reported without a stack trace.
- `scripts/test-incremental-build.mjs` now plants a checkpoint from another model
  and asserts both that it is refused and that a matching one is still resumed, so
  the guard cannot silently disable resuming.

**Changed — testing no longer depends on the production corpus**

- `scripts/test-e2e-hermetic.mjs` is new: a stub embedding server, a stub
  cross-encoder and a fixture index, so the automatic path (recall → rerank →
  gate → injection) is checked end to end with no network, no model and no
  session history. It is the check that would have caught the defect above,
  because it configures the reranker the way a profile does — through options.
  Wired into `npm test` and available as `npm run test:e2e`.
- The two live `/recall` checks now skip, with a reason, when no reranker is
  configured instead of passing or failing on corpus luck: without one the gate
  reads the fused RRF floor, where the same code and the same query passed under
  one embedding model and failed under the next.
- `npm test` runs without `--strict` (environment-dependent checks report as
  skips); `npm run test:strict` is the full run and expects a live reranker.
- `scripts/telemetry-report.mjs` is new: trigger rate, which scale each gate read
  (cross-encoder vs RRF fallback), verdicts, payload sizes and failed recalls.
  The 27-hour silent degradation was visible in this data all along — nothing was
  reading it.
- `DEFAULT_EMBED_CONFIG` now names the deployed endpoint (11439 / `embed-gemma`),
  so a fresh clone and the CLI point at a model that exists.

## 0.6.0 — 2026-09-24

**Fixed — the 0.5.0 headline fix never reached the automatic path**

- 0.5.0 replaced the automatic path's no-op gate with the cross-encoder's score.
  That never took effect: `AutoRecall` was constructed without `options.rerank`
  (and `options.policy`), so `this.options.rerank` was always `undefined`,
  reranking resolved to the empty default URL, and the path fell straight back to
  `rrfFloor()` — the exact no-op 0.5.0 set out to remove. The tool path passes the
  config correctly, which is why every test stayed green while production did not.
- Evidence, not inference: **44 of 44** `gate` events in the decision telemetry
  (27 hours) read `"reranked": false`, and the reranking engine was never started
  during those turns. After the fix the same event reads
  `{"verdict":"pass","reranked":true,"kept":3,"dropped":5}`.
- Both fields are forwarded now, and the telemetry records which scale the gate
  read — a degraded gate is visible instead of assumed.

**Added — DSH 0.1.7 support (session format v4)**

- Injected messages carry a producer-owned source kind (`plugin:dsh-g-memory`).
  v4 persistence rejects the old `{kind:'plugin', plugin:…}` wrapper outright, so
  every injection was rejected in the turn it was written into.
- The session scanner is version-aware: each session directory contributes its
  newest log (`session.v4.jsonl.zstd` over `session.v3.jsonl.zstd`). A fixed
  filename froze memory at the upgrade date — every later conversation stayed
  invisible — while reading both would index each conversation twice, since the
  older file is a prefix of the newer one.
- The injected-message assertion in the suite still expected the v3 shape, so it
  failed against correct code; it asserts the v4 kind now.

**Added — `memory_note`: a write channel that works mid-session**

- Judgement that only exists while the work is happening — a rejected approach,
  the symptom that identified a bug — can be stored immediately instead of
  waiting for the consolidation pass, which runs only after a session settles.
- The card prompt now asks for four classes of content, not just facts:
  what happened, the decision and its reason, **what was rejected or disproved
  (with the symptom)**, and what is still open. The third class is the one a
  future session cannot re-derive from code or transcript.

**Fixed — failures left no trace**

- A failed automatic recall (embedding engine down, index unreadable) recorded a
  debug line and nothing else: every turn produced `armed` and then silence, with
  no injection, no event and no warning, so the memory system looked healthy while
  retrieving nothing. It now writes an `error` event to the decision telemetry.

**Changed — embedding model, and what it costs to switch**

- Deployment now uses **EmbeddingGemma-300M** (768-d, Q8_0) instead of BGE-M3
  (1024-d). Measured on 710 real memory entries with 572 real queries
  (501 entry titles + 71 verbatim user prompts, known-item retrieval):
  R@1 92.5% → 94.4%, R@3 96.3% → 97.7% (McNemar p=0.02), and on the realistic
  prompt subset R@1 52.1% → **69.0%** (p=0.0005, 12 improvements / 0 regressions).
  Model size halves (605 MB → 326 MB) and indexing is 2.4× faster.
  On C-MTEB's sentence-pair tasks BGE-M3 still leads by 4.4 points, which measures
  symmetric sentence similarity rather than "find the memory this question refers
  to" — recorded because it is the one result that argues the other way.
- Switching embedders is a **full rebuild**, never a conversion: vectors are not
  projected between dimensions, they are recomputed. The build refuses the old
  vectors on a model/dimension mismatch, and the card store skips vectors whose
  length differs, so the failure mode is "cards quietly stop being retrievable"
  rather than wrong results. `scripts/` includes a one-off card re-embed for that.

**Added — a head-margin gate for the automatic path**

- The per-candidate floor asks "is this one relevant?". It cannot express "is the
  winner actually separated?" — for an unanswerable query a cross-encoder still
  scores the best of a bad set positively, and the top few land within noise of
  each other. `policy.marginGate` reads exactly that separation: after reranking,
  if `score[0] − score[2]` is below the floor, the turn injects nothing.
- Measured on this corpus (134 answerable, 8 unanswerable, `bge-reranker-v2-m3`):
  AUC 0.786, median margin 2.80 answerable against 0.83 unanswerable. At 1.18 the
  negatives admitted fall **8/8 → 2/8**, and the same measurement states the price
  rather than hiding it: **24% of answerable turns would lose their memory**.
- Off by default, because eight negatives is a thin basis for a threshold and the
  cost lands on recall. A deployment turns it on deliberately:
  `policy: { marginGate: 1.18 }`.
- Skipped when fewer than three candidates were scored — an undefined margin must
  not be read as a small one — and forced off on the RRF fallback path, where all
  scores sit within 1/61 of each other and the rule would reject every turn.

**Fixed — `policy` configuration was accepted and discarded**

- `resolvePolicy(overrides)` declared an `overrides` parameter and never read it,
  so the `policy` object that `lib/config.mjs` declares, validates and documents
  had **no effect at all**: only environment variables could move a threshold,
  while a composition appeared to configure one. Same defect class as
  `options.rerank` never reaching `AutoRecall` — configuration silently dropped
  instead of rejected.
- Overrides now apply on top of the environment defaults, with the same bounds the
  env path enforces; a malformed or out-of-range value falls back to the default
  instead of being coerced.

**Fixed — a review pass over the whole module (15 findings, all measured)**

- **Two writers in one process could destroy the card store.** Both temp paths
  were built from `process.pid`, so the first `rename` moved the file out from
  under the second (ENOENT) while both merged onto the same snapshot (lost card).
  Reachable from two `memory_note` calls in one turn. Writes are now serialised
  per store and the temp name is unique.
- **A refusal could be stored as a card.** `parseCard` documented that it reused
  the synthesiser's classifier and only checked length; measured, 2 of 3 refusals
  became retrievable cards with vectors. Refusals are rejected at the write
  boundary now, and `memory_note` verifies the write landed instead of reporting
  `stored: true` unconditionally.
- **Redaction mangled content instead of secrets.** `tokenizer: bge-m3` became
  `tokenizer=[redacted-secret]`, and so did `monkey:`, `keyboard:` and
  `max_tokens:` — and because it also runs over the model's output, the damage was
  written into durable cards. A secret name must now be a whole identifier segment
  (`DB_PASSWORD`, `OPENCODE_GO_API_KEY`) or an all-caps token (`MYTOKEN`).
- **The injection budget did not bound the injection.** `maxTotalChars: 1200`
  capped only the entry lines; the 582-character frame was free, so a real
  injection reached 1782 — 49% over the documented ceiling. The cap is now
  enforced against the assembled block, exactly.
- **Index damage was invisible.** Rows dropped by validation were counted and
  never read, and a compressed copy that failed to decompress fell back to the raw
  one silently. `reportIndexDamage` warns once per distinct condition, from both
  loaders.
- **Damaged card rows were erased by the next write.** They are counted now, and
  the store is copied to `.damaged-<timestamp>` before being rewritten.
- `DSH_G_MEMORY_CARD_MIRROR=off` gates reading as well as writing (it used to
  leave a stale mirror overriding the store).
- Removed a declared-but-unread `embed.batchSize` (batching measured at 1.2×, so
  it was never worth implementing) and a dead `policy.toolEnabled` that always
  returned `true`.
- Documentation re-synced with the deployment: the module headers no longer
  describe BGE-M3 and a 512-token batch, the README's tables no longer default to
  a removed endpoint, 25 previously undocumented variables are documented, and the
  deployment guide's Ollama recipes are replaced by the current setup.
  Re-measured token density: **0.522 tokens/char** for the embedder,
  **0.49** for the reranker's XLM-R tokenizer — so the fragment that broke the
  512 batch was a 1200-character tool chunk (~590 tokens), not a 400-character one.

**Fixed — second review round: the resume checkpoint, provenance, and the CLI**

- **The resume checkpoint could mix two vector spaces into one index.** It stored
  `{hash: vector}` with no model and no dimension, and was read back with no
  validation, while the neighbouring "reuse the previous index" path has had that
  guard all along. A checkpoint only survives an *interrupted* build, so the case
  is: interrupt a build, change the model to another one of the same width
  (EmbeddingGemma-768 → nomic-embed-text-768, both listed in the deployment guide),
  rebuild — and the index silently contains vectors from two models. At a
  different width the affected units were dropped instead. The checkpoint now
  carries an atomically-written header naming its model and dimension, and a
  mismatch discards it with a warning.
- The checkpoint is also line-oriented and append-only now: it used to rewrite the
  whole file every 250 units, which is quadratic (≈435 MB written for a 14k-unit
  build, ~40 GB at 100k), and its header was not written atomically.
- **`orphaned` never reached the injection layer.** The build marks units whose
  source transcript is gone, and `provenanceOf` has a branch that labels them
  "unverifiable (source deleted)" — but the flag was dropped by the serialiser and
  by both entry constructors, so that branch was unreachable and a memory with no
  transcript behind it was presented as verbatim and checkable. The flag is now
  persisted and carried through.
- CLI arguments: `distill`'s documented `--recent/--model/--url` were never
  parsed while the error message recommended `--url`; a flag could be swallowed as
  another flag's value (`stats --out --fresh`); and a missing or non-numeric count
  became `NaN`, which reached `.slice()` as an empty, *successful* result. All
  three are errors with a one-line message and exit 1 now.
- `fillerSkipped` was created on first use and therefore never accumulated, and
  unparsable session-log lines were dropped silently; both are counted and
  reported now.
- The synthesis cache fingerprint did not include the embedding model, so the same
  corpus re-embedded by a different model produced an identical fingerprint and a
  cached answer from the old model's retrieval was served for the new one's.
- Smaller ones: `zstd`'s stderr is capped (it feeds an error message), its timeout
  is raised to 300 s so the declared 512 MB ceiling is reachable at the measured
  0.33 s/MB, and `harness.mjs` uses `fileURLToPath` instead of `.pathname` (which
  yields `/C:/…` on Windows).

**Changed — the unit locator now comes from the file that was read**

- `extractUnits` derived a unit's `session` from the log's *contents* (an
  event-level `sessionId`, falling back to the header record's `id`), and different
  log versions carry different fields. The build passes the directory name it
  actually opened now, because the locator is what a reader follows to re-read the
  source: it should name the file that was read, not a field inside it. Verified
  with a log whose header id deliberately disagrees with its directory.
- Session directories on disk use three naming shapes (`session-<uuid>`, a bare
  uuid, `od-<uuid>`), which is why the index shows three; the labels were already
  faithful, and the change removes the dependence on log format rather than
  fixing a mismatch.

**Fixed — the nine items the second review left open**

- **Cards were unreachable on the degraded path.** A card enters the pool with
  `score: 0` — it is not an RRF hit — so with no reranker every floor rejected it:
  the one layer that survives a deleted transcript was the one layer the gate could
  not see. Both selectors now judge a card by its own similarity pre-filter on that
  path only. Measured on this deployment's cards: that pre-filter admits 0 of 8
  unanswerable queries (best card 0.276 against a 0.35 floor) and covers 23% of
  answerable ones, so it is the stricter of the two gates rather than a loophole.
  Tunable with `DSH_G_MEMORY_CARD_MIN_SIMILARITY`.
- **A failed distillation lost the session's material permanently.** `pick()` reset
  `turns` before the work, reasoning that a failure must not retry forever; the
  concern is real but the cure deleted the evidence. Picking now reserves the
  session and the caller settles it — success clears the material, failure keeps it
  and counts an attempt, and three attempts is the bound. One session's failure no
  longer aborts the batch either, which mattered because an embedding endpoint that
  is down is enough to throw and it happened twice in one day here.
- **The receipt chain gave the wrong reason for a failure.** Every kind of
  synthesis failure — HTTP 500, unreachable endpoint, empty completion — was folded
  into `null` and recorded as "model returned nothing". Failures now carry their
  reason into the receipt. One early return that wrote no receipt at all now does.
- **The 24-hour interval gate did not survive a restart.** `lastRunAt` came from an
  environment variable nothing ever wrote, so every new process started at zero and
  the interval half of the gate passed immediately. It is persisted now, and marked
  only *after* a batch has been dealt with — it used to be marked before
  distillation started, so a run that never reached the model still silenced the
  gate for a day.
- **The same note recorded twice became two cards.** The id is
  `sha1(session + summary)`, so a repeat on another day had a different id; `hash`
  is the content identity and is what dedup reads now, reporting the duplicate
  instead of silently adding a second card.
- **The synthesis prompt did not frame its fragments as untrusted.** The
  consolidation prompt has always said so; the synthesis prompt — whose fragments
  are raw transcript, file contents and issue bodies — did not, which made the
  summariser a prompt-injection path into the context the injection layer carefully
  frames. Rule 2 and the fragment heading now say it.
- **The mirror was written before the store.** The mirror takes precedence on read,
  so a failed store write left it showing a card the store did not have, and the
  next write dropped it.
- Removed a re-export of `appendFile` from `lib/cards.mjs` that nothing imported
  (every module imports it from `node:fs/promises`), and documented that the quality
  filter's branches are explanatory — only empty text and pure filler are dropped.

## 0.5.0 — 2026-09-24

**Fixed — the automatic path injected on 100% of turns**
- The automatic path gated on the fused RRF score against `rrfFloor()` = 1/61.
  Measured, that is not a gate: the answerable and unanswerable bands overlap
  (0.0159-0.0315 against 0.0145-0.0298), so a query hitting one arm at a low rank
  lands on the floor however irrelevant it is. Every turn injected.
- It now reranks and gates on the cross-encoder's score — the same scale the tool
  path has used since §2.23, and the scale VCPToolBox uses (`LightMemo` carries a
  `RerankApi` and a `minScore` floor). Measured over 8 answerable and 8
  unanswerable queries: **answerable 8/8 kept, unanswerable 8/8 → 2/8, trigger
  rate 100% → 63%** at no cost to recall.
- `lib/policy.mjs` is new and holds the whole decision — both paths read it, so
  they cannot drift apart again, which is what produced this defect.

**Added — the policy features VCP documents, ported to a single index**
- `::Truncate` equivalent: `DSH_G_MEMORY_GATE`, a hard floor on the *final*
  score, applied after reranking.
- `::TimeDecay` equivalent: `DSH_G_MEMORY_DECAY_DAYS` / `_FACTOR`, off by default
  because VCP warns it "不适合对永久设定无差别衰减".
- Dynamic K: `DSH_G_MEMORY_K_MULTIPLIER`.
- Two-tier payload: a candidate that barely clears the gate gets
  `DSH_G_MEMORY_BRIEF_CHARS` (default 200), a confident one gets `_FULL_CHARS`
  (400).
- Age tiers (`_RECENT_DAYS` / `_MID_DAYS` and their floors), **off by default**.
  The first version defaulted `recentDays: 2` and let 8 of 8 unanswerable queries
  through: VCP's recent tier is a separate small layer (OneRing), and applying
  its exemption by *age* over one 13k-unit index exempts nearly everything, since
  an active corpus keeps most units inside two days.
- Recall mode: `DSH_G_MEMORY_RECALL_MODE=context|tools|hybrid`, mirroring the
  three modes Hermes documents.
- Repeat suppression: a payload already injected into a session is not injected
  again, which at a 100% trigger rate was re-adding the same 1200 characters
  every turn.

**Fixed — four defects that would have made a fresh deployment silently useless**
- **The service supervisor rejected its own engines.** Its POST allowlist admitted
  only `/v1/chat/completions` — correct while it served one title model, wrong the
  moment it also fronted the embedding and reranking engines. `/v1/embeddings` and
  `/v1/rerank` were answered `404 title_supervisor_error`, naming the wrong
  component.
- **The embedding engine was launched without `--embeddings`**, so llama-server
  answered `501 This server does not support embeddings`.
- **The physical batch size was left at the default 512.** A memory fragment is up
  to 400 CJK characters ≈ 560 tokens, so *every* rerank call on real data failed
  with `input (562 tokens) is too large to process`. The reranker client treats a
  failure as "keep the fused order", which then scored `-Infinity` and made the
  new gate drop everything — the memory system would have returned nothing at all
  while reporting itself healthy. `-ub 2048` on both engines.
- **`shlex` was used without being imported**, so `MLX_TITLE_CHILD_CMD` raised
  `name 'shlex' is not defined` at first use.
- The supervisor now closes connections per request: with HTTP/1.1 keep-alive, a
  client that reused the connection (Node's `fetch` does) desynced after the first
  request, which showed up as "only the first rerank of a process succeeds".

**Fixed — a missing reranker disabled the automatic path**
- The new gate scored candidates `-Infinity` when reranking was unavailable. A
  deployment without a reranker — the default — would have injected nothing. It
  now falls back to the fused score behind `rrfFloor()`, matching the tool path:
  a missing reranker must degrade the gate, never disable it. Caught by the
  `injection shape` check, which had been skipping rather than failing.

## 0.4.1 — 2026-09-24

**Fixed — the sampling parameters were hardcoded, and they were the wrong ones**
- The request pinned `temperature: 0` and sent no `top_p`, `top_k`, `min_p` or
  `presence_penalty`. Neither model is tuned for greedy decoding, and the two
  publish different profiles:
  MiniCPM5-2B No-Think `0.7 / 0.95`, Think `0.9 / 0.95`; Qwen3.5-2B non-thinking
  text `1.0 / 1.00 / top_k 20 / presence 2.0`, thinking `1.0 / 0.95 / top_k 20 /
  presence 1.5`.
- It was not cosmetic. Measured through the real plugin path, 8 answerable
  questions, 2 runs each:

  | sampling | MiniCPM5-2B | Qwen3.5-2B |
  |---|---|---|
  | `temperature: 0` (shipped) | 14/16 | 12/16 |
  | published defaults | 15/16, 6% missed facts | 15/16, 6% missed facts |

  With each model's own published parameters the two become **identical on every
  metric** — 15/16 correct, 0 false negatives, 6% missed facts, 25% fabricated,
  7/8 on colloquially-phrased versions of the same questions. Almost all of the
  apparent difference between these models was a configuration artefact.
- `temperature` now defaults to `NaN`, meaning "use the mode's published value",
  so setting only `DSH_G_MEMORY_LLM_THINKING` still lands on a documented pair.
  `top_p` defaults to 0.95; `top_k`, `min_p` and `presence_penalty` are omitted
  from the request unless configured, since an endpoint that validates unknown
  sampling fields should not be handed a sentinel it cannot interpret.

**Fixed — reasoning was not worth its cost, and the budget was not the problem**
- With the same questions, MiniCPM5-2B scored 0% missed facts with reasoning
  against 25% without — a real gain — but failed to produce any answer at all on
  19% of runs, because the chain consumed the budget before the answer began
  (`finish_reason: "length"`, empty content, no error). Raising the thinking
  budget from 512 to 4096 tokens made it **worse**, not better: 31% produced no
  answer, against 19% at 512.
- Measured cost: 3.5 s per call without reasoning, **55-63 s** with it. Qwen's
  model card explains the direction of that tail for Qwen3.5-2B specifically —
  it "is more prone to entering thinking loops … which may prevent it from
  terminating generation properly" — and records `presence_penalty` as the
  documented remedy rather than an optional extra.
- Reasoning therefore stays off by default, and the escape hatch is documented
  with its measured cost rather than presented as a free upgrade. It is not a
  quality ceiling: with correct sampling and no reasoning, both models already
  reach 15/16 with 6% missed facts.

**Fixed — `DSH_G_MEMORY_LLM_THINKING=on` was silently overridden**
- The request body carried `thinking: { type: 'disabled' }` **unconditionally**,
  while the `chat_template_kwargs` suppression was correctly conditional. On an
  MLX endpoint that ignored the unknown field the two agreed by accident; on the
  DeepSeek- and Anthropic-shaped endpoints the field actually governs — the ones
  the surrounding comment names — turning thinking on did nothing at all. Both
  switches now sit in the same branch.
- Found while setting out to measure whether reasoning helps synthesis, which is
  the question the switch exists to answer.

**Fixed — a verbatim sentinel made every model under 2B useless**
- The prompt asked for the abstention literal verbatim (`reply exactly:
  未找到相关记忆`) and the callers string-matched it. On MiniCPM5-1B and
  Qwen3.5-0.8B that sentence was not an escape hatch, it was the single most
  likely continuation: **every** answer became that literal, including questions
  whose answer was sitting in the fragments — 16 of 16 runs abstained. Deleting
  only that one line restored both models to 10/16 correct.
- The mechanism was isolated rather than guessed. Narrowing the trigger to "only
  if NONE of the fragments mention the topic", adding a worked counter-example,
  and moving the rule to the end of the prompt each changed nothing; the same
  prompt with an English sentinel (`NOT_FOUND`) failed identically, ruling out a
  Chinese-specific cause. What matters is that the required output is a long,
  sentence-like literal — a weak model copies it.
- The sentinel is therefore **off by default**, and re-enableable with
  `DSH_G_MEMORY_LLM_SENTINEL=未找到相关记忆`. An earlier draft of this entry kept
  it on, on the strength of a run where MiniCPM5-2B showed 0% fabrication with it
  and 25% without. That comparison did not survive re-measurement: it had been
  scored by a probe whose refusal detector had no length bound, so any long answer
  that merely mentioned "未找到" counted as an abstention. Scored through the real
  plugin path with the shipped `isRefusal()`, the 2B reaches 14/16 correct and 25%
  fabricated either way — and **all of its abstentions come from the relevance
  gate, not the sentinel**. The gate is the defence that works; the sentinel's
  only remaining effect was to make both sub-2B models abstain on every question.
- `isRefusal()` is exported and shared by the tool path and the automatic path so
  they cannot drift. A refusal is the configured sentinel, the one-character
  fallback, or a *short* statement of absence — the length bound is what stops a
  real answer being discarded for containing "无法" in a sentence that also
  carries the specifics, which is the exact flaw that inflated the earlier
  numbers.

**Added — `scripts/eval-real.mjs`, acceptance through the shipped code path**
- Three defects in this project came from probes that diverged from production: a
  mock registry that could not reject a schema, a `check()` that never awaited,
  and a synthesis probe that called the model with an empty fragment list while
  `lib/index.js` only calls it when the gate admitted something — six of those
  eight cases could not occur in production, and they were reported as a 100%
  fabrication rate. This script mounts the plugin the way a profile does and
  calls `tool.execute()`, so retrieval, the gate, the prompt and the classifier
  are all the shipped code. It also asks the same labelled facts in colloquial,
  vaguely-referring phrasing, because that is how a person actually asks a memory
  system and padding around a question is what a small model will answer out of.

**Fixed — the relevance gate on the tool and `/recall` path was a no-op**
- `selectForInjection` filters on `score >= minScore`, and `lib/index.js` called
  it without a `minScore` argument, so the filter read the `INJECTION_LIMITS`
  default of `0`. Every RRF score is positive, so **every candidate any arm
  ranked at any depth passed**: a query that found nothing still handed the
  synthesiser three chunks, and the synthesiser answered out of them.
- Measured over 8 answerable and 8 deliberately unanswerable queries: all 8
  unanswerable queries were fed three irrelevant fragments each, and synthesis
  fabricated an answer in 25% of runs — *identically* on two unrelated models,
  which is what showed the defect sat upstream of the model rather than in it.
- The gate now reads the **cross-encoder's** score when a reranker is
  configured. The fused RRF score cannot serve as that scale: measured on the
  same 16 queries, the two sets occupy one overlapping band (top-1 RRF
  0.0159–0.0315 answerable against 0.0145–0.0298 unanswerable), because a query
  that hits a single arm at a low rank lands near the `1/61` floor however
  irrelevant it is. A gate on that scale can only admit everything or drop half
  the real answers. The cross-encoder separates the sets (medians 5.64 and
  −4.41); gating there cut unanswerable queries reaching the synthesiser from
  **8/8 to 2/8 while keeping all 8 answerable ones**.
- Without a reranker there is no such scale, so `rrfFloor()` stands in — the
  threshold auto-recall already used, which errs toward missing a memory rather
  than inventing one.
- `lib/rerank.mjs` returns each entry's cross-encoder score as `rerankScore`
  instead of computing it and discarding it, and exposes the gate as
  `DEFAULT_RERANK.minScore` / `DSH_G_MEMORY_RERANK_MIN_SCORE`. The module's
  "ranking only, never scoring" rule is retired along with the theory it rested
  on. A composition that sets only `{ url, model }` still gets the documented
  default, because the gate reads the *resolved* config — an unresolved
  `undefined` there would have rejected every candidate rather than admitted
  every one.

## 0.4.0 — 2026-09-23

**Added — cross-encoder reranking, the measured bottleneck fixed**
- Retrieval was tuned for recall: fused recall@20 was 8/8 while **top-1 was only
  4/8**. The answer was almost always in the pool and the *ranking* was what
  failed — precisely what a cross-encoder addresses, since it scores a
  (query, document) pair jointly instead of comparing two independently produced
  vectors.
- Measured on the real 12k-unit index with `bge-reranker-v2-m3`: **top-1 4/8 →
  7/8, top-3 6/8 → 8/8, four cases improved, zero regressed.** The largest jump
  was a query whose answer sat at fused rank 13 and moved to rank 1.
- The candidate pool deepens to 20 when a reranker is configured, because a
  reranker can only reorder what it is handed.
- `lib/rerank.mjs`: opt-in via `DSH_G_MEMORY_RERANK_URL`, ranking only (fused
  scores are kept, so the injection threshold still operates on the scale it was
  calibrated against), and every failure path falls back to the fused order — a
  reranker that is down must degrade the ranking, never fail the recall.

**Fixed — the synthesis token budget ignored reasoning**
- `max_tokens` was `max(256, maxOutputChars)`, which silently assumed the model
  emits only its answer. A reasoning model spends thinking tokens from the same
  budget and emits them *before* any content: measured, MiniCPM5-2B with a
  220-token budget returned `finish_reason: "length"` and **`content: null`** —
  an empty string, not an error. The budget is now the output characters plus
  explicit headroom (`DSH_G_MEMORY_LLM_THINKING_TOKENS`, default 512).

**Added — reasoning is suppressed by default**
- Condensing three fragments is extraction, not reasoning, and thinking actively
  hurt: on MiniCPM5-2B the same case produced a **false negative and an empty
  completion with thinking on, and 24/24 correct with it off**, at 1.4 s and 15
  output tokens against 3.9 s and 59. Qwen-family templates gate this on
  `enable_thinking`, passed through `chat_template_kwargs`; the field is omitted
  entirely when `DSH_G_MEMORY_LLM_THINKING=on` so an endpoint that does not
  understand it never sees it.

## 0.3.1 — 2026-09-21

**Fixed — rebuilds were never incremental**
- `build` re-embedded the entire corpus on every run. The resume checkpoint is
  deleted after a successful build (it exists for *interrupted* runs), and
  nothing else was consulted, so the vectors sitting in the index that had just
  been written were ignored. A corpus that grew from 57 to 79 sessions — about
  4% new text — cost a full re-embed of 12,000 units, roughly 27 minutes.
- Reuse is now seeded from the previous index, whose stored vectors are already
  in exactly the representation the checkpoint uses (`[float32 scale][int8
  codes]`, base64). Measured on the real corpus: **153 s instead of ~27 min**,
  with 10,823 units reused and 1,246 embedded. A second build immediately after
  reports `reused 12069 … embedded 0`.
- The guard that makes this sound: reuse happens **only** when the previous
  index's model and dimension match the current embedder. After a model change
  the stored vectors mean something else and everything is recomputed — which is
  why the index header records both fields.
- The checkpoint now persists only the vectors computed *in that run*, so its
  size tracks the new work instead of the whole corpus. `--fresh` bypasses the
  index as well as the checkpoint.
- `decompressZstdFile` returns the string its JSDoc always promised. It had been
  changed to hand back a `Buffer` while hardening the zstd path, which broke
  `build` outright with "jsonl.split is not a function" — no test covered that
  seam. There is one now, and it drives the real decompress-then-extract path.
- Progress output fixed an off-by-one (`embedded -1` on the first lines).

**Added**
- `scripts/test-incremental-build.mjs`, part of `npm test`: first build embeds,
  second build embeds nothing, adding one session embeds only its units, and a
  changed model invalidates reuse. Skips loudly without an embedding endpoint.

## 0.3.0 — 2026-09-21

Adds a human-typed trigger, so memory can be asked for explicitly.

**Added**
- **`/recall <query>`** — a slash command that retrieves and shows memory, and
  arms the same block for the model's next step. The existing paths both guess
  when memory is wanted: the tool waits for the model to decide, automatic recall
  fires on every message. A typed request is not a guess.
  It ignores `DSH_G_MEMORY_AUTO` (a direct instruction is not speculation) but
  respects `DSH_G_MEMORY_ENABLED`, and it is consumed once like any other recall.
  Registered only when the profile provides the commands service — reached
  optionally via `ctx.get('commands')`, never through `inject`, because declaring
  it would leave the whole fiber INACTIVE on a profile that omits it, which is
  the silent-nothing failure this package already had to fix once.
- Retrieval is now one shared function behind both the tool and the command, so
  the two cannot drift in what they consider a memory — framing, caps and the
  score threshold mean the same thing however a recall was asked for.
- Four tests: command registration and its input hint, empty input, the framed
  result, and that a manual recall injects once and does not persist.

## 0.2.0 — 2026-09-21

Renamed from `dsh-memory` (that name on npm belongs to an unrelated package) and
brought to publishable quality after two independent audits. Several findings
were defects that made the plugin quietly useless, not merely untidy.

**Renamed**
- Package, plugin id, `bin` and the `DSH_G_MEMORY_*` environment prefix are now
  `dsh-g-memory`. The old name resolved to someone else's package on the
  registry, so the documented install command would have installed theirs.
- The default index moved to `$DSH_HOME/dsh-g-memory/index` (from a
  `local-keep/…` path that was the author's private convention) and
  `DSH_G_MEMORY_INDEX_DIR` now overrides it.

**Fixed — the automatic recall path was silently doing nothing**
- The default `minScore` of `0.02` sat *above* the rank-fusion band floor of
  `1/61 = 0.01639`, so it discarded every memory that only one retrieval arm
  found — exactly the case fusion exists to recover. Measured on a real index,
  3 of 5 ordinary queries injected nothing. Now defaults to the band floor
  (`rrfFloor()`), and the two thresholds a user might actually want are
  documented as the band edges rather than as magic numbers.
- A skipped selection now records *why* ("no entry met the score threshold" vs
  "there was no memory"), which is what made the mis-scaled threshold invisible.

**Fixed — privacy and egress**
- **Synthesis no longer has a default endpoint.** It defaulted to the package
  author's own gateway (`https://opencode.ai/zen/go/v1`), enabled, so any user
  with that provider's key had their session text uploaded on every recall —
  while the README claimed "the only network call is to a local embedding
  server". Synthesis is now strictly opt-in: no `DSH_G_MEMORY_LLM_URL`, no
  synthesis, and the caller is told which of the two it is.
- The **query** is now redacted too. Redaction previously covered only the
  candidates, so a pasted document or CI log went out verbatim.
- Redaction covers the credential shapes the audit proved were leaking: AWS
  access-key ids and secrets, GCP, Slack, GitLab, npm, Hugging Face, Stripe,
  `Authorization: Bearer …`, JWTs, and — the rule that actually generalises —
  any `NAME=value` whose name contains KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL,
  which is what catches `DB_PASSWORD=…`. Loopback addresses, numbers and
  technical terms are deliberately preserved.
- The automatic path now caps the query at 500 characters, matching the tool
  path; previously a pasted document became an unbounded prompt.

**Fixed — tests that could not fail**
- `assert.ok(true)` replaced with an assertion of the observable consequence.
- **Skipped checks no longer count as passes.** On a machine without a built
  index, the suite printed `13/13 通过` and exited 0 while 8 checks silently
  vanished. Skips are now counted, named in the summary, and fatal under
  `--strict`, which `npm test` uses.
- The render assertions were updated for the new framing, and two new tests
  cover it: the notice and tag must bracket the payload, and a payload
  containing `</recalled-memory>` must not be able to close the wrapper.

**Fixed — injection framing**
- Recalled text is now wrapped in `<recalled-memory> … </recalled-memory>` with
  `<` escaped in the payload, the untrusted notice both before and after, and
  control/zero-width/bidi characters stripped. Previously a prose prefix was the
  only boundary and the payload could forge it.
- **The tool path had no framing at all** — a past session's text arrived looking
  like ordinary output. Both paths now share one renderer.

**Fixed — robustness**
- Both `zstd` invocations are now one hardened runner: output size ceiling
  (compression reaches ~31,800:1, so a few KB could expand into GBs), a
  wall-clock deadline, a minimal child environment instead of one holding
  provider API keys, `stdin` error handling (an unhandled `EPIPE` crashed the
  process), and an absolute-path requirement for `DSH_G_MEMORY_ZSTD`.
- The embedding response is validated (width and finiteness) instead of trusted
  into the index, and a query whose dimension does not match the index now
  raises a clear error instead of scoring `NaN` — which sorted as a no-op and
  silently returned the oldest units first.
- Index rows are coerced and validated on load; a single non-string `text` or an
  out-of-range `time` used to throw and take the whole capability with it. Rows
  with a wrong-width vector are dropped and counted.
- The index is written `0600` in a `0700` directory and via temp-file + rename,
  so a crash mid-write no longer leaves a truncated index. The uncompressed
  fallback copy is still written, deliberately.
- Numeric environment variables go through one validating reader; previously
  `DSH_G_MEMORY_CACHE_ENTRIES=abc` made the LRU bound `NaN` and switched it off,
  and a bad timeout made `AbortSignal.timeout` throw where the error was
  reported as "endpoint unreachable".
- `readIndex` no longer swallows the reason the compressed copy failed.

**Removed**
- Dead code: `renderInjection` (whose documented "over-limit is an error"
  guarantee was never reachable, since nothing called it), `InjectionLimitError`,
  `looksLikeZstd`, `tokenSet`'s unused status (now actually used), `dirname`'s
  re-export, `AutoRecall.report()`/`stats`, `checkLater`, and several accumulated
  totals and ranks that were computed and discarded.
- Duplicated implementations: two byte-identical surrogates scrubbers, two
  message-text extractors, two zstd wrappers, and a literal `24` standing in for
  `MIN_CHUNK_CHARS`.
- The `non-negative score correction` claim from the README; no such code exists.

**Documentation**
- Corrected four statements that contradicted the code or the README's own
  tables; documented the `zstd` requirement (stock macOS does not ship it); added
  the six environment variables the code reads but the README omitted; replaced
  the stale 2,897-unit storage figures with measured 10,823-unit ones and stated
  that the index holds chunk text rather than only pointers; added a
  Network-and-privacy section.

## 0.1.2 — 2026-09-21

Fixes the real reason the plugin registered nothing, and moves to DSH 0.1.6's
supported packaging.

**Fixed — the plugin was mounted, reported `active`, and contributed nothing**
- The Host half did not export an `inject` list. DSH 0.1.6 resolves plugin
  dependencies at runtime and derives each fiber's start from its declared
  dependencies, so an undeclared service is *absent* while `apply()` runs — even
  when its provider mounted earlier. `ctx.get('tools')` returned undefined, the
  plugin took its warn-and-return path, and the fiber still reported
  `fiberPhase: "active"`. No tool, no error, no log.
- The module also had `export default { name, apply }`. The Loader resolves a
  plugin as `exports.default ?? exports`, so that default discarded every named
  export — adding `inject` alone would have changed nothing. The default export
  is gone; the module now exports `name`, `apply`, and `inject` only.
- The unreachable-registry path now **throws** instead of logging a warning and
  returning. A memory plugin that silently contributes nothing is worse than one
  that fails loudly, and a throw marks the fiber failed, which
  `plugin_manager list_plugins` reports as a non-active `fiberPhase`.

**Added**
- `scripts/test-loader-contract.mjs` — drives the real Cordis through the real
  Loader rules: no-default-export, declared `inject`, and registration in both
  load orders (provider first and provider last). Red/green verified by
  reintroducing each defect: dropping `inject` scores 2/5, restoring the default
  export scores 1/5.
- `dsh-g-memory` is now a **bundle**: `package.json` declares
  `dsh.bundle.patch: "./cordis.patch.yml"`, and that patch carries the insert
  row. Install with `plugin_manager install_bundle`; the profile no longer needs
  a hand-written insert or a manual symlink.

**Why this took three attempts:** each earlier diagnosis was reached by
inference rather than reproduction, and two of them were wrong. Both causes in
this release were found by reproducing the Loader's behaviour locally against the
real `cordis` package — which is now a permanent test.

## 0.1.1 — 2026-09-21

Fixes the reason `memory_recall` never appeared in a live harness, and makes that
class of failure detectable without a restart.

**Fixed**
- **The tool definition was rejected by the registry, so the mount silently
  produced nothing.** `limit` declared `minimum`/`maximum`, which are outside the
  Harness JSON Schema subset (`type` / `oneOf` / `properties` / `required` /
  `additionalProperties` / `items` / `enum` / `const` plus annotations).
  `ctx.tools.register()` throws `JsonSchemaError` on an unsupported keyword, so
  `apply()` aborted at the registration line: no tool, no error in the
  conversation, and a harness that otherwise looked healthy. The bound is now
  carried by an `enum`, which constrains the model at least as tightly and is
  machine-checked by the registry itself.

**Added**
- `dsh-g-memory plugincheck` — loads the Host half through a fake registry that
  enforces the registry's real preconditions, using the Harness's own
  `assertSupportedJsonSchema` when a checkout is reachable. Exits non-zero on a
  definition the real registry would reject. No restart needed.
- The Host half's unit test now drives that same validation instead of a
  permissive stub, and fails when the Harness validator cannot be found rather
  than reporting a pass that proves nothing.

**Fixed (found while auditing the tests themselves)**
- **`check()` did not `await` its callback**, so every `async` assertion was
  never executed and always reported a pass. Two checks were unconditional
  greens. `check()` now awaits, and the whole sequence runs inside one
  `async main()`.
- **Injected recall context had no `id`.** `agent/pre-step` returns
  `PreStepDecision.messages`, typed `UserMessage[]`, and a `Message` requires a
  stable `id` that the Harness mints via `createUserMessage`. Recall worked, but
  the admitted message violated that contract. It now carries a fresh uuid and is
  deep-frozen, and four assertions cover the injection shape, its ordering ahead
  of the step, and that a consumed recall is injected only once.

**Why this shipped broken:** the earlier mock accepted any object as a tool
definition, so it exercised `apply()` against a registry that could not reject
anything — nothing in it *could* fail the way the real registry fails. The mock
now reproduces the real preconditions, and red/green was verified by
reintroducing each defect and confirming the suite catches it. Both defects are
recorded in `docs/SECURITY-REVIEW.md` §12, because the lesson is about the
verification method, not the code.

## 0.1.0 — 2026-09-20

Initial release.

**Index layer**
- Extracts memory units from DSH session logs (`session.jsonl.zstd`, multi-frame).
- Keeps human turns and assistant prose; drops plugin-injected messages and
  streaming fragment events.
- **Selectively** indexes `tool/result` output — measurements, errors and command
  output are kept; file reads and blob JSON are not. Without this, measurement
  facts are unreachable: on the development corpus the strings `5.95`,
  `-0.000033` and `512 token` appear zero times in conversation prose.
- Chunks at sentence boundaries (800 chars prose / 1200 chars tool, 120 overlap).

**Retrieval**
- Vector arm: BGE-M3 (1024-d), int8-quantised, cosine.
- Lexical arm: CJK bigram + Latin word tokenisation, idf-weighted.
- Fusion: Reciprocal Rank Fusion. Measured recall@20 8/8 on a labelled set,
  versus 7/8 for either arm alone.

**Synthesis**
- Optional LLM condensation of the top candidates, with redaction before any
  text leaves the machine and graceful degradation to raw retrieval.

**Storage**
- int8 quantisation is effectively lossless (mean cosine distortion -0.000033,
  top-1 agreement with float32 5/5). Index: ~9 MiB for 10.8k units.
- Stores a pointer plus a preview, never a second copy of the transcript.

**Operational**
- Checkpointed builds keyed by content hash; an interrupted run resumes.
- Request-boundary scrubbing of lone UTF-16 surrogates.
- Adaptive bisection when the embedding server rejects over-long input.
