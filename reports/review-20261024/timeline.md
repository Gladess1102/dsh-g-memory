# dsh-g-memory 版本 / 部署 / 召回质量时间线（2026-09-20 → 2026-10-24）

> 审查基线：仓库 `/Users/yangyuxin/.dsh/local-keep/dsh-g-memory`，HEAD = `2b75882`（2026-10-22 17:11），`package.json` 版本仍为 **0.12.0**（`package.json:3`）。
> 数据：`~/.dsh/dsh-g-memory/auto-recall-stats.jsonl`（17,994 行，2026-09-23 07:54:18 → 2026-10-24 01:47:22，18 类事件）；会话日志 `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`；配置 `~/.dsh/profiles/desktop/cordis.patch.yml` + 5 个 `.bak-*`、web profile + 2 个 `.bak-*`。
> 全部时间为本机时区（+0800）。

---

## 0. 结论先行

1. **代码时间线**：仓库首个提交即 0.6.0（`7092a2f`，10-02 23:22，CHANGELOG 归到 09-24），此后 0.7.0 → 0.12.0 共 8 个版本提交；**最后两次改动（10-22 VCP 2.0 移植 + 同日配置放宽）都没进 CHANGELOG、也没 bump 版本**，所谓"0.12.0+"实际是"0.12.0 版本号 + 10-22 未发布代码"。
2. **部署是"符号链接即上线"**：两个 profile 的 `node_modules/dsh-g-memory` 都指向仓库本身（`ls -la`：desktop 链接创建于 Sep 24 22:49，web Sep 21 05:20）。因此**每次 App 重启就加载 HEAD，没有版本钉住、没有回滚点**；决定线上行为的是"HEAD + profile 配置"，不是 version 字段。
3. **召回质量走了三段**：0.10.0 的闸门 3 把自动路径打到 **0 注入**（10-08 05:24–10-13）；0.11.0 用判定层 + 闸门 0 把它救回到 **armed 回合的 26.4%**；10-22 晚把闸门放宽到 -1.0/-1.5 后，**闸门通过率 59.7% → 75.0%，但注入密度反而 26.4% → 24.5%**——放宽闸门没有解决用户"几乎没有 recall"的体感。
4. **10-22 的两处配置里有一处是空操作**：judge `threshold` 0.5 → 0.4 在实测样本里**完全无效**（chat 判定 749 条中，kind≠none 的 431 条全部 fire、kind=none 的 318 条全部 skip，置信度落在 [0.4,0.5) 的样本为 **0**；`lib/judge.mjs:242` 的公式决定了阈值只对"非 none 且非 explicit"的类别起作用，而该类别从未出现）。真正的变化只有闸门地板。
5. **同时出现一个反向信号**：判定层退化为 fallback 的日比例，从 10-15~10-21 的 0–11%（10-21 已降到 2.9%）跳到 **10-22 的 14.3%、10-23 的 15.4%**（纪元合计 E4 5.4% → E5 16.8%）。fallback 一律判 skip（37/37、24/24），等于静默不召回。注意 10-19/10-21/10-22 的 fallback 多是 judge 15s 超时（ms≈15000），而 **10-23 的 21 次耗时只有 2.5–5.3 秒**——不是超时，更像判定端点返回了错误，需下一轮定位。

---

## 1. 方法、口径与限制

| 维度 | 做法 | 口径/限制 |
|---|---|---|
| 版本 | `git log --date=iso --pretty`、`git tag`、`git show <c>:package.json`、CHANGELOG 每版条目 | 仓库历史是 10-02 一次性建立的（0.6.0 起），0.1–0.5 无 git 对象，只能靠 CHANGELOG 日期 |
| 配置 | 读当前 `cordis.patch.yml` + 全部 `.bak-*` 做 diff；patch 内注释自带日期化标定记录 | **10-21 之前没有任何备份**，E1–E4 的配置值只能引"注释证据 + CHANGELOG"，不能 diff |
| 召回指标 | 按事件类型 × 时间区间聚合（armed / judge / gate / inject / hint / resident / late-drop / consolidate） | stats 只记"注入了一次"，**不记模型是否使用了注入内容**，也**没有 memory_recall 工具调用遥测**；"体感无 recall"与"注入率"不是同一指标 |
| 会话 | 4 个热点 cwd 目录（`-dsh-g-memory-` 52 个、`--root--` 78 个等，共 230 个 session.v4），`zstd -dc` 逐行解析，只取 `source.kind == 'user'` 的真人消息 | 会话有 resume/fork，同一句原话会在多个 session 重复出现，已按前缀去重 |
| 边界 | 统计纪元以**代码/配置首次可观测的时间**为准，不用 commit 时间 | 0.11.0 的遥测换代（gate.top1 / judge / resident / hint）比版本提交早 2.3 小时，见 §2 |

---

## 2. 版本 × 提交 × 部署时间线

| 日期（提交时间） | 版本 / commit | 关键改动（取自 commit + CHANGELOG） | 部署/生效证据 | 当时的验收数字（原文引用） |
|---|---|---|---|---|
| 09-20 22:08 | —（立项会话 `session-346c84bb`） | 用户要求"跨对话、跨时间、无感、占用资源极少"的记忆系统，并点名参考 VCP | 会话日志 | — |
| 09-23 07:54 | 0.3.x–0.4.0（pre-git） | `/recall` 命令（0.3.0）、reranker 接入（0.4.0，09-23 当日） | stats 起点：首个 `pass`/`gate`/`inject` | 当日 armed 36 / gate 35 全 pass / inject 27（≈100% 注入，即 0.5.0 要修的"每轮都注入"） |
| 09-24 | 0.4.0 / 0.4.1 / 0.5.0 / 0.6.0 | 交叉编码器重排；采样参数；闸门换成 rerank 分；**0.6.0 让 rerank 真正进自动路径** | CHANGELOG L1022/L895/L833/L606 | 0.5.0："fused recall@20 8/8，top-1 只有 4/8" |
| 10-02 21:34 | 0.7.0（`7e8ac48` 23:50） | live index（增量索引）、CI | 首个 `live-index` 事件 10-02 21:34:32；同日 4 条 `live-index-error: endpoint down` | 0.7.0："一周真实使用后的验收快照" |
| 10-05 23:22 | 0.8.0（`623629e`） | 记忆治理层：expired / superseded / retired | `card-retired` 首现 10-07，"how: id" | — |
| 10-06 02:43 | 0.9.0（`137fb53`） | 修复"宣称完成却从没跑过"的卡片蒸馏层（三个独立成因） | `consolidate-skip: disabled` 首现 10-05 23:48；首个成功 `consolidate` 10-06 04:03 | 0.9.0："57 张卡片里 55 张是 memory_note 手记，只有 2 张来自蒸馏" |
| 10-07 01:23–17:39 | 0.9.2–0.9.6（`62676d4`…`dce133a`） | 调用时读配置；蒸馏改云端 deepseek-flash；头尾窗口；闸门材料从日志重建 | `consolidate` 事件 10-07 起稳定出现 | 0.9.5："本地 60–80 秒 → 云端 6 秒出卡" |
| **10-08 05:24** | **0.10.0（`6e404be`）** | 任务前缀成为配置（`queryPrefix`/`docPrefix`，修"同样 768 维、不同向量空间"的静默错误）；**闸门从 marginGate 1.18 改为绝对分地板 gate/midGate = 3** | 配置注释 "2026-10-08 重标"；stats 中 10-08 起 gate 通过率崩塌 | 注释标定表：地板 3 → 无关查询仍注入 2/13、可答回合保住 31/31；**gate=3 选定**。（EG2 换型本身在 10-07，见配置 embed 注释） |
| 10-13 17:46–17:52 | 0.11.0 代码陆续落地（`1125b38` 04:58 遥测、`cce9c08` 05:20 judge 默认关、`85374c2` 17:20、`366b12b` 17:38） | resident 常驻卡片、gate.top1 遥测、judge 提示行 | 首个 `gate(top1)` 10-13 17:46:45；首个 `resident` 10-13 17:52:51（说明 17:46 已加载 0.11.0 主体） | — |
| 10-13 19:30 | 同上 | judge 判定层开始接管"要不要记忆" | 首个 `judge` 事件 10-13 19:30:35（source=rules, skip） | — |
| **10-13 20:07** | **0.11.0（`8cd8776`）** | 判定层 + 闸门 3→0 + carry-over + 常驻卡片；`DSH_G_MEMORY_AUTO_MIN_SCORE` 移除 | 首个 `inject.why=ready` 10-13 23:06；首个 `hint` 10-13 23:17；首个 `late-drop: carried-to-next-turn` 10-14 16:36 | CHANGELOG L28：真实消息 rerank top1 中位 **-1.49**，`gate:3` 砍掉 100%、`gate:0` 放行 39/39；chat judge 14 条里 10 条 fire |
| 10-15 22:44 | tag `v0.11.0` → `7504d82` | 唯一一个 tag，发布整理 | `git tag` | — |
| 10-17 15:04 | **0.12.0（`676d540`）** | `IndexedUnit.sourceKind`；判据从黑名单反转为 fail-closed 白名单；审计/回填/剔除三脚本 | `index/.live-extractor.json = {"extractor":4}`（EXTRACTOR_VERSION 4 已生效）；索引 header 现无 `role=user` 的注入行 | CHANGELOG L3：role=user 的 3,529 行里 **1,729 行（49%）是 harness 自己的话**；修复后删 **1,645** 行，真人 1,800 行全带来源；audit 从 UNVERIFIED → PASS |
| 10-20 20:23–20:58 | 维护（无版本） | 冷启动超时 30s→90s、嵌入/重排改常驻、doctor 补盲区；清索引（8 项陈旧快照 52.8MB 归档 `_archive-20261020`） | `reports/maintenance-20261020.md`；配置 `timeoutMs: 90000`（desktop L121/L132）；stats 中 10-19 6 次 embedding 超时、**10-20 之后 0 次**（仅 10-21 两条 fetch failed） | 维护报告：04:02/04:38 的 6 次超时 = 03:50 重启后果，冷启动劣化到 56.2s / 117.7s > 当时 30s 客户端超时 |
| **10-22 14:16** | **未发布（`ea3e07c`）** | 移植 VCP 2.0 两条臂：`lib/exact.mjs`（引号/日期/tag/路径 → 第三条 RRF 臂）、`lib/timeline.mjs`（月份分层 + `timelineBoost`）；1,648 行新增、`version` 未动、CHANGELOG 无条目 | 用户 10-22 14:27"我已重启" → 符号链接即时生效 | commit message：`test-exact 23 / test-timeline 17 / test-vcp-arms 7；suite 50/54`（4 个红是 live-index/reranker 环境检查） |
| 10-22 17:11 | `2b75882` | 文档：VCP 2.0 / VCPChat 升级审查报告 | `reports/vcp-config-review-20261022.md` | — |
| **10-22 18:35→18:36** | 配置（无 commit） | `policy.gate 0 → -1.0`、`midGate 0 → -1.5`、`judge.threshold 0.5 → 0.4` | 备份 `cordis.patch.yml.bak-before-recall-tune-20261022`（18:35:15）；diff 只改这几行（见 §3） | 生效的硬证据：10-23 03:07:59 首次"负分 pass"，03:08:34 首个 `hint` 的 gateWhy 变成 "long-term floor -1" |
| 10-24 01:47 | — | 本轮审查起点 | stats 末行 | — |

**版本号与 CHANGELOG 日期偏差**：0.6.0 条目标 09-24、提交在 10-02；0.8.0 条目标 10-06、提交在 10-05 23:22；0.9.x 与提交同日。判断改动是否上线时**以提交时间 + 遥测首现为准**，不要用 CHANGELOG 日期。

---

## 3. 配置纪元（E0–E5）与切换证据

> 只有 10-21/10-22 的 5 个 desktop 备份 + 2 个 web 备份；更早的配置值来自 patch 注释里写下的日期化标定（标"注释证据"）。

| 纪元 | 时间窗 | 生效配置 | 证据 |
|---|---|---|---|
| **E0 基线** | 09-23 → 09-24 | 未留档；stats 显示 gate 全 pass、每轮注入 | stats：09-23 gate 35/35 pass、inject 27；对应 CHANGELOG L833 要修的"100% 注入" |
| **E1** | 09-24 → 10-02 23:50 | 未留档；rerank 分作闸门（0.6.0 修好接线） | 注释证据 L145 提到旧 `marginGate: 1.18`；CHANGELOG L606/L833 |
| **E2** | 10-03 → 10-08 05:24 | 同上 + 治理层、蒸馏上线 | `consolidate` 事件 10-06 起 |
| **E3** | **10-08 05:24 → 10-13 20:07** | EG2 + `queryPrefix/docPrefix`、`rerank.maxChars: 800`、`policy.gate = midGate = 3`、`marginGate: 0` | 配置注释 L145-L176（"2026-10-08 重标…取这一档"）；L126/L142 为当日定值 |
| **E4** | **10-13 20:07 → 10-22 18:36** | `gate = midGate = 0`；`judge.provider: chat`（deepseek-v4.1-flash，apiKeyName）；`resident.enabled: true, limit: 2`；`consolidate.enabled: true, minIntervalHours: 2` | CHANGELOG L28 "Changed — 部署层：闸门 3 → 0"；注释 L180 区域的 "⚠️ 2026-10-13：gate 已从 3 降到 0" |
| **E5** | **10-22 18:36 → 今** | `gate: -1.0`、`midGate: -1.5`、`judge.threshold: 0.4`；其余不变 | desktop L180/L181/L213；`diff` 备份见下 |

### 10-22 的唯一一次配置 diff（备份 vs 当前，全文只有 3 个有效数值）

```diff
 policy:
-      gate: 0
-      midGate: 0
+      gate: -1.0
+      midGate: -1.5
       marginGate: 0
 judge:
-      threshold: 0.5
+      threshold: 0.4
```

配置自己的注释给出了动机："24h 统计显示 gate 通过率约一半，drop 的 top1 大多在 -0.06 ~ -2，紧贴 0 边界"——与 stats 一致：E4 的 148 次 drop 里，**98 次 top1 ≥ -1.5**（54 次 ≥ -1.0，44 次在 [-1.5,-1.0)），全部是"被 0 地板误杀"的候选。

### 配置漂移：desktop 与 web 已经不同代

| 项 | desktop | web |
|---|---|---|
| `policy.gate / midGate` | **-1.0 / -1.5**（L180-181） | **3 / 3**（web L147-148） |
| `judge` 段 | 有（chat，threshold 0.4） | **无**（仍为 10-08 之前的策略） |
| `maxChars` / timeout / 前缀 | 800 / 90000 / 有 | 800 / 90000 / 有（同步过） |

web profile 仍跑"闸门 3 + 无判定层"，即 **10-08 的配置**；如果只用 web 端，自动召回在 0.11.0 之后的收益全部拿不到。这也解释了为什么"改 desktop 的配置"能在桌面端观测到效果、而 web 端没有对应遥测。

---

## 4. 召回指标分时段（stats 证据）

### 4.1 纪元汇总

| 纪元 | armed | gate pass / 总 | pass% | judge fire% (chat) | inject | inject/armed | hint | fallback 占比 | resident | consolidate |
|---|---|---|---|---|---|---|---|---|---|---|
| E1 09-24→10-02 | 247 | 87 / 202 | 43.1% | 无判定层 | 77 | 31.2% | — | — | — | 0 |
| E2 10-03→10-08 | 105 | 21 / 76 | 27.6% | 无 | 17 | 16.2% | — | — | — | 6 |
| **E3 10-08→10-13** | **77** | **5 / 63** | **7.9%** | 无 | **6** | **7.8%** | — | — | 0 | 5 |
| **E4 10-13→10-22** | **903** | 219 / 367 | **59.7%** | **57.5%**（362/630） | **238** | **26.4%** | 148 | **5.4%**（37/685） | 108 | 44 |
| **E5 10-22→10-24** | **188** | 51 / 68 | **75.0%** | **58.0%**（69/119） | **46** | **24.5%** | 17 | **16.8%**（24/143） | 18 | 9 |

- E3 的崩塌 = 0.10.0 的 `gate: 3`：10-08 当日 7 次 gate 全 drop、inject=0；10-12 4 次全 drop、inject=0；**10-09~10-11 无遥测**。CHANGELOG L28 自述"自动路径连续 5 天 0 注入"，与 stats 的 10-08/10-12 两日 0 注入吻合（中间 3 天没有事件，不能算作"有注入"）。
- E4 是 0.11.0 的收益：armed 日均 15.4 → 106（总量 77 → 903，两纪元时长不同，看日均）、inject 238 次、注入密度回到 26.4%，同时 `hint` 148 次说明"判定 fire 但闸门全 drop"是常态（占 fire 的 38.9%）。
- E5 闸门放宽后：pass% +15.3pp，但 `inject/armed` **-1.9pp**；分母（armed）也在涨，注入绝对数提升（10-22→10-24 的 46 次 vs E4 日均 28 次）不足以抵消体感落差。

### 4.2 逐日漏斗（关键日）

| 日期 | armed | judge fire | gate pass/总 | inject | 备注 |
|---|---|---|---|---|---|
| 09-23 | 36 | — | 35 / 35 | 27 | 基线：几乎每轮注入 |
| 10-06 | 34 | — | 8 / 29 | 6 | 卡片层复活（首个 consolidate 成功） |
| **10-08** | 9 | — | **0 / 7** | **0** | gate 3 上线当日即归零 |
| **10-12** | 4 | — | **0 / 4** | **0** | 归零第 5 天 |
| 10-13 | 79 | 1 | 5 / 60 | 8 | 0.11.0 当日：判定层 19:30 才上线 |
| 10-14 | 50 | 18 | 10 / 17 | 14 | carry-over 生效（16:36 首现 carried） |
| 10-19 | 179 | 90 | 47 / 84 | 31 | 三次重启日；6 次 embedding 超时 |
| 10-21 | 265 | 122 | 68 / 118 | 61 | E4 注入峰值（61 次） |
| 10-22 | 100 | 48 | 27 / 47 | 32 | 18:35 后配置放宽 |
| **10-23** | 172 | 67 | 49 / 66 | 37 | 放宽后第一个完整日；fallback 21 次 |
| 10-24（至 01:47） | 11 | 2 | 2 / 2 | 7 | 本轮审查会话开始 |

### 4.3 闸门地板生效的硬证据（top1 分布）

| 纪元 | pass top1：min / 中位 / max | 负分 pass | drop top1：min / 中位 / max | drop ∈ [-1.5,-1.0) | drop ≥ -1.0 |
|---|---|---|---|---|---|
| E4（floor 0） | 0.008 / 1.604 / 5.072 | **0** | -5.399 / -1.224 / -0.047 | 44 | 54 |
| E5（floor -1.0/-1.5） | **-0.772** / 1.406 / 5.136 | **8** | -3.122 / **-2.015** / **-1.879** | **0** | **0** |

→ 地板确实按设计工作：E4 里 98 个"≥ -1.5 却被丢"的候选，在 E5 里要么通过（kept=1 的 brief 注入，如 10-23 11:18 pass long -0.309 kept 1），要么仍被 -2 档拒绝（10-23 11:01 drop -1.984 kept 0）。**但"通过"不等于"有内容"：负分通过时 kept 普遍 =1。**

---

## 5. 会话证据：用户诉求 → 改了什么

| 时间 | 会话 | 用户原话（截断） | 随后动作 |
|---|---|---|---|
| 09-20 22:08 | `session-346c84bb` | "去DSH社区看看有没有比较成熟的记忆插件…没有的话看看能不能利用本机部署的BGE-M3来实现跨对话、跨时间的记忆系统" | 立项；方案论证（VCP 参考） |
| 10-13 00:34 | `session-0493a969` | "你其实是有记忆的，而且这个记忆，是我们花掉了十亿以上的token，一点点为你建立起来的，对吧" | 当天 04:27 起调研 VCP / 判定层 / 阈值校准 |
| 10-13 17:22 | `session-184a3f64` | "你来判断怎么做，我需要一个完整可用且可靠度高的记忆系统" | 17:38–20:07 落地 0.11.0（judge/resident/carry-over，gate 3→0） |
| 10-13 17:45 / 17:52 | `session-184a3f64` | 粘贴 `dsh-g-memory@0.10.0 doctor` 输出（26,833 units, 768 dims, model 未记录） | doctor 盲区修复；当晚 0.11.0 |
| 10-20 20:23 | `session-0ca13d6e` | "这两天我在同一个对话聊了很多很多东西，你看下记忆系统运行情况如何" | 20:44 "查清楚，清索引，按你的想法做升级" → `reports/maintenance-20261020.md`（timeout 90s、常驻、清 52.8MB 旧快照） |
| 10-22 12:30 | `session-9cb12d39` | "我们最大的参考VCP更新2.0版本啦…看看它带来了怎样新的记忆系统" | 14:16 `ea3e07c`（exact/timeline 两臂） |
| 10-22 18:13 | `session-9cb12d39` | "回到记忆系统主线，你改造做完了没，还是没开始做呢" | — |
| **10-22 18:25** | `session-9cb12d39` | "你自己试试，反正这两天跑的新对话和token可太多了，**但是几乎没有memory recall**，你看下咋回事" | **18:35 备份 → 18:36 改 gate/midGate/threshold**（同一分钟级因果链） |
| 10-24 00:48 | `session-8301905c` | "我发现这几天用很多token，但是模型几乎没有memory recall或者使用这个插件的其他工具，这是怎么回事" | 本轮审查（即本报告） |

---

## 6. 改造前 vs 改造后：哪些达到、哪些未达预期

### 6.1 达到预期的

| 改造 | 前后对比（stats/文件证据） |
|---|---|
| 0.9.0 卡片蒸馏层复活 | 09-23 时"57 张卡片里只有 2 张蒸馏卡"；现在 `cards.ndjson` **184 张**（10-13 之后日均约 9 张，逐日 2–16），`receipts.ndjson` 75 条（10-06 起） |
| 0.11.0 判定层 + gate 0 救活自动路径 | armed 日均 15.4（E3 5 天 77 次）→ 106（E4 8.5 天 903 次）；inject 日均 1.2 → 28；0 注入的 5 天结束 |
| carry-over | `late-drop` 细分为 carried / superseded / expired（10-14 16:36 起），注入 `why` 区分 ready 232 / carried 5（E4） |
| 0.12.0 索引污染修复 | 1,729/3,529（49%）非真人行被识别；剔除 1,645 行；audit UNVERIFIED → PASS；`.live-extractor.json` = 4 |
| 10-20 冷启动超时 | 10-19 6 次 embedding timeout（30s 客户端放弃）→ 10-20 之后 **0 次** |
| 10-22 闸门地板 | pass% 59.7 → 75.0；98 个"被 0 地板误杀"的候选进入展示；drop 日均 17.4（共 148）→ 13（共 17），且全部 < -1.5 |

### 6.2 未达预期的（按证据强度排序）

1. **judge threshold 0.5 → 0.4 是纯空转。**
   chat 判定 749 条：`recall_project` fire 416、`none` skip 318、`explicit` fire 10、`recall_user` fire 5；**kind≠none 但未 fire 的样本为 0**，置信度带宽 [0.4,0.5) 零样本。代码 `lib/judge.mjs:242`：`fire = kind !== 'none' && (kind === 'explicit' || conf >= threshold)`——阈值只在"非 none、非 explicit、且 conf 恰好在 [0.4,0.5)"时起作用，而模型从不输出这个组合。结果：chat fire 率 57.5% → 58.0%（噪声内）。
2. **放宽闸门没有提高召回密度。** `inject/armed` 26.4% → 24.5%；真正的瓶颈在判定层（只 fire 约一半）与"判定 fire 但检索无结果"（E4 `pass.why=no-armed-result` 4,468 次、`empty` 1,372 次）。10-23 全天 136 次判定 → 67 fire → 49 pass → 37 次注入，即**每 100 次判定注入 27 次**；用户"几乎没 recall"的体感与"注入次数"不是同一口径，但即便按注入算，也只有四分之一。
3. **判定层在 10-22/10-23 退化。** fallback 占比 5.4%（37/685）→ 16.8%（24/143），按日看：10-21 低至 2.9%，10-22 跳到 14.3%（11 次，其中 13:54 起就在出现，**早于 18:36 的配置切换**），10-23 达 15.4%（21 次）。fallback 的 verdict **无一例外是 skip**（37/37、24/24），"模型层不可用"被静默当成"这轮不需要记忆"——这与 0.11.0 "失败一律降级为不检索"的设计一致，但失败率上去等于把召回又关回去一部分。耗时证据把原因指向判定端点而非配置：10-19/10-21/10-22 多为 15.0s 超时（10-22 有 4 次 ≥15s），10-23 的 21 次是 2.5–5.3s 失败（网关/HTTP 错误方向）。
4. **10-22 的 VCP 两条臂上线即不可观测。** `exact` 默认 true（`lib/auto-recall.mjs:142`）、`timelineBoost` 默认 0.15（L149），profile **没有任何对应配置项**（desktop 全文无 `exact`/`timeline`，web 也没有）；stats 18 类事件里**没有一条能归因到这两条臂**（gate 事件只有 verdict/tier/top1/kept/dropped/reranked，没有 per-arm 信息）。同时 `version` 未 bump、CHANGELOG 无条目——**无法判断这次改造对召回是正贡献还是噪声**。
5. **"hint 通道"减少了，但无法证明有效。** hint 从 148（E4）降到 17（E5），方向正确（说明闸门误杀少了）；但 hint 的作用是"提示模型自己调 memory_recall"，而 **stats 没有工具调用遥测**——这一层是黑盒。
6. **配置可回溯性缺口。** 10-21 之前没有任何 `.bak-*`（现有 5 个 desktop 备份全部落在 10-21 07:45 – 10-22 18:35）；E1–E4 的配置值只能靠 patch 注释与 CHANGELOG 反推，无法像 10-22 那样做 diff 复核。
7. **两个 profile 不同代。** desktop 是 E5（-1.0/-1.5 + judge），web 仍是 E3（gate 3 / midGate 3 / 无 judge）。同一插件两套策略，是"改造效果在 web 端观察不到"的直接原因。

---

## 7. 时间线上最该先验证的三件事（给下一轮）

1. **fallback 为什么从 5.4% 涨到 16.8%**：网关（opencode.ai/inference/openai/v1）抖动、`OPENCODE_GO_API_KEY` 凭据解析、还是 15s 超时？需要按 `judge.ms` 与 fallback 相邻事件定位；这部分直接吃掉召回。
2. **注入是否被模型使用**：需要在 `inject` 之外补"注入后模型是否引用/调用 memory_recall"的遥测，否则所有"召回质量"讨论都停在注入率层面。
3. **负分通过是否引入噪声**：E5 已有 8 次负分 pass（最低 -0.772），且负分通过时 kept 基本 =1（brief）。建议统计"kept=1 的 brief 注入"占注入总数的比例（当前逐日看约 4–5 成），并与人评估结合。

---

## 附录 A：证据清单与复现

- 版本/提交：`cd /Users/yangyuxin/.dsh/local-keep/dsh-g-memory && git log --date=iso --pretty=format:'%h|%ad|%cd|%s' --all`、`git tag -l --format='%(refname:short)|%(creatordate:iso)'`、`git show <c>:package.json`
- 各版条目：`CHANGELOG.md`（0.12.0 L3 / 0.11.0 L28 / 0.10.0 L86 / 0.9.6 L115 / 0.9.0 L260 / 0.8.0 L401 / 0.7.0 L432 / 0.6.0 L606）
- 配置与 diff：`~/.dsh/profiles/desktop/cordis.patch.yml`（gate L180-182、threshold L213、embed L121/L126、rerank L132/L142、resident L226、consolidate L254）；`diff -u ~/.dsh/profiles/desktop/cordis.patch.yml.bak-before-recall-tune-20261022 ~/.dsh/profiles/desktop/cordis.patch.yml`；web：`~/.dsh/profiles/web/cordis.patch.yml:147-148`
- 召回事件：`~/.dsh/dsh-g-memory/auto-recall-stats.jsonl`（按脚本 `event` × `t` 聚合；本文所有计数可由该文件逐行解析复现）
- 索引/卡片：`~/.dsh/dsh-g-memory/index/index.ndjson.zstd` 首行 header（`units: 41149, dim: 768, model: embeddinggemma-2, docPrefix: "title: none | text: "`）、`cards.ndjson`（184）、`receipts.ndjson`（75）、`index/.live-extractor.json`（`{"extractor":4}`）
- 既有报告：`reports/maintenance-20261020.md`、`reports/vcp-2.0-memory-study.md`、`reports/vcp-config-review-20261022.md`、`docs/vcp2-memory-adapters.md`
- 会话：`~/.dsh/sessions/--Users-yangyuxin-.dsh-local-keep-dsh-g-memory--/`、`--root--/`、`--Users-yangyuxin--/`；`zstd -dc <file> | python3 -c '<按 type/source.kind 过滤>'`
