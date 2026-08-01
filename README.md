<p align="center">
  <img src="docs/logo.png" alt="open-claude-router Logo" width="120" />
</p>

<h1 align="center">open-claude-router</h1>

<p align="center">
  把任意 OpenAI 兼容上游"包装成" Anthropic Messages API，让 <a href="https://docs.anthropic.com/claude/docs/claude-code">Claude Code</a> 能直接使用。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.18.1+-3B82A6?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" /></a>
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
- **alias 里完成全部配置**：模型映射、上游 URL、上游凭证、服务鉴权、额外网关 header 都能通过 Claude Code alias 注入
- **模型名映射**：客户端保留 `claude-*` 名称以启用 Claude Code 能力，上游收到真实模型名
- **结构化输出与严格工具**：Anthropic `output_config.format` 和 `tools[].strict` 分别映射到 Chat Completions / Responses 的正式结构，不按模型名猜测支持能力
- **上游错误统一交给客户端重试**：上游返回任意非 2xx 时保留原状态码和错误内容，同时响应 `X-Should-Retry: true`，由 Claude Code 使用自身有界重试策略处理；服务端不重复请求上游
- **两种接入方式**：上游信息可以放 HTTP header，也可以直接拼在 URL path 里
- **轻量好部署**：esbuild 打包为单文件，Docker 镜像几十 MB，开箱即用

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
<summary>开发者：自己构建 / 用 npm 跑</summary>

```bash
# 自己构建镜像
docker build -t open-claude-router .
docker run -d --name ocr --restart unless-stopped -p 3457:3457 open-claude-router

# 或直接用 npm 跑（tsx watch 模式）
npm install
npm run dev
```
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
alias ocr-chat="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/chat/completions ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Model: YOUR_UPSTREAM_MODEL' ANTHROPIC_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-6 claude"
```

#### Responses API

Responses 与 Chat 的区别只有上游路径和 `X-Upstream-Format`。`\n` 是 alias 内两个自定义 header 的分隔符，整条 alias 仍然只占 `~/.zshrc` 一行：

```bash
alias ocr-responses="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/responses ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_CUSTOM_HEADERS=$'X-Upstream-Format: responses\nX-Upstream-Model: YOUR_UPSTREAM_MODEL' ANTHROPIC_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-6 claude"
```

保存后重新加载并启动：

```bash
source ~/.zshrc
ocr-chat       # Chat Completions
ocr-responses  # Responses API
```

这里使用 `X-Upstream-Model` 把 Claude Code 的所有模型槽位统一指向一个上游模型，最适合首次配置。如果希望 `/model opus`、`sonnet`、后台 haiku 分别走不同上游模型，再把它替换为：

```text
X-Upstream-Model-Map: claude-opus-4-6=YOUR_OPUS_MODEL,claude-sonnet-4-6=YOUR_SONNET_MODEL,claude-haiku-4-5-20251001=YOUR_HAIKU_MODEL
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
alias ocr-header="ANTHROPIC_BASE_URL=http://127.0.0.1:3457 ANTHROPIC_AUTH_TOKEN='YOUR_ROUTER_ACCESS_TOKEN' ANTHROPIC_CUSTOM_HEADERS=$'X-Upstream-Url: https://upstream.example.com/v1/chat/completions\nX-Upstream-Authorization: Bearer YOUR_UPSTREAM_API_KEY\nX-Upstream-Model: YOUR_UPSTREAM_MODEL' ANTHROPIC_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-6 claude"
```

header 模式使用 Responses 时，把 `X-Upstream-Url` 改为 `/v1/responses`，并在同一个 `ANTHROPIC_CUSTOM_HEADERS` 值中增加 `\nX-Upstream-Format: responses`。

如果服务启用了 `OCR_ACCESS_TOKENS`：

- header 模式的 `ANTHROPIC_AUTH_TOKEN` 填服务访问 token；未启用服务鉴权时该值不会被 Router 校验；
- path 模式则在 `ANTHROPIC_CUSTOM_HEADERS` 中增加 `X-OCR-Token: YOUR_ROUTER_ACCESS_TOKEN`。

`X-Upstream-Headers` 可用于显式添加上游要求的额外 header。Router 不会透传 Claude Code 原始请求头，也不允许覆盖 `authorization`、`content-type`、`accept`、`host`、`x-ocr-token`、`x-upstream-*` 或 hop-by-hop headers。

### 3. 启动 Claude Code

直接执行你写入 `~/.zshrc` 的 alias 即可。正常对话、工具调用和历史回放都会透明转换；若配置了 `X-Upstream-Model-Map`，`/model` 切换会按映射选择真实上游模型。

## 协议覆盖与边界

| 能力 | 默认（Chat Completions） | Responses API |
|---|---|---|
| 文本流式 SSE | ✅ 正式处理 multi-data、LF/CRLF/CR 与跨 chunk UTF-8；兼容 EOF trailing event | 同左 |
| 工具调用（`tool_use` / `tool_result` 双向增量） | ✅ 含现代 `tool_calls` 并行工具；流式工具增量会先按调用缓冲，再输出合法的顺序 block；普通 OpenAI function call 返回为正式 `caller:{type:"direct"}` | ✅ 含并行工具；历史 thinking/text/tool block 通过内部有序表示保真回放为 Responses items。`program` / `program_output`、programmatic/未知 caller，以及响应侧 `compaction` / `function_call_output` 都依赖无法映射的 hosted-runtime 状态，明确返回 502；caller 缺省或 `direct` 正常转换 |
| 顶层多模态图片（base64 / URL） | ✅ 已知 source 精确映射为标准 `image_url`。Anthropic Files API 的 provider-owned `file_id` 不能冒充 OpenAI file id，本地返回 400；已知但畸形的 source 返回 400，未来未知 source 有界文本降级；自描述 data URL 保留 | ✅ 标准 `input_image.image_url`；同样不跨 provider 复用 file id，不按模型名猜视觉能力 |
| `tool_result` 中的图片 / 文件 | ⚠️ Chat 的 tool message 只能放文本；base64/URL 图片及可表示为 `file_data` 的文件会在整组 tool message 后转成标准 user 多模态 sidecar。每组附件前带通用 provenance marker（工具序号 + 完整 ID 的可逆 UTF-16BE/base64url 编码）以保留并行结果归属；视觉/文件输入得以保留，但 text/image 原始交错顺序仍会降级。URL-only 文件转有界文本；`is_error:true` 以前置的稳定 Router metadata marker 保留，false/缺省不改变内容 | ✅ `function_call_output.output` 原生保留 `input_text` / `input_image` / `input_file` 多 block 数组的顺序与归属；`is_error:true` marker 同样保留；纯文本保持 string 以兼容旧端点 |
| 中途 `system` / 工具变更 | ✅ 普通 `messages[].role:"system"` 按正式位置规则保留为 system；direct block 与正式 `mid_conv_system` wrapper 都会展开；`defer_loading`、自定义客户端工具在 `tool_result` 返回的 `tool_reference`，以及 direct `tool_reference` 的 `tool_addition` / `tool_removal` 按历史顺序投影成当前生成应看到的最终工具子集，不把结构指令改成模型可见文本 | 同左；system content part 转正式 `input_text`。Anthropic server-owned tools（web search/fetch、code execution、advisor、tool search、MCP）及其历史块、MCP tool-change reference 没有通用 OpenAI function-tool 同构，明确返回协议错误而不伪造执行责任；内置 typed client tools（bash/computer/memory/text-editor）在实现版本化 schema 映射前同样明确报错，不伪造空 schema；`compaction` / `fallback` / `container_upload` 等 opaque replay block 不会泄漏为模型可见 JSON，而是明确报错 |
| document / file block | ✅ base64 / text source 转 Chat `file_data`；Chat 没有正式 `file_url`，URL source 转含 URL 的有界文本；`source:content` 按原顺序展开 text/image，并用 metadata text 保留 title/context；未来未知 source 有界降级；provider-owned `file_id` 本地 400 | ✅ base64/text/URL 转 `input_file`，`source:content` 原样展开为正式 input parts；同样拒绝跨 provider file id |
| provider-owned replay state | ⚠️ 顶层 `container`、`redacted_thinking`、`compaction` / `container_upload` 等 opaque state 无法跨 Anthropic 与 OpenAI provider 重放，显式返回协议错误；对应 nullable 字段为 null 时是 no-op | 同左；Responses 输出的 compaction / hosted function-output state 同样显式 502，不伪装成普通文本 |
| `/model sonnet` / `opus` / haiku 切换 | ✅ body.model 字段透传 | 同左 |
| 客户端中断（Ctrl+C） | ✅ AbortSignal 传到上游 | 同左 |
| `output_config.effort` / `thinking` budget | ✅ `low/medium/high/xhigh/max` 精确转成 `reasoning_effort`，不按模型名截断；`thinking.type:"enabled"` 必须提供有限整数且 `budget_tokens >= 1024`，不能与强制 `any` / named tool choice 组合；`adaptive` 必须省略 budget | ✅ 显式 effort 精确转成 `reasoning.effort`；没有显式 effort 时，只有合法 enabled budget 才派生 heuristic 档位，adaptive 交给上游默认且允许强制工具 |
| `thinking` 块 / display | ⚠️ 使用兼容扩展 `reasoning_content`；Chat 没有标准 encrypted replay state，Router 因此把上游明文 reasoning 封入自描述 opaque signature。普通模式显示 thinking，显式 `display:"omitted"` 只返回空 thinking + signature，下一轮再无状态解包回原 `reasoning_content`；这保证协议往返，但不是上游原生加密状态 | ✅ reasoning summary / `reasoning_text` 转 thinking；`{item id, encrypted_content}` 封装成 opaque signature，多个 reasoning item 独立封口并按与 tool call 的邻接关系回放。显式 omitted 不请求 detailed summary，但仍请求 encrypted state；缺 id 或 encrypted state 时按上游协议错误处理 |
| 严格工具 / 结构化输出 | ✅ `tools[].strict` 保真；`output_config.format` → `response_format.json_schema` | ✅ 未声明 strict 时显式发送 `strict:false`；`output_config.format` → `text.format` |
| citations / search result | ⚠️ Anthropic `search_result` 的 title/source metadata 与全部非空 text block 按顺序保留；按 Anthropic 正式规则，`tool_result` 一旦含 search result 就不能混入其他可见 block。启用 document/search-result citations，或回放带非空 citations 的 text block 时，因 OpenAI 请求协议无可逆同构，本地 400；`citations:null` / 空数组为 no-op。若同时请求 structured output，优先返回 Anthropic 的 citations/structured-output 冲突 400 | ⚠️ 同左。响应侧 `web_search_call` 与 citation 按有界 typed JSON 文本保留 id/action/query/URL/range；Responses citation 没有 search-call 归属字段，Router 不猜测配对关系 |
| 音频输出 | ⚠️ Chat 非流式 `message.audio.transcript` 转 text；原始音频字节只产生一次 `[generated audio omitted]`，不泄漏 base64 | ⚠️ SSE transcript delta 转 text；audio delta 只产生一次相同占位符，done 不重复 |
| usage / 错误 | ✅ 输出当前 Anthropic Message/Usage nullable 字段，并映射 reasoning tokens 与可从流式首帧确定的 service tier；错误 envelope 含 nullable `request_id` | ✅ Responses reasoning tokens 保留到 Anthropic `thinking_tokens`。402/409/413/504 分别映射 `billing_error` / `conflict_error` / `request_too_large` / `timeout_error`；所有上游非 2xx 仍只请求一次并标记可重试 |
| refusal / content filter | ✅ refusal 文本保留为普通 assistant 文本；`content_filter` 映射 `stop_reason:"refusal"`，并返回 `{type:"refusal",category:null,explanation}` 形式的 `stop_details` | 同左；流式与非流式、SSE 聚合保持一致 |
| incomplete / 截断工具调用 | ✅ Chat `length` 映射 `max_tokens`；调用名/参数原始字节以有界文本诊断保留，不生成可执行 `tool_use` | ✅ response 或任一 function item 为 incomplete 时同样以有界文本保留 partial bytes，`max_tokens` 优先于 `tool_use`；仅完整调用以 `tool_use` 结束 |
| legacy `function_call`（旧式 Chat 工具调用） | ✅ 流式与非流式均归一为 `tool_use`，不会静默丢弃 | 不适用 |
| 流式/非流式形态错位 | ✅ 响应形态永远跟随客户端 `stream` 标志：上游对 `stream:true` 回 JSON 时合成完整 SSE，对 `stream:false` 回 SSE 时聚合成 JSON | 同左 |
| Prompt cache（`cache_control`） | ⚠️ Anthropic 显式 breakpoint 会被剥（避免严格上游 400）；若上游自行报告 cached tokens，usage 会映射返回 | 同左 |
| `count_tokens` 端点 | ⚠️ 服务本地 `js-tiktoken` 粗略估算（非上游精确值） | 同左 |

Router 只做协议转换，不根据模型名猜测视觉、推理或工具能力。标准图片结构仍被文本模型或能力不完整的兼容端点拒绝时，错误属于所选模型 / 上游；Router 会保留上游状态并按既定策略标记为可重试。完整逐字段审计、责任边界和复现证据见 [`docs/protocol-audit-2026-07-31.md`](docs/protocol-audit-2026-07-31.md)。

### 开发验证

当前 0.5.0 候选代码基于 0.4.0 发布提交 `2683537`；该 0.4.0 基线已经包含“所有上游非 2xx 标记 `X-Should-Retry:true`”的既定行为。本轮没有删除或改变该逻辑，并保留了状态码、单次 fetch 和 retry header 的回归测试。

仓库完整验证：

```bash
npm ci
npm run typecheck
npm test
npm run test:stream
npm run build
```

自动化回归、两套真实上游的最新通过数与 `origin/main` A/B 结果记录在[协议审计报告](docs/protocol-audit-2026-07-31.md)。真实矩阵覆盖文本、流式、单/并行工具、base64/URL 图片、document、嵌套 `tool_result`、reasoning 回放和错误边界。唯一 classified skip 是某兼容网关跨请求回放 reasoning item 时返回 409 `item not found / different resource`，且不经过 Router 的直接两轮 Responses 回放也得到同类 409，因此归类为该网关的跨资源状态限制。无效模型 404/502 和该 409 均由 Router 保留状态、Anthropic error envelope 与 `X-Should-Retry:true`；仓库不记录 endpoint、模型名或凭证。可用自己的上游复跑：

```bash
OCR_LIVE_ROUTER_URL=http://127.0.0.1:3457 \
OCR_LIVE_CHAT_URL=<chat-endpoint> \
OCR_LIVE_RESPONSES_URL=<responses-endpoint> \
OCR_LIVE_AUTH='<authorization-value>' \
OCR_LIVE_MODEL=<model> \
npm run test:live
```

### 发布 Docker 镜像

推送版本 tag 时，GitHub Actions 会自动执行类型检查、全部回归、流式验证和构建，通过后发布 `linux/amd64`、`linux/arm64` 多架构镜像并校验 manifest / attestations。发布前须在仓库 Actions secrets 配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`；候选分支应先合入并更新到最新 `main`，tag 必须是 SemVer（可带 `v` 前缀），且版本必须与 `package.json` 完全一致。使用 annotated tag，并显式推送该 tag，避免轻量 tag 被 `--follow-tags` 遗漏：

```bash
git switch main
git pull --ff-only origin main
test "$(node -p 'require("./package.json").version')" = "0.5.0"
test -z "$(git status --porcelain)"
git tag -a v0.5.0 -m "release: 0.5.0"
git push origin main
git push origin refs/tags/v0.5.0
```

稳定版本会发布 `0.5.0`、`0.5` 和 `latest`；预发布版本不会覆盖 `latest`。

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
| `X-Upstream-Model` | 两种模式都可用 | 可选 | 真实上游模型名；提供则覆盖 body 里的 `model` |
| `X-Upstream-Model-Map` | 两种模式都可用 | 可选 | 模型名映射表，格式 `from1=to1,from2=to2`；优先级高于 `X-Upstream-Model` |
| `X-Upstream-Effort-Map` | 两种模式都可用 | 可选 | effort 词汇映射表，格式 `max=xhigh,low=minimal`；左侧必须是 Anthropic effort（`low/medium/high/xhigh/max`）或通配 `*`，右侧为上游词汇原样转发，保留字 `off` 表示整个剥除该字段（例：`*=off` 适配"tools 与 reasoning_effort 不能同时出现"的网关）。不配置时显式 effort 永远精确透传，Router 自身绝不 clamp |
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
| `LOG_LEVEL` | `info` | Pino 日志级别（`trace` / `debug` / `info` / `warn`） |
| `OCR_ACCESS_TOKENS` | unset | 逗号分隔的访问 token 白名单；不设则关闭服务自身鉴权。header 模式校验 `Authorization: Bearer ...`，path 模式校验 `X-OCR-Token` header |
| `OCR_MODEL_LOG_MODE` | `full` | 模型交互日志正文模式：`full` 记录正文、`metadata` 仅记录模型/状态/耗时/字节数、`off` 关闭 |
| `OCR_MODEL_LOG_RETENTION_DAYS` | `7` | 模型交互日志保留的 UTC 自然日数（正整数）；如需关闭请用 `OCR_MODEL_LOG_MODE=off` |
| `OCR_MODEL_LOG_DIR` | `./logs` | 日志目录；官方镜像工作目录下对应 `/app/logs` |
| `OCR_MODEL_LOG_MAX_BODY_BYTES` | `1048576` | 每个请求或响应最多保留的正文 byte 数；超出后只截断日志副本，不影响实际转发 |

> 上游请求默认超时 **1 小时**（`src/utils/upstream.ts`，为长补全 / 推理模型留足余量），目前硬编码、暂不可通过环境变量调整。客户端中断（Ctrl+C）会通过 AbortSignal 立即传到上游。

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
OCR_MODEL_LOG_MODE=metadata npm start
OCR_MODEL_LOG_MODE=off npm start
```

`off` 只停止新增日志，不会主动删除已有文件；重新启用后，启动清理会按当时配置的保留期处理历史文件。

日志写入是 fail-open 的：目录不可写或磁盘异常只会产生一条运行告警，不会改变请求/响应、流式背压、状态码或重试语义。`LOG_LEVEL` 控制的 Pino 运行日志仍写 stdout，其保留期由 Docker/宿主机日志驱动决定，不受上述变量影响。

> `full` 会记录提示词、工具参数/结果以及模型输出，可能包含业务数据；服务不会把 `Authorization`、`X-Upstream-Authorization` 或额外上游 header 写入模型交互日志。多人共享部署可按需要改用 `metadata` 或 `off`。

### 自定义监听地址

`HOST` 默认 `0.0.0.0`（IPv4 通配）。常见场景：

| 场景 | 命令 |
|---|---|
| 本地 npm / 裸跑，仅本机访问 | `HOST=127.0.0.1 npm run dev` |
| 进程层启用 IPv6 双栈 | `HOST=:: npm run dev` |
| 自定义端口 | `PORT=8080 npm run dev` |
| Docker，宿主仅本机访问（**推荐**） | `docker run -d -p 127.0.0.1:3457:3457 riba2534/open-claude-router:latest` |

> ⚠️ Docker bridge 模式（`-p` 端口映射）下，**不要**在容器内设 `HOST=127.0.0.1`——docker-proxy 是从宿主转发到容器 IP（通常 `172.17.x.x`），容器只听 lo 接口会直接连不通。要限制宿主访问范围，改宿主端口绑定（`-p 127.0.0.1:3457:3457`），容器内继续 `0.0.0.0`。

## 常见问题

- **上游错误会重试吗**：会上报为可重试。上游返回任意非 2xx 时，服务保留原状态码和 Anthropic 错误体，并增加 `X-Should-Retry: true`；具体次数和退避由 Claude Code 客户端版本决定。服务自身始终只向上游请求一次，避免服务端重试与客户端重试叠加。
- **上游报 401 / 403**：先确认 `ANTHROPIC_AUTH_TOKEN` 没填反——path 模式（方式 A/C）里它是**上游凭证**、服务鉴权走 `X-OCR-Token`；header 模式（方式 B）里它是**服务鉴权 token**、上游凭证走 `X-Upstream-Authorization`（见[方式对比表](#2-配置-claude-code-alias)）。另外启用了 `OCR_ACCESS_TOKENS` 却没带对应 token 也会被服务拒绝。
- **连不通 / `upstream_unreachable`（502）**：检查上游 URL 是否写全（path 模式要拼到 `/chat/completions` 或 `/responses` 这一级）；Docker 下不要在容器内设 `HOST=127.0.0.1`（见[自定义监听地址](#自定义监听地址)的警告）。
- **上游报 `thinking is enabled but reasoning_content is missing in assistant tool call message`**：部分 DeepSeek / Kimi 式上游在开启 thinking 时，要求带工具调用的 assistant 消息必须携带 `reasoning_content`。服务已自动把 Anthropic `thinking` 转成 `reasoning_content`，并对缺失的历史工具调用消息兜底补全；若仍遇到，请确认运行的是最新版本。
- **上游报未知字段 400（如 `cache_control` / `reasoning`）**：服务默认会剥掉 Anthropic 专有字段，正常不会发生；若你接的是 Responses 协议上游，确认 alias 带了 `X-Upstream-Format: responses`。
- **返回里没有 `cache_read_input_tokens` / 看不到 thinking**：Anthropic `cache_control` breakpoint 不会透传；只有上游 usage 自身报告 cached tokens 时才会返回。Chat 的 thinking 依赖非标准 `reasoning_content` 兼容扩展；需要原生 reasoning 请走方式 C。

## 安全

- 这是**透明转发**服务：上游凭证经服务转发，**务必走 HTTPS**
- 公网部署强烈建议设置 `OCR_ACCESS_TOKENS` 防止扫描滥用
- 日志默认脱敏 `authorization` / `x-upstream-authorization` / `x-upstream-headers` / `x-api-key`（Pino `redact`）
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

本项目的协议转换核心代码移植自 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)（MIT 协议）。我们把它的 transformer 实现包装成一个路由和会话无状态的 HTTP 服务，配合 Claude Code 客户端的 alias 形态使用。协议审计还交叉参考了 CLIProxyAPI 与 claude-code-router 的源码和可执行 fixture；它们是证据来源，不是天然正确或需要机械对齐的实现基线。

## License

MIT
