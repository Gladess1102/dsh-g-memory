# 部署配置空间：不绑定特定模型与平台

本插件**不假设**你用哪套嵌入、重排或合成模型，也不假设操作系统。它只要求三件事：
一个 OpenAI 兼容的 `/v1/embeddings`、可选的 `/v1/rerank`、可选的 `/v1/chat/completions`。
下面这些组合都验证过或按同一接口可直接替换。

> 这份文档的存在理由：本插件最初是在一台 Apple Silicon 机器上围绕 **BGE-M3 + bge-reranker-v2-m3 +
> MiniCPM5-2B（MLX）** 开发的，但那是**一套可行配置**，不是架构的一部分。绝大多数用户用 Windows，
> 而 Windows 上 MLX 不可用 —— 硬编码那套等于把多数人挡在门外。

## 一、三个槽位，各自独立可换

| 槽位 | 接口 | 必需性 | 换了会怎样 |
|---|---|---|---|
| **嵌入** | `POST /v1/embeddings` | **必需** | 换模型/维度 → **必须重建索引**（索引里记着 `dim` 与 `model`，不匹配会拒绝加载） |
| **重排** | `POST /v1/rerank`（路径可配） | 强烈建议 | 不可用时闸门退回 RRF 分数：**能跑，但区分度显著下降** |
| **合成** | `POST /v1/chat/completions` | 可选 | 关闭时直接返回原文片段（这是合法且更省的模式） |

**只有嵌入维度是硬约束。** 其余两个随时可换、可关。

## 二、嵌入：任选其一

维度必须与索引一致；换模型后跑 `dsh-g-memory build --fresh` 重建。

| 方案 | 平台 | 维度 | 说明 |
|---|---|---|---|
| **EmbeddingGemma-300M**（当前） | 全平台 | 768 | llama.cpp GGUF Q8_0 约 326 MB。真实记忆语料 + 572 条真实查询的已知项检索上优于 BGE-M3（R@3 96.3%→97.7%，真人原话 R@1 52.1%→69.0%），建索引快 2.4 倍 |
| **BGE-M3** | 全平台 | 1024 | 多语言强；C-MTEB 句对任务仍领先 4.4 分（那测的是对称句相似度，不是"找到这句话指向的记忆"）。GGUF 约 605 MB |
| `bge-small-zh-v1.5` | 全平台 | 512 | 极小（约 95 MB），中文够用，适合低配机器 |
| `nomic-embed-text` | 全平台 | 768 | Ollama 一行拉取，英文强 |
| LM Studio 内置嵌入 | Win/macOS/Linux | 视模型 | GUI 起服务，OpenAI 兼容 |
| 云端（OpenAI / 智谱 / 通义等） | — | 视模型 | 直接填 `baseUrl` + key；代价是记忆内容出本机 |

**换模型必须整体重建，没有"转换向量"这回事**：向量不是在维度之间投影出来的，而是用新模型把同一段文本重新算一遍。构建端有守卫（模型名或维度不符即全量重嵌），卡片端也有守卫（维度不符的卡片静默失效），所以最坏情况是"卡片悄悄检索不到"，而不是算出错误结果。

### 启动嵌入服务（llama.cpp，当前部署方式）

```bash
llama-server -m embeddinggemma-300M-Q8_0.gguf --embeddings \
  --host 127.0.0.1 --port 11439 -c 4096 -b 4096 -ub 2048
```

其他平台同理；Ollama 或 LM Studio 也可以，只要 `DSH_G_MEMORY_EMBED_URL` 与
`DSH_G_MEMORY_EMBED_MODEL` 指对（Windows 上把上面的 `llama-server` 换成
`llama-server.exe`、行尾换成 `^` 即可）。

> **`--embeddings` 不能省**：不带这个标志 llama-server 会回 `501 This server does not support embeddings`。
>
> **物理批大小不能留默认（512）**：超限不是截断，而是 `500 input (N tokens) is too large to
> process`，而客户端把失败当成"保持原顺序"——于是**每一次重排都失败，系统却报告自己健康**。
> 这个坑在本项目里真实踩过。实测分词密度（本机语料，2026-09-24 复测）：
> **嵌入侧 0.522 token/字符**（1,687 字符 → 881 tokens），**重排侧 XLM-R 0.49**
> （800 字符 → 396 tokens）。800 字符的正文片段约 420 tokens 尚可，但 **1200 字符的
> 工具输出片段约 590 tokens，正是它顶穿了 512 的默认批**。两个引擎都加 `-ub 2048`。

## 三、重排：可换、可关

| 方案 | 路径 | 说明 |
|---|---|---|
| **bge-reranker-v2-m3**（当前） | `/v1/rerank` | llama.cpp `--rerank`，GGUF 约 606 MB |
| `bge-reranker-base` | `/v1/rerank` | 更小更快，精度略低 |
| Jina / Cohere / 硅基流动 Rerank API | 各家不同 | 用 `rerank.path` 指定，如 `/v1/rerank` 或 `/rerank` |
| TEI（HuggingFace Text Embeddings Inference） | `/rerank` | 用 `rerank.path: /rerank` |
| **不用** | — | 闸门退回 `rrfFloor()`：**能工作，但触发率会明显升高**（实测 RRF 分数无法区分相关性） |

```yaml
rerank:
  url: http://127.0.0.1:11436
  model: bge-reranker-v2-m3
  path: /v1/rerank        # 换成 /rerank 可对接 TEI 等
  minScore: 0             # 0 = 交叉编码器的自然决策边界
```

**保留重排的建议理由**：本插件的防编造能力建立在交叉编码器的分数上。不用它意味着
闸门只能读 RRF 融合分，而那把尺子实测**两组问题的分数带几乎完全重叠**。

## 四、合成：端侧小模型或干脆不要

合成把 3 个片段压成一句话。它**不是必需**的：关掉后注入原文，由会话本身的模型（云端、强得多）
完成抽取 —— 代价是每轮多约 1100 token。

| 方案 | 平台 | 体积 | 备注 |
|---|---|---|---|
| **MiniCPM5-2B**（当前，MLX） | Apple Silicon | 1.3 GB | 2.6B，中文原生，Apache 2.0 |
| **MiniCPM5-2B GGUF Q4** | **全平台含 Windows** | ~1.6 GB | 走 llama.cpp，Windows 首选 |
| Qwen3.5-2B | 全平台 | 1.6 GB | 实测与 MiniCPM5-2B **逐项打平** |
| Qwen3.5-0.8B | 全平台 | 0.6 GB | 更小；官方警告思考模式易陷入循环 |
| Granite 4.2 3B / Qwen3-4B | 全平台 | 2–3 GB | 更强，但正例质量的提升在噪声内 |
| **不用** | — | 0 | 最省；依赖会话模型自己读片段 |

### 采样参数因模型而异，默认值只对当前模型最优

```yaml
synthesis:
  enabled: true
  baseUrl: http://127.0.0.1:8080/v1
  model: MiniCPM5-2B-Q4_K_M
  # 采样参数按模型官方推荐设置，见 README「采样参数」一节：
  #   MiniCPM5-2B No-Think: temperature 0.7, top_p 0.95
  #   Qwen3.5-2B 非思考文本: temperature 1.0, top_p 1.00, top_k 20, presence_penalty 2.0
```

**实测教训**：本插件曾把 `temperature: 0` 写死，导致两个模型的准确率都被压低
（MiniCPM 14/16、Qwen 12/16）；改成各自官方参数后两者都到 **15/16 并逐项相同**。
**配置错了，会把好模型误判成差模型。**

## 五、平台差异清单

| 项 | macOS | **Windows** | Linux |
|---|---|---|---|
| 端侧模型运行时 | MLX（快）/ llama.cpp / Ollama | **llama.cpp / Ollama / LM Studio**（MLX 无） | llama.cpp / vLLM |
| `zstd` CLI | `brew install zstd` | **需要单独装**（[zstd releases](https://github.com/facebook/zstd/releases) 放 PATH） | `apt install zstd` |
| 路径 | `/` | `\`，配置里用正斜杠或双反斜杠 | `/` |
| 服务托管脚本 | 本仓库的 Python 按需守护 | **需自备**（可用 `nssm`／任务计划程序，或直接常驻） | systemd |

> **`zstd` 是唯一一个"不装就跑不起来"的外部依赖。** 索引优先读 `.zstd` 压缩副本；
> CLI 不可用时会退回明文 `.ndjson`，所以并非硬失败，但**首次构建会失败**。

## 六、最小可用配置（三层递进）

```yaml
# ① 最小：只要嵌入，其它全关
- id: dsh-g-memory
  config:
    embed:  { url: http://127.0.0.1:11439, model: embed-gemma }
    rerank: { url: '' }
    synthesis: { enabled: false }

# ② 推荐：加交叉编码器闸门（防编造的关键）
- id: dsh-g-memory
  config:
    embed:  { url: http://127.0.0.1:11439, model: embed-gemma }
    rerank: { url: http://127.0.0.1:11436, path: /v1/rerank, minScore: 0 }
    synthesis: { enabled: false }

# ③ 完整：加合成与耐久卡片层
- id: dsh-g-memory
  config:
    embed:  { url: http://127.0.0.1:11439, model: embed-gemma }
    rerank: { url: http://127.0.0.1:11436, minScore: 0 }
    policy: { marginGate: 1.18 }   # 头部分离度闸门：前 3 名分差 < 1.18 就整轮不注入
    synthesis: { enabled: true, baseUrl: http://127.0.0.1:8080/v1, model: MiniCPM5-2B-Q4_K_M }
    consolidate: { enabled: true, minIntervalHours: 24, minTurns: 5 }
```

**从 ① 开始，按需往上加。** 这也是 dsh-mneme 文档的忠告：
"配置时应从最少必要记忆层开始，观察真实召回结果后再增加增强能力。"

## 七、换嵌入模型 = 必须重建索引

```bash
dsh-g-memory build --fresh      # 忽略旧索引与断点，全部重新嵌入
```

索引头部记录 `dim` 与 `model`；不匹配时加载会拒绝并说明原因，不会静默给出错误结果。
