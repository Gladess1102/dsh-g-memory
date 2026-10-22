# VCPToolBox / VCPChat 整体审查（2026-10-22）

> 审查人：Lead（并行审查 agent 超时未产出，结论基于直接检查与实测）
> 范围：VCP 2.0 升级后的代码/配置、OpenCode 三组网关、启动器、VCPChat 升级与模型分组。

## 结论摘要

- **无阻塞级问题**。两套应用都能启动并跑通关键链路。
- 有 4 个中等风险项（均为设计取舍或运行时数据），4 个轻微项。
- 本轮已修复：assistant arm64 编译、网关 SSE CRLF 兼容、SemanticModelRouter 模型名、启动器 ELECTRON_RUN_AS_NODE。

## 已完成的修复

| 项 | 结果 |
|---|---|
| rust_assistant_engine 编译 | `cargo build --release` 成功，arm64 二进制部署到 `runtime/assistant_core_server-macOS-ARM64/assistant_core_server`，提交 `e2747908`；VCPChat 日志已出现 `Listener adapter initialized: rust`，无 recovery failed |
| 网关 SSE 兼容 | 流式解析前先 `\r\n -> \n` 归一化，避免上游 CRLF 时静默丢事件；重启后 responses/anthropic 流式均以 `[DONE]` 正常结束 |
| SemanticModelRouter | 5 处 `deepseek-flash` → `deepseek-v4.1-flash`，提交 `95626caa` |
| 启动器 | 增加 `unset ELECTRON_RUN_AS_NODE` 并直接调用 Electron 二进制；`ensure_gateway` 在 start/restart 的 start_backend 之前调用 |

## 配置审计

`config.env` provider 布局（实测 /v1/models 与路由一致）：

```
#1 OpenCode Go Chat       127.0.0.1:6010/chat        18 models
#2 llama.cpp              127.0.0.1:11439            1 model
#3 AMD Radeon Cloud       developer.amd.com.cn      5 models
#4 OpenCode Go Responses  127.0.0.1:6010/responses   5 models
#5 OpenCode Go Anthropic  127.0.0.1:6010/anthropic   5 models
```

- 无重复模型（34 unique + 语义路由虚拟模型）。
- embedding 走独立 `EMBEDDING_API_URL=http://127.0.0.1:11439`（embeddinggemma-2，768 维），四处定制均在位（verify 43 通过）。
- 三组经 VCP 端到端实测：`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5` 均 200 且返回 OK；多轮历史转换也正常。

## 中等风险 / 取舍

1. **Responses / Anthropic 组不支持 tools**：网关只转换 messages/max_tokens/temperature/top_p，不转换 tools。需要 Agent 工具调用的场景请用 chat 组模型（文档已标注）。
2. **网关未实现 /v1/models**：VCP 的 `aggregateModels` 会向网关请求模型列表并 404 静默忽略；因 `API_Provider_N_Models` 显式列出模型，路由不受影响，但 UI 的模型列表不会从网关动态补全。
3. **`x-opencode-session` 固定为 `vcp-local-ed07624e5821`**：官方建议每个会话稳定 ID；当前所有 VCP 会话共享一个，可用但 prompt caching 优化有限。若要按会话区分，需要网关从请求头透传 VCP 的会话标识（目前 VCP 请求不带该信息）。
4. **VCPChat `styles/themes.css` 是主题系统写入的用户偏好**（“极简 Aero”），当前未提交。它不是升级产物，保留即可；不要把 `git checkout` 回退当成清理。

## 轻微项

- `rust_assistant_engine/runtime/assistant_core_server-macOS-ARM64/assistant_core_server-macos-x64` 是旧的 x64 副本（约 6M），当前加载的是 arm64 同名文件，x64 冗余可删。
- `VectorStore/*.usearch`（旧版索引，约 1MB）2.0 不再使用，可作回滚依据保留或清理。
- `Plugin/UserAuth/code.bin` 是运行数据，保持未提交是正常状态。
- VCPChat 仓库存在少量 `.DS_Store`（未跟踪），可加入 .gitignore。

## 进程与端口（实测）

```
6005 VCP server / 6006 AdminPanel / 6010 gateway / 11439 embedding / 11436 rerank
gateway: listening -> https://opencode.ai/inference/go
```

## 建议

1. 用启动器重启一次，确认 `ensure_gateway` 在冷启动路径下也能拉起 6010。
2. 如果日常要用 Responses / Anthropic 组做 Agent 任务，再补 tools 转换（工作量主要在 Responses 的 function_call 事件与 Anthropic 的 tool_use 块）。
3. 定期跑 `bash scripts/verify-local-customizations.sh` 与 `npm run doctor`（VCPChat）。
