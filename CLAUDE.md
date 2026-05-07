# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

open-claude-router 是一个**无状态**的 Anthropic Messages API ↔ OpenAI Chat Completions API 协议转换服务。所有上游信息（URL、Authorization、模型名）由请求方逐请求传过来，服务端不读本地配置、不存任何凭证。详细使用文档见 [README.md](./README.md)。

## 常用命令

- `npm run dev` — tsx watch 启动，默认监听 `:3457`
- `npm run typecheck` — `tsc --noEmit`，改动后必跑
- `npm run build` — esbuild 打包成 `dist/server.js` 单文件
- `npm start` — 跑 build 产物
- `docker build -t open-claude-router . && docker run -p 3457:3457 ...`

**项目目前没有自动化测试套件**。验证靠 curl 模拟 Claude Code 请求或开新 terminal 跑 alias 联调；README 的"本地运行"和"配合 Claude Code 使用"两节给出完整步骤。

## 高层架构

### 两种客户端接入模式（关键，单看任何一个文件理解不到）

服务同时支持两种让客户端传上游信息的模式，对应两套路由，最终都汇入 `src/routes/messages.ts` 的 `forwardMessages()`：

1. **Header 模式** — `POST /v1/messages` 静态路由
   - 客户端用 `X-Upstream-Url` / `X-Upstream-Authorization` / `X-Upstream-Model` 三个 header 传上游
   - 服务自身鉴权：`Authorization: Bearer ...` + 环境变量 `OCR_ACCESS_TOKENS` 白名单
   - 解析：`src/utils/auth.ts` 的 `parseUpstreamConfig`

2. **Embedded-path 模式** — `POST /*` catch-all 路由
   - 客户端 `ANTHROPIC_BASE_URL=http://host:port/<完整上游 URL>`，Claude Code 自动追加 `/v1/messages`
   - 服务端砍前导 `/` 和末尾 `/v1/messages`（或 `/v1/messages/count_tokens`），剩下的就是上游 URL
   - 上游 Authorization：`Authorization: Bearer <value>` 剥 Bearer 前缀后原样透传（支持非 Bearer 格式）
   - 解析：`src/utils/auth.ts` 的 `parseUpstreamFromEmbeddedPath`
   - **此模式下 Authorization 即上游凭证**。服务自身鉴权（`OCR_ACCESS_TOKENS` 启用时）改读 `X-OCR-Token` header，由 `checkServiceAuthFromOcrTokenHeader` 处理

### 协议转换核心

`src/transformers/anthropic.ts`（约 1069 行）是 Anthropic ↔ OpenAI 双向转换的实现，包含完整的 SSE 流式状态机（thinking / text / tool_use 三类 content_block 增量对齐）。配套有 `transformers/{thinking,image,errors}.ts` 和 `types/{llm,transformer}.ts`。

修改注意：
- `transformer.logger` 字段**必须**赋值，类内多处 `this.logger.debug(...)` 不带可选链，未赋值会 runtime crash。`routes/messages.ts` 实例化时已通过 `transformer.logger = fastify.log` 处理。
- 这部分代码是协议转换的核心、改动有明显的退化风险（流式状态机隐含很多边界条件）。新增上游兼容性问题应优先在 `utils/strip.ts`、`routes/messages.ts` 这一层解决，而不是直接改 transformer。

### 请求处理流水线

入口路由 → `auth.ts` 解析上游配置 / 校验服务鉴权 → `transformer.transformRequestOut` 把 Anthropic body 转 UnifiedChatRequest → `strip.ts` 递归剥 `cache_control` 和 `reasoning`（避免多数 OpenAI 兼容上游 400） → `upstream.ts` fetch 上游 + 合并 AbortSignal（请求超时 + 客户端断连） → `transformer.transformResponseIn` 把 OpenAI SSE/JSON 转回 Anthropic 格式 → Fastify `reply.send(stream)`。

错误格式统一为 Anthropic 标准 `{ "type": "error", "error": { "type": "...", "message": "..." } }`，状态码映射在 `utils/upstream.ts` 的 `mapUpstreamStatusToAnthropicErrorType`，全局错误兜底在 `server.ts` 的 `setErrorHandler`。

## 重要约束（违反会出问题）

### 开源合规

代码、文档、注释、commit message 中**不能出现**特定企业内部系统相关字符串（如某些公司私有 gateway 的域名、协议头格式、内部 PSM 名等）。这些只允许出现在用户私人配置文件（如 `~/.zshrc` 的 alias）里。新增功能或测试 fixture 时使用 OpenAI 官方域名或抽象占位（`upstream.example.com`）。

### 不透传 Claude Code 原始 headers 给上游

Claude Code 客户端会带 `anthropic-version`、`anthropic-beta`、`x-stainless-*`、`user-agent` 等。**不要 spread `req.headers` 到上游 fetch**，要构造全新的 headers 对象（仅 `Content-Type` + `Authorization`）。`utils/upstream.ts` 的 `callUpstream` 已按此实现，改动时保持。

### Fastify 5 流式响应

`reply.send(webReadableStream)` 直接支持，无需 `Readable.fromWeb`。但**不要在 `setNotFoundHandler` 内 `reply.send(stream)`** — 那个 lifecycle 不兼容，stream 请求会挂起不返回。这就是 embedded-path 模式选用 catch-all `POST /*` 而非 setNotFoundHandler 的原因。

### 上游 Authorization 原值透传

服务端**不解析、不重组**上游 Authorization。Bearer 格式（OpenAI）和非 Bearer 格式（企业网关常见的自定义协议头）都要原样发给上游。仅做 CR/LF header 注入校验。

## 改动指引

| 任务 | 主要文件 |
|---|---|
| 加路由 / 接入新模式 | `src/routes/messages.ts` |
| 改上游解析逻辑 | `src/utils/auth.ts` |
| 改字段剥除规则 | `src/utils/strip.ts` |
| 改超时 / abort / 错误映射 | `src/utils/upstream.ts` |
| 改 token 估算 | `src/utils/tokenizer.ts` |
| 改协议转换 | `src/transformers/anthropic.ts`（vendor，慎改） |

模块系统是 ESM（`"type": "module"`），源码 import 必须带 `.js` 扩展名后缀（TS 编译后生效）。新功能优先看 transformer vendor 里是否已有可复用的方法，不要自己实现 SSE 解析。
