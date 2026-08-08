<p align="center">
  <img src="docs/logo.png" alt="open-claude-router Logo" width="120" />
</p>

<h1 align="center">open-claude-router</h1>

<p align="center">
  把任意 OpenAI 兼容上游"包装成" Anthropic Messages API，让 <a href="https://docs.anthropic.com/claude/docs/claude-code">Claude Code</a> 能直接使用。
</p>

<p align="center">
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-1.97+-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" /></a>
  <a href="https://hub.docker.com/r/riba2534/open-claude-router"><img src="https://img.shields.io/docker/pulls/riba2534/open-claude-router?style=for-the-badge&color=2496ED&logo=docker&logoColor=white" alt="Docker Pulls" /></a>
  <a href="https://github.com/riba2534/open-claude-router/stargazers"><img src="https://img.shields.io/github/stars/riba2534/open-claude-router?style=for-the-badge&color=f5a623" alt="Stars" /></a>
  <a href="https://github.com/riba2534/open-claude-router/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
</p>

---

## 这是什么

[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) 只接受 Anthropic Messages API，但你想用的模型可能跑在 OpenAI 协议上——OpenAI 官方、第三方聚合网关、自托管推理服务。这个项目就是夹在中间的**协议转换桥梁**：

```
Claude Code  ──(Anthropic Messages)──▶  open-claude-router  ──(OpenAI Chat Completions / Responses)──▶  上游
```

跟其他类似工具最大的差异：**路由和会话无状态**。所有上游信息（URL、Authorization、模型名）由客户端逐请求通过 HTTP header 或 URL path 传入——服务端不读 provider 配置、不存任何 API Key、不维护会话状态。一份部署可以同时服务任意客户端、任意上游。为了排查协议兼容问题，服务会把模型侧请求/响应写入本地审计日志（默认保留 7 天，可配置或关闭；Authorization 不写入日志）。

典型场景：

- **个人自部署**：`docker run` 一行起，shell alias 里写你的上游凭证
- **团队共享**：内网起一份部署，每人 alias 里写各自的上游和 token，**凭证完全留在客户端，服务端无需集中管理**
- **多家上游切换**：不同 alias 指向不同上游 / 模型，无需重启服务

## 目录

[特性](#特性) · [架构](#架构) · [快速开始](#快速开始) · [协议覆盖与边界](#协议覆盖与边界) · [API](#api) · [环境变量](#环境变量) · [常见问题](#常见问题) · [安全](#安全) · [致谢](#致谢)

## 特性

- **路由和会话无状态**：服务侧不存任何 API Key、不读 provider 配置、不维护会话状态；上游信息全部由客户端逐请求传入（配置都在客户端 alias 里）
- **模型交互日志**：按请求 ID 记录转换后实际发给上游的 JSON 和上游原始 JSON/SSE，默认按 UTC 天轮转并保留 7 天；正文模式、保留期、目录和单条上限均可配置
- **任意 Authorization 格式**：标准 `Bearer sk-...`、企业网关常见的非 Bearer 自定义协议头都能原样透传
- **完整覆盖 Claude Code 协议**：流式 SSE、工具调用（`tool_use` / `tool_result` 双向增量）、多模态图片、`thinking` 块（覆盖范围与限制见下方["协议覆盖与边界"](#协议覆盖与边界)表）
- **同时支持 OpenAI 两套协议**：默认走 Chat Completions（兼容 OpenAI 官方、OpenRouter、各类 OpenAI 兼容网关 / Kimi / DeepSeek 等），通过 `X-Upstream-Format: responses` opt-in 切到 Responses API（OpenAI o-series / gpt-5 原生协议，含 reasoning summary 转 Anthropic `thinking` 块）
- **alias 里完成全部配置**：Claude Code 标准模型环境变量、上游 URL、上游凭证、服务鉴权和额外网关 header 都能随 alias 注入
- **遵循 Claude Code 模型配置**：通过 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 直接填写真实上游模型；Router 默认原样转发请求体中的 `model`
- **结构化输出与严格工具**：Anthropic `output_config.format` 和 `tools[].strict` 分别映射到 Chat Completions / Responses 的正式结构，不按模型名猜测支持能力
- **上游错误统一交给客户端重试**：上游返回任意非 2xx 时保留原状态码和错误内容，同时响应 `X-Should-Retry: true`，由 Claude Code 使用自身有界重试策略处理；服务端不读取错误文本后修改请求体重发
- **两种接入方式**：上游信息可以放 HTTP header，也可以直接拼在 URL path 里
- **高并发单二进制**：Axum + Tokio + rustls/HTTP2 连接池；流式链路逐 chunk 转换并传播背压与取消，生产镜像只包含 Rust 可执行文件

## 架构

```mermaid
flowchart LR
    Client["Claude Code CLI<br/>shell alias"]
    Bridge["open-claude-router<br/>路由/会话无状态"]
    Upstream[("OpenAI 协议上游<br/>Chat Completions 或 Responses")]

    Client -- "Anthropic Messages API<br/>POST /v1/messages" --> Bridge
    Bridge -- "POST /v1/chat/completions<br/>或 /v1/responses" --> Upstream
    Upstream -. "OpenAI SSE / JSON" .-> Bridge
    Bridge -. "Anthropic SSE / JSON" .-> Client
```

服务收到 Anthropic 协议的请求后，从 HTTP header 或 URL path 解析出真实上游 URL 和 Authorization，把请求体转成对应的 OpenAI 协议（默认 Chat Completions，可通过 `X-Upstream-Format: responses` 切到 Responses API）调用上游，再把上游响应（SSE 流或 JSON）转回 Anthropic 格式返回。路由过程不读 provider 配置、不存任何凭证、不维护会话状态，因此可任意水平扩展；模型交互日志属于独立的运维观测数据，各实例可写各自的目录或集中采集。

## 快速开始

### 1. 启动服务

推荐用 Docker 一键启动（镜像在 [Dockerhub](https://hub.docker.com/r/riba2534/open-claude-router)，amd64 + arm64 双架构）：

```bash
docker pull riba2534/open-claude-router:latest
docker run -d --name ocr --restart unless-stopped -p 3457:3457 \
  -v ocr-model-logs:/app/logs \
  riba2534/open-claude-router:latest
```

服务监听 `:3457`，服务端无需任何配置即可启动。公网部署可加 `-e OCR_ACCESS_TOKENS=token1,token2`（`OCR` 即 open-claude-router 缩写）启用访问鉴权。

启动后验证服务就绪：

```bash
curl http://localhost:3457/healthz   # 预期 {"status":"ok"}
```

> 端口被占用时改宿主端口即可，例如 `-p 13457:3457`，并把下面 alias 里的 `localhost:3457` 同步改成 `localhost:13457`。

<details>
<summary>开发者：本地裸跑</summary>

```bash
# 直接运行 Rust 服务
rustup toolchain install 1.97.1 --profile minimal
cargo run --manifest-path rust/Cargo.toml

# release 二进制
cargo build --locked --release --manifest-path rust/Cargo.toml
./rust/target/release/open-claude-router
```

仓库、测试和生产镜像均只包含 Rust 实现。

> 镜像只能由仓库的 GitHub Actions 发布流程构建并推送。本机和部署机器禁止执行 `docker build` / `docker buildx build`，只允许拉取已发布镜像并做运行验证。
</details>

### 2. 配置单行明文 alias（最推荐）

**本项目最推荐的使用方式，是把完整配置以一条明文 alias 写进个人 `~/.zshrc`。** 这样所有上游配置都跟着 alias 走：平时只需输入 alias 名称即可启动 Claude Code，切换上游时换一个 alias，不需要在 Router 服务端维护 provider 配置。

下面每个 alias 从 `alias` 到最后的 `claude` 都是**同一条物理行**，可直接作为一整行放进 `~/.zshrc`，不要拆成反斜杠续行。示例没有使用任何真实服务信息；复制前只需替换：

- `upstream.example.com`：你的上游域名；
- `YOUR_UPSTREAM_API_KEY`：上游要求的鉴权值；
- `YOUR_UPSTREAM_MODEL`：上游实际模型名。

> alias 会在你的个人 shell 配置中明文保存上游地址和凭证，这是本项目面向个人自部署场景的首选方式。不要把含真实凭证的 `~/.zshrc`、截图或 alias 内容提交到仓库；建议保持 `chmod 600 ~/.zshrc`。

#### Chat Completions：默认格式

```bash
alias ocr-chat="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/chat/completions ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL=YOUR_UPSTREAM_MODEL claude"
```

#### Responses API

Responses 与 Chat 的区别只有上游路径和 `X-Upstream-Format`，整条 alias 仍然只占 `~/.zshrc` 一行：

```bash
alias ocr-responses="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/responses ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Format: responses' ANTHROPIC_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL=YOUR_UPSTREAM_MODEL claude"
```

保存后重新加载并启动：

```bash
source ~/.zshrc
ocr-chat       # Chat Completions
ocr-responses  # Responses API
```

模型名使用 Claude Code 的四个标准环境变量配置，Router 不需要额外做模型映射。上面的单模型示例把四个槽位都指向同一个真实上游模型；如果上游为不同槽位提供不同模型，直接分别填写：

```bash
ANTHROPIC_MODEL=YOUR_DEFAULT_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL=YOUR_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL=YOUR_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL=YOUR_HAIKU_MODEL
```

#### 两个独立选择：接入模式与上游协议

alias 的接入模式和上游协议相互独立，不是三种互斥配置：

| 配置维度 | 选项 | 如何选择 |
|---|---|---|
| 上游信息入口 | path 模式 / header 模式 | path 模式把上游 URL 拼进 `ANTHROPIC_BASE_URL`；header 模式使用 `X-Upstream-Url` 和 `X-Upstream-Authorization` |
| 上游协议 | Chat Completions / Responses | Chat 是默认值；Responses 增加 `X-Upstream-Format: responses` |

上面的两个首选 alias 使用 path 模式。path 中放的是**上游 URL**，上游凭证仍来自 `ANTHROPIC_AUTH_TOKEN`；Claude Code 自动添加的外层 `Bearer ` 会被 Router 剥掉，然后把剩余内容作为上游 Authorization 原样发送：

- 上游需要 `Authorization: Bearer ...` → 写 `ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY'`；
- 上游需要非 Bearer 自定义值 → 把引号内内容替换为上游要求的完整值。

path 模式适合不带 query 的上游 URL。如果上游地址必须包含 `?api-version=...` 等 query，或希望显式分离服务鉴权与上游鉴权，请改用 header 模式：

```bash
alias ocr-header="ANTHROPIC_BASE_URL=http://127.0.0.1:3457 ANTHROPIC_AUTH_TOKEN='YOUR_ROUTER_ACCESS_TOKEN' ANTHROPIC_CUSTOM_HEADERS=$'X-Upstream-Url: https://upstream.example.com/v1/chat/completions\nX-Upstream-Authorization: Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL=YOUR_UPSTREAM_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL=YOUR_UPSTREAM_MODEL claude"
```

header 模式使用 Responses 时，把 `X-Upstream-Url` 改为 `/v1/responses`，并在同一个 `ANTHROPIC_CUSTOM_HEADERS` 值中增加 `\nX-Upstream-Format: responses`。

如果服务启用了 `OCR_ACCESS_TOKENS`：

- header 模式的 `ANTHROPIC_AUTH_TOKEN` 填服务访问 token；未启用服务鉴权时该值不会被 Router 校验；
- path 模式则在 `ANTHROPIC_CUSTOM_HEADERS` 中增加 `X-OCR-Token: YOUR_ROUTER_ACCESS_TOKEN`。

`X-Upstream-Headers` 可用于显式添加上游要求的额外 header。Router 不会透传 Claude Code 原始请求头，也不允许覆盖 `authorization`、`content-type`、`accept`、`host`、`x-ocr-token`、`x-upstream-*` 或 hop-by-hop headers。

### 3. 启动 Claude Code

直接执行你写入 `~/.zshrc` 的 alias 即可。正常对话、工具调用和历史回放都会透明转换；模型选择由 Claude Code 的 `ANTHROPIC_MODEL` 和三个 `ANTHROPIC_DEFAULT_*_MODEL` 标准环境变量决定，Router 原样转发。

## 协议覆盖与边界

| 能力 | 默认（Chat Completions） | Responses API |
|---|---|---|
| 文本流式 SSE | ✅ 正式处理 multi-data、LF/CRLF/CR 与跨 chunk UTF-8；兼容 EOF trailing event | 同左 |
| 工具调用（`tool_use` / `tool_result` 双向增量） | ✅ 含现代 `tool_calls` 并行工具；流式工具增量会先按调用缓冲，再输出合法的顺序 block；普通 OpenAI function call 返回为正式 `caller:{type:"direct"}`。完整终态中的参数若不是 JSON object，按上游协议错误返回 retryable 502 | ✅ 含并行工具；历史 thinking/text/tool block 通过内部有序表示保真回放为 Responses items。`program` / `program_output`、programmatic/未知 caller，以及响应侧 `compaction` / `function_call_output` 都依赖无法映射的 hosted-runtime 状态，明确返回 502；caller 缺省或 `direct` 正常转换 |
| 顶层多模态图片（base64 / URL / file） | ✅ base64 / URL 精确映射为标准 `image_url`；provider-owned `file_id` 无法跨上游安全复用，因此本地 400；已知但畸形的 source 返回 400，未来未知 source 有界文本降级；自描述 data URL 保留 | ✅ URL 转标准 `input_image.image_url`；provider-owned `file_id` 同样不跨 provider 盲传，不按模型名猜视觉能力 |
| `tool_result` 中的图片 / 文件 | ⚠️ Chat 的 tool message 只能放文本；base64/URL 图片及可表示为 `file_data` 的文件会在整组 tool message 后转成标准 user 多模态 sidecar。单个多模态 tool result 依靠相邻顺序归属，不增加模型可见 marker；同批合并多个并行结果时，才在各组附件之后追加通用 provenance marker（工具序号 + 完整 ID 的可逆 UTF-16BE/base64url 编码）。视觉/文件输入得以保留，但 text/image 原始交错顺序仍会降级。URL-only 文件转有界文本；`is_error:true` 以前置的稳定 Router metadata marker 保留，false/缺省不改变内容 | ✅ `function_call_output.output` 原生保留 `input_text` / `input_image` / `input_file` 多 block 数组的顺序与归属；`is_error:true` marker 同样保留；纯文本保持 string 以兼容旧端点 |
| 中途 `system` / 工具变更 | ✅ 普通 `messages[].role:"system"` 按正式位置规则保留为 system；direct block 与正式 `mid_conv_system` wrapper 都会展开；`defer_loading`、自定义客户端工具在 `tool_result` 返回的 `tool_reference`，以及 direct `tool_reference` 的 `tool_addition` / `tool_removal` 按历史顺序投影成当前生成应看到的最终工具子集，不把结构指令改成模型可见文本 | 同左；system content part 转正式 `input_text`。Anthropic server-owned tools（web search/fetch、code execution、advisor、tool search、MCP）及其历史块、MCP tool-change reference 没有通用 OpenAI function-tool 同构，明确返回协议错误而不伪造执行责任；内置 typed client tools（bash/computer/memory/text-editor）在实现版本化 schema 映射前同样明确报错，不伪造空 schema；`compaction` / `fallback` / `container_upload` 等 opaque replay block 不会泄漏为模型可见 JSON，而是明确报错 |
| document / file block | ✅ base64 / text source 转 Chat `file_data`；Chat 没有正式 `file_url`，URL source 转含 URL 的有界文本；`source:content` 按原顺序展开 text/image，并用 metadata text 保留 title/context；未来未知 source 有界降级；provider-owned `file_id` 本地 400 | ✅ base64/text/URL 转 `input_file`，`source:content` 原样展开为正式 input parts；provider-owned `file_id` 不跨 provider 盲传 |
| provider-owned replay state | ⚠️ 顶层 `container`、`redacted_thinking`、`compaction` / `container_upload` 等 opaque state 无法跨 Anthropic 与 OpenAI provider 重放，显式返回协议错误；对应 nullable 字段为 null 时是 no-op | 同左；Responses 输出的 compaction / hosted function-output state 同样显式 502，不伪装成普通文本 |
| `/model sonnet` / `opus` / haiku 切换 | ✅ body.model 字段透传 | 同左 |
| 客户端中断（Ctrl+C） | ✅ 取消当前上游 reader / fetch | 同左 |
| `output_config.effort` / `thinking` budget | ✅ `low/medium/high/xhigh/max` 精确转成 `reasoning_effort`，不按模型名截断；`thinking.type:"enabled"` 必须提供有限整数且 `budget_tokens >= 1024`，不能与强制 `any` / named tool choice 组合；`adaptive` 必须省略 budget | ✅ 显式 effort 精确转成 `reasoning.effort`；没有显式 effort 时，只有合法 enabled budget 才派生 heuristic 档位，adaptive 交给上游默认且允许强制工具 |
| `thinking` 块 / display | ⚠️ 使用兼容扩展 `reasoning_content`；Chat 没有标准 encrypted replay state，Router 因此把上游明文 reasoning 封入自描述 opaque signature。普通模式显示 thinking，显式 `display:"omitted"` 只返回空 thinking + signature，下一轮再无状态解包回原 `reasoning_content`；这保证协议往返，但不是上游原生加密状态 | ✅ reasoning summary / `reasoning_text` 转 thinking；`{item id, encrypted_content}` 封装成 opaque signature，多个 reasoning item 独立封口并按与 tool call 的邻接关系回放。正式回放始终保留必填 id；可见模式下上游没有 encrypted state 时以 id + 可见 reasoning 兜底，显式 omitted 则必须保留 encrypted state |
| 严格工具 / 结构化输出 | ✅ `tools[].strict` 保真；`output_config.format` → `response_format.json_schema` | ✅ 未声明 strict 时显式发送 `strict:false`；`output_config.format` → `text.format` |
| citations / search result | ⚠️ Anthropic `search_result` 的 title/source metadata 与全部非空 text block 按顺序保留；按 Anthropic 正式规则，`tool_result` 一旦含 search result 就不能混入其他可见 block。启用 document/search-result citations，或回放带非空 citations 的 text block 时，因 OpenAI 请求协议无可逆同构，本地 400；`citations:null` / 空数组为 no-op。若同时请求 structured output，优先返回 Anthropic 的 citations/structured-output 冲突 400 | ⚠️ 同左。响应侧 `web_search_call` 与 citation 按有界 typed JSON 文本保留 id/action/query/URL/range；Responses citation 没有 search-call 归属字段，Router 不猜测配对关系 |
| 音频输出 | ⚠️ Chat 非流式 `message.audio.transcript` 转 text；原始音频字节只产生一次 `[generated audio omitted]`，不泄漏 base64 | ⚠️ SSE transcript delta 转 text；audio delta 只产生一次相同占位符，done 不重复 |
| usage / 错误 | ✅ 输出当前 Anthropic Message/Usage nullable 字段，并映射 reasoning tokens 与可从流式首帧确定的 service tier；错误 envelope 含 nullable `request_id` | ✅ Responses reasoning tokens 保留到 Anthropic `thinking_tokens`。402/409/413/504/529 分别映射 `billing_error` / `conflict_error` / `request_too_large` / `timeout_error` / `overloaded_error`；所有上游非 2xx 均标记可重试且 Router 保持单次上游调用 |
| refusal / content filter | ✅ refusal 文本保留为普通 assistant 文本；`content_filter` 映射 `stop_reason:"refusal"`，并返回 `{type:"refusal",category:null,explanation}` 形式的 `stop_details` | 同左；流式与非流式、SSE 聚合保持一致 |
| incomplete / 截断工具调用 | ✅ Chat `length` 映射 `max_tokens`；调用名/参数原始字节以有界文本诊断保留，不生成可执行 `tool_use` | ✅ response 或 function item 明确标记 incomplete 时同样以有界文本保留原始字节并返回 `max_tokens`；完整终态中的畸形参数返回 retryable 502 |
| stop sequence | ⚠️ 请求侧 `stop_sequences` 转 Chat `stop`；Chat 响应只报告通用 `finish_reason:"stop"`，无法恢复命中的具体分隔符 | ⚠️ Responses 没有 stop sequence 请求参数，沿用 TS 行为，在转换时省略该字段 |
| Responses phase / channel | 不适用 | ⚠️ Responses item 的 `phase` / channel 元数据没有 Anthropic Messages 同构字段；Router 保留 reasoning/tool/text 的语义顺序，但不能无损往返 phase 标签 |
| o-series / GPT-5 输出长度 | ⚠️ Chat 路径保留正式 Chat `max_tokens`，不会按模型名猜测并改写成 `max_completion_tokens`；只接受后者的端点应改走 Responses | ✅ Anthropic `max_tokens` 映射为 Responses `max_output_tokens` |
| legacy `function_call`（旧式 Chat 工具调用） | ✅ 流式与非流式均归一为 `tool_use`，不会静默丢弃 | 不适用 |
| 流式/非流式形态错位 | ✅ 响应形态永远跟随客户端 `stream` 标志：上游对 `stream:true` 回 JSON 时合成完整 SSE，对 `stream:false` 回 SSE 时聚合成 JSON | 同左 |
| 需要缓冲的上游响应体 | ⚠️ 与 TS 版本一致，Router 不额外限制 JSON、非 2xx 及 `stream:false` 聚合响应的总大小；直接 SSE 转发也不限制总流量，但单个事件仍受 16 MiB / 65,536 行上限 | 同左 |
| Prompt cache（`cache_control`） | ⚠️ Anthropic 显式 breakpoint 会被剥（避免严格上游 400）；若上游自行报告 cached tokens，usage 会映射返回 | 同左 |
| `count_tokens` 端点 | ⚠️ 与 TS 版本一致，使用 o200k 做简单本地估算（非上游精确值）：统计 system/text、tool input/result、tools，图片使用固定 256 token；其他 block 不额外推断 | 同左 |

Router 只做协议转换，不根据模型名猜测视觉、推理或工具能力。标准图片结构仍被文本模型或能力不完整的兼容端点拒绝时，错误属于所选模型 / 上游；Router 会保留上游状态并按既定策略标记为可重试。无法在两个协议间安全同构的状态会明确报错或使用有界降级，不会被静默丢弃或伪造成可执行工具状态。

### 开发验证

仓库完整验证：

```bash
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path rust/Cargo.toml --all-targets
cargo build --locked --release --manifest-path rust/Cargo.toml
```

协议改动必须同时增加对应的 Rust 单元测试或 `rust/tests/router_contract.rs` HTTP 契约测试。测试 fixture 不得写入真实 endpoint、模型名或凭证。

### 发布 Docker 镜像

推送版本 tag 时，GitHub Actions 会自动执行 Rust fmt/clippy/test 和 release 构建，通过后发布 `linux/amd64`、`linux/arm64` 多架构镜像并校验 manifest / attestations。发布前须在仓库 Actions secrets 配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`；tag 必须是 SemVer（可带 `v` 前缀），且必须与 `rust/Cargo.toml` 一致。使用 annotated tag，并显式推送该 tag：

镜像构建只能在该 GitHub Actions 流程中进行；开发机和部署机不得本地构建镜像，只能使用 `docker pull` 拉取工作流发布的 tag 或 digest。

```bash
version="$(sed -n '/^\[package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' rust/Cargo.toml | head -n 1)"
test -n "$version"
test -z "$(git status --porcelain)"
git tag -a "v${version}" -m "open-claude-router v${version}"
git push origin HEAD
git push origin "refs/tags/v${version}"
```

稳定版本会发布完整版本、major/minor 别名和 `latest`；预发布版本不会覆盖 `latest`。

## API

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/v1/messages` | 主聊天端点（header 模式） |
| `POST` | `/v1/messages/count_tokens` | token 数量本地估算（header 模式） |
| `POST` | `/<完整上游 URL>/v1/messages` | path 模式聊天端点 |
| `POST` | `/<完整上游 URL>/v1/messages/count_tokens` | path 模式 token 估算 |
| `GET`  | `/healthz` | 健康检查 |

### 请求头

| Header | 适用模式 | 必需性 | 说明 |
|---|---|---|---|
| `X-Upstream-Url` | header | ✅ 必需 | 完整上游 URL（含 `/chat/completions` 或 `/responses` 路径） |
| `X-Upstream-Authorization` | header | ✅ 必需 | 上游 Authorization 原值（原样透传、**不剥 Bearer**，请填上游需要的完整值；只有 path 模式的 `Authorization` 才会剥 `Bearer ` 前缀） |
| `X-Upstream-Model` | 两种模式都可用 | 高级兼容、可选 | 固定覆盖 body 里的 `model`。标准 Claude Code 接入应优先使用四个模型环境变量，推荐 alias 不需要配置此 Header |
| `X-Upstream-Model-Map` | 两种模式都可用 | 高级兼容、可选 | 按 body 模型名精确映射，格式 `from1=to1,from2=to2`，优先级高于 `X-Upstream-Model`。仅为已有客户端兼容保留，不是推荐的 Claude Code 模型配置方式 |
| `X-Upstream-Effort-Map` | 两种模式都可用 | 可选 | effort 词汇映射表，格式 `max=xhigh,low=minimal`；左侧必须是 Anthropic effort（`low/medium/high/xhigh/max`）或通配 `*`，右侧为上游词汇原样转发，保留字 `off` 表示整个剥除该字段（例：`*=off` 适配"tools 与 reasoning_effort 不能同时出现"的网关）。不配置时显式 effort 永远精确透传，Router 自身绝不 clamp |
| `X-Upstream-Effort-Levels` | 两种模式都可用 | 可选 | 上游支持的 effort 等级集合，格式 `none,low,medium,high,xhigh`；不在集合内的 effort 按规范等级序 `minimal < low < medium < high < xhigh < max` 就近 clamp，平局取低（例：上游只到 `xhigh` 时 `max` → `xhigh`，上游只到 `high` 时 `max` → `high`）。`none`/`auto` 是开关不是强度，只做精确匹配、永不作为 clamp 目标。与 `X-Upstream-Effort-Map` 同时出现时先按 Map 改写词汇、再按本表 clamp；Map 命中 `off` 则直接剥除、不再 clamp。不配置时显式 effort 永远精确透传 |
| `X-Upstream-Headers` | 两种模式都可用 | 可选 | JSON object，显式声明要额外转发给上游的 header；不能覆盖受保护 header |
| `Authorization: Bearer <token>` | header | 仅 `OCR_ACCESS_TOKENS` 启用时校验 | 服务自身访问鉴权 |
| `X-OCR-Token` | path | 仅 `OCR_ACCESS_TOKENS` 启用时校验 | path 模式下 `Authorization` 被上游凭证占用，服务鉴权改走此 header |
| `X-Upstream-Format` | 两种模式都可用 | 可选 | `chat-completions`（默认）或 `responses`，声明上游 OpenAI 协议变体 |

### Path 模式

把上游完整 URL 直接拼在服务地址后面，例如：

```
http://localhost:3457/https://api.openai.com/v1/chat/completions
```

Claude Code 会自动追加 `/v1/messages`，服务端识别并砍掉这个后缀，剩下的就是上游 URL。上游 Authorization 走标准 `Authorization: Bearer ...` header，服务端剥 `Bearer ` 前缀后原样透传上游。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3457` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `RUST_LOG` | `info` | `tracing` 过滤器，例如 `info`、`open_claude_router=debug,tower_http=info` |
| `LOG_LEVEL` | `info` | 兼容变量；未设置 `RUST_LOG` 时作为运行日志过滤器 |
| `OCR_ACCESS_TOKENS` | unset | 逗号分隔的访问 token 白名单；不设则关闭服务自身鉴权。header 模式校验 `Authorization: Bearer ...`，path 模式校验 `X-OCR-Token` header |
| `OCR_MODEL_LOG_MODE` | `full` | 模型交互日志正文模式：`full` 记录正文、`metadata` 仅记录模型/状态/耗时/字节数、`off` 关闭 |
| `OCR_MODEL_LOG_RETENTION_DAYS` | `7` | 模型交互日志保留的 UTC 自然日数（非负整数）；`0` 等价于关闭日志，与 `OCR_MODEL_LOG_MODE=off` 效果相同 |
| `OCR_MODEL_LOG_DIR` | `./logs` | 日志目录；官方镜像工作目录下对应 `/app/logs` |
| `OCR_MODEL_LOG_MAX_BODY_BYTES` | `1048576` | 每个请求或响应最多保留的正文 byte 数；超出后只截断日志副本，不影响实际转发 |

> 上游请求默认超时 **1 小时**（`rust/src/main.rs`，为长补全 / 推理模型留足余量），目前硬编码、暂不可通过环境变量调整。客户端中断（Ctrl+C）会立即取消当前上游读取。

### 模型交互日志

模型交互日志用于直接核对 Router 的协议边界：`model_request` 是 Anthropic 请求完成转换后、实际发给模型方的 OpenAI JSON；`model_response` 是任何响应转换发生前的上游原始 JSON 或 SSE。二者通过 `request_id` 关联，另含上游 URL（已移除 userinfo、query、fragment）、协议格式、模型、HTTP 状态、耗时、正文 byte 数和是否读到 EOF/因上限截断。SSE transformer 读到协议终态后可以主动停止底层读取，此时会标记 `complete:false, body_cancelled:true`，不代表转换失败；连接上游失败时会写 `model_transport_error`。

日志文件名为 `model-interactions-YYYY-MM-DD.ndjson`，按 UTC 日期切分。服务启动时及运行中每小时清理过期文件；默认保留当天和前 6 个 UTC 日期。修改保留期示例：

```bash
# 查看官方 Docker 示例当前日期的日志
docker exec ocr sh -c 'tail -n 20 /app/logs/model-interactions-$(date -u +%F).ndjson'
```

```bash
# 保留 30 天、每个方向最多记录 4 MiB 正文
docker run -d --name ocr --restart unless-stopped -p 3457:3457 \
  -e OCR_MODEL_LOG_RETENTION_DAYS=30 \
  -e OCR_MODEL_LOG_MAX_BODY_BYTES=4194304 \
  -v ocr-model-logs:/app/logs \
  riba2534/open-claude-router:latest

# 只看元数据，或完全关闭
OCR_MODEL_LOG_MODE=metadata cargo run --manifest-path rust/Cargo.toml
OCR_MODEL_LOG_MODE=off cargo run --manifest-path rust/Cargo.toml
```

`off` 只停止新增日志，不会主动删除已有文件；重新启用后，启动清理会按当时配置的保留期处理历史文件。

日志写入是 fail-open 的：目录不可写或磁盘异常只会产生一条运行告警，不会改变请求/响应、流式背压、状态码或重试语义。`RUST_LOG`（或兼容的 `LOG_LEVEL`）控制 JSON 运行日志并写 stdout，其保留期由 Docker/宿主机日志驱动决定，不受上述变量影响。

> `full` 会记录提示词、工具参数/结果以及模型输出，可能包含业务数据；服务不会把 `Authorization`、`X-Upstream-Authorization` 或额外上游 header 写入模型交互日志。多人共享部署可按需要改用 `metadata` 或 `off`。

### 自定义监听地址

`HOST` 默认 `0.0.0.0`（IPv4 通配）。常见场景：

| 场景 | 命令 |
|---|---|
| 本地裸跑，仅本机访问 | `HOST=127.0.0.1 cargo run --manifest-path rust/Cargo.toml` |
| 进程层启用 IPv6 双栈 | `HOST=:: cargo run --manifest-path rust/Cargo.toml` |
| 自定义端口 | `PORT=8080 cargo run --manifest-path rust/Cargo.toml` |
| Docker，宿主仅本机访问（**推荐**） | `docker run -d -p 127.0.0.1:3457:3457 riba2534/open-claude-router:latest` |

> ⚠️ Docker bridge 模式（`-p` 端口映射）下，**不要**在容器内设 `HOST=127.0.0.1`——docker-proxy 是从宿主转发到容器 IP（通常 `172.17.x.x`），容器只听 lo 接口会直接连不通。要限制宿主访问范围，改宿主端口绑定（`-p 127.0.0.1:3457:3457`），容器内继续 `0.0.0.0`。

## 常见问题

- **上游错误会重试吗**：会上报为可重试。上游返回任意非 2xx、连接/读取超时，或已请求上游后发现 JSON/SSE 畸形、截断、缺少正式终态时，服务保留/映射状态与 Anthropic 错误体，并增加 `X-Should-Retry: true`。本地请求校验 400 不带该 header；只有明确的客户端断开返回 499 且不标记重试。具体次数和退避由 Claude Code 决定，Router 自身始终只请求上游一次。
- **上游报 401 / 403**：先确认 `ANTHROPIC_AUTH_TOKEN` 没填反——path 模式里它是**上游凭证**、服务鉴权走 `X-OCR-Token`；header 模式里它是**服务鉴权 token**、上游凭证走 `X-Upstream-Authorization`（见[两个独立选择：接入模式与上游协议](#两个独立选择接入模式与上游协议)）。另外启用了 `OCR_ACCESS_TOKENS` 却没带对应 token 也会被服务拒绝。
- **连不通 / `upstream_unreachable`（502）**：检查上游 URL 是否写全（path 模式要拼到 `/chat/completions` 或 `/responses` 这一级）；Docker 下不要在容器内设 `HOST=127.0.0.1`（见[自定义监听地址](#自定义监听地址)的警告）。
- **上游报 `thinking is enabled but reasoning_content is missing in assistant tool call message`**：部分 DeepSeek / Kimi 式上游在开启 thinking 时，要求带工具调用的 assistant 消息必须携带 `reasoning_content`。服务已自动把 Anthropic `thinking` 转成 `reasoning_content`，并对缺失的历史工具调用消息兜底补全；若仍遇到，请确认运行的是最新版本。
- **上游报未知字段 400（如 `cache_control` / `reasoning`）**：服务默认会剥掉 Anthropic 专有字段，正常不会发生；若你接的是 Responses 协议上游，确认 alias 带了 `X-Upstream-Format: responses`。
- **o-series / GPT-5 的 Chat 端点拒绝 `max_tokens`**：这类端点通常要求 `max_completion_tokens`。Router 不按模型名猜字段；请把 URL 改为 `/v1/responses` 并设置 `X-Upstream-Format: responses`，此时会发送 `max_output_tokens`。
- **返回里没有 `cache_read_input_tokens` / 看不到 thinking**：Anthropic `cache_control` breakpoint 不会透传；只有上游 usage 自身报告 cached tokens 时才会返回。Chat 的 thinking 依赖非标准 `reasoning_content` 兼容扩展；需要原生 reasoning 请使用 Responses API alias。

## 安全

- 这是**透明转发**服务：上游凭证经服务转发，**务必走 HTTPS**
- 公网部署强烈建议设置 `OCR_ACCESS_TOKENS` 防止扫描滥用
- JSON 运行日志不记录请求 header；模型交互日志只接收转换后的正文和脱敏 URL
- 模型交互日志不记录请求 header，但 `full` 模式会记录提示词、工具内容和模型输出；敏感场景请改用 `OCR_MODEL_LOG_MODE=metadata` 或 `off`
- 不要把上游凭证写入版本控制的文件，用 `~/.zshrc` 或 1Password CLI 等工具按需注入

## Star History

<a href="https://star-history.com/#riba2534/open-claude-router&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date" />
  </picture>
</a>

## 致谢

感谢 [Axum](https://github.com/tokio-rs/axum)、[Tokio](https://tokio.rs/)、[Reqwest](https://github.com/seanmonstar/reqwest)、[Serde](https://serde.rs/) 和 `tiktoken-rs` 等开源项目提供的基础能力。

## License

MIT
