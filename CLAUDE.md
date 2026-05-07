# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

open-claude-router 是一个**无状态**的 Anthropic Messages API ↔ OpenAI 协议（Chat Completions / Responses）转换服务。所有上游信息（URL、Authorization、模型名）由请求方逐请求传过来，服务端不读本地配置、不存任何凭证。客户端通过 HTTP header `X-Upstream-Format` 选择上游协议变体（不传或 `chat-completions` = 默认；`responses` = OpenAI o-series / gpt-5 原生协议）。详细使用文档见 [README.md](./README.md)。

## 常用命令

- `npm run dev` — tsx watch 启动，默认监听 `:3457`
- `npm run typecheck` — `tsc --noEmit`，改动后必跑
- `npm run build` — esbuild 打包成 `dist/server.js` 单文件
- `npm start` — 跑 build 产物
- `docker buildx build --platform linux/amd64,linux/arm64 -t riba2534/open-claude-router:latest --push .` — 推 Dockerhub（多架构）

**项目目前没有自动化测试套件**。验证靠 curl 模拟 Claude Code 请求或开新 terminal 跑 alias 联调；README 的"快速开始"段给出完整步骤。

## 高层架构

### 两种客户端接入模式 + 一个协议选择 header

服务的两种接入模式 + 协议选择 header 是相互正交的——任意组合都成立：

| 路由 | mode | 上游凭证来源 | 服务自身鉴权（仅 `OCR_ACCESS_TOKENS` 启用时） | `X-Upstream-Format` |
|---|---|---|---|---|
| `POST /v1/messages` | header 模式 | `X-Upstream-Authorization` header | `Authorization: Bearer <service token>` | 可选 |
| `POST /*` catch-all（path 以 `/http(s)://` 开头） | embedded-path 模式 | `Authorization: Bearer <upstream value>`（剥 Bearer 前缀） | `X-OCR-Token` header（因为 Authorization 被上游凭证占用） | 可选 |

两条路径都汇入 `src/routes/messages.ts` 的 `forwardMessages()`，path 解析在 `src/utils/auth.ts` 的 `parseUpstreamConfig` / `parseUpstreamFromEmbeddedPath` / `parseUpstreamFromOcrTokenHeader` / `parseUpstreamFormat`。

### 协议转换核心：双 transformer 协作

服务有两个 transformer 实例，按对称方向分工：

| Transformer | 文件 | 方向 | 何时介入 |
|---|---|---|---|
| `AnthropicTransformer` | `src/transformers/anthropic.ts`（~1069 行） | 客户端方向：Anthropic ↔ unified（unified 形态等同 OpenAI Chat Completions） | **永远介入** |
| `OpenAIResponsesTransformer` | `src/transformers/responses.ts`（~800 行） | 上游方向：unified ↔ OpenAI Responses 协议 | 仅当 `X-Upstream-Format: responses` |

请求处理流水线（`forwardMessages`）：

```
client body
  ↓ anthropic.transformRequestOut
unified
  ↓ scrubAnthropicOnlyFields  (剥 cache_control + reasoning，避免严格上游 400)
  ↓ [if format=responses] responses.transformRequestIn
upstream-shaped body
  ↓ fetch upstream  (callUpstream 构造全新 headers，不透传客户端 header)
upstream response
  ↓ [if format=responses] responses.transformResponseOut
unified-shaped response
  ↓ anthropic.transformResponseIn
client SSE / JSON
```

`format=chat-completions`（默认）时跳过两个 responses 步骤，unified body / response 直接当 Chat Completions 用——这是绝大多数第三方上游的路径。

### 错误格式

服务端所有错误都包装成 Anthropic 标准 `{ "type": "error", "error": { "type": "...", "message": "..." } }`，状态码映射在 `src/utils/upstream.ts` 的 `mapUpstreamStatusToAnthropicErrorType`，全局错误兜底在 `src/server.ts` 的 `setErrorHandler`。

## 重要约束（违反会出问题）

### 开源合规

代码、文档、注释、commit message 中**不能出现**特定企业内部系统相关字符串（如某些公司私有 gateway 的域名、协议头格式、内部 PSM 名等）。这些只允许出现在用户私人配置文件（如 `~/.zshrc` 的 alias）里。新增功能或测试 fixture 时使用 OpenAI 官方域名或抽象占位（`upstream.example.com`）。

### 不透传 Claude Code 原始 headers 给上游

Claude Code 客户端会带 `anthropic-version`、`anthropic-beta`、`x-stainless-*`、`user-agent` 等。**不要 spread `req.headers` 到上游 fetch**，要构造全新的 headers 对象（仅 `Content-Type` + `Authorization` + `Accept`）。`utils/upstream.ts` 的 `callUpstream` 已按此实现，改动时保持。

### Fastify 5 流式响应

`reply.send(webReadableStream)` 直接支持，无需 `Readable.fromWeb`。但**不要在 `setNotFoundHandler` 内 `reply.send(stream)`** — 那个 lifecycle 不兼容，stream 请求会挂起不返回。这就是 embedded-path 模式选用 catch-all `POST /*` 而非 setNotFoundHandler 的原因。

### 上游 Authorization 原值透传

服务端**不解析、不重组**上游 Authorization。Bearer 格式（OpenAI）和非 Bearer 格式（企业网关常见的自定义协议头）都要原样发给上游。仅做 CR/LF header 注入校验。

### 两个 transformer 的 logger 必须赋值

两个 transformer 类内多处 `this.logger.debug(...)` 不带可选链，未赋值会 runtime crash。`routes/messages.ts` 的 `registerMessagesRoute` 实例化时已统一赋值 `transformer.logger = fastify.log`，改动时务必保持。

## 改动指引

| 任务 | 主要文件 |
|---|---|
| 加路由 / 接入新模式 | `src/routes/messages.ts` |
| 改上游解析逻辑 | `src/utils/auth.ts` |
| 改字段剥除规则 | `src/utils/strip.ts` |
| 改超时 / abort / 错误映射 | `src/utils/upstream.ts` |
| 改 token 估算 | `src/utils/tokenizer.ts` |
| 改 Anthropic ↔ unified 协议转换 | `src/transformers/anthropic.ts`（外部移植代码，慎改） |
| 改 unified ↔ Responses 协议转换 | `src/transformers/responses.ts`（外部移植代码，慎改） |

模块系统是 ESM（`"type": "module"`），源码 import 必须带 `.js` 扩展名后缀（TS 编译后生效）。新功能优先看 transformer vendor 里是否已有可复用的方法，不要自己实现 SSE 解析。

### 加新上游协议（如 Gemini / Vertex）的 4 步模板

1. **Vendor transformer** 到 `src/transformers/<name>.ts`，按下面"vendor cheat sheet"修
2. **`src/utils/auth.ts`** `UpstreamFormat` 加新枚举值，`parseUpstreamFormat` 加 `if` 分支
3. **`src/routes/messages.ts`** `registerMessagesRoute` new 第三个 transformer 实例 + 赋 logger，`forwardMessages` 加 `else if (format === "<name>")` 分支
4. **README** 加 `### 方式 D` 示例 + "请求头"表 `X-Upstream-Format` 行的可选值清单

路由层、auth 层、utils 都不动——这是 `X-Upstream-Format` header 设计的扩展点。

### 移植 transformer 的 cheat sheet

外部源码有 bug fix / 新能力时整体重新移植，避免局部 patch 与原版漂移。每次移植至少要做这些**类型层修复**（运行时等价）才能过 `tsc --strict`：

| 必修 | 位置 | 改成 |
|---|---|---|
| import 路径 | 文件头 | `@/types/...` → `../types/.../js`，`@/api/middleware` → `./errors.js`，`@/utils/...` → `./...js` |
| `import { ChatCompletion }` | 头部 | `import type { ChatCompletion }` |
| `logger?: any;` 字段声明 | 类定义内 | 显式声明，TS strict 才能编译过（原版常未声明） |
| `this.logger.debug(...)` 无可选链 | 类内多处 | 改成 `this.logger?.debug(...)`（防御）；同时 `routes/messages.ts` 实例化时赋 logger 仍是必需 |
| 残留 `console.log(...)` | 偶发 | 删除 |
| Stream event 接口缺字段 | 接口定义 | 按代码实际访问的字段补齐（如 Responses 的 `annotation?` / `part?`） |
| `let xxx = null` 推断成 `null` 类型后赋复杂值 | 函数体 | 改成 `let xxx: any = null` |
| `request.parallel_tool_calls = false` 等动态字段赋值 | 函数体 | 用 `(request as any).parallel_tool_calls` |

完整修复列表见 `src/transformers/responses.ts` 移植时的 commit diff。
