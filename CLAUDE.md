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

两条路径都汇入 `src/routes/messages.ts` 的 `forwardMessages()`。`src/utils/auth.ts` 里：`parseUpstreamConfig`（header 模式上游解析）、`parseUpstreamFromEmbeddedPath`（embedded-path 模式上游解析）、`parseUpstreamFormat`（协议变体），鉴权用 `checkServiceAuth`（header 模式 Bearer）和 `checkServiceAuthFromOcrTokenHeader`（embedded-path 模式 X-OCR-Token）。模型名与额外 header 由 `parseModelMap` + `resolveUpstreamModel`（`X-Upstream-Model-Map` 映射 / `X-Upstream-Model` 覆盖 → `unified.model`）和 `parseUpstreamHeaders`（`X-Upstream-Headers` 白名单 → 转发给上游，含 protected-header / 原型污染防注入）解析；这些 header 两种接入模式都可用，完整清单见 README 的"请求头"表。

> 术语：**unified** = 内部统一请求/响应形态，等同 OpenAI Chat Completions；**embedded-path 模式** = README 里的"path 模式 / 方式 A"（上游 URL 拼在请求 path 里）；**vendor** = 把上游 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) 的 transformer 源码原样拷入本仓库维护。

### 协议转换核心：双 transformer 协作

服务有两个 transformer 实例，按对称方向分工：

| Transformer | 文件 | 方向 | 何时介入 |
|---|---|---|---|
| `AnthropicTransformer` | `src/transformers/anthropic.ts`（~1100 行） | 客户端方向：Anthropic ↔ unified（unified 形态等同 OpenAI Chat Completions） | **永远介入** |
| `OpenAIResponsesTransformer` | `src/transformers/responses.ts`（~840 行） | 上游方向：unified ↔ OpenAI Responses 协议 | 仅当 `X-Upstream-Format: responses` |

请求处理流水线（`forwardMessages`）：

```
client body (Anthropic Messages)
  ↓ anthropic.transformRequestOut
unified  (request.thinking → result.reasoning；保留 cache_control；
           每条 assistant 的 signed thinking 块 → message.thinking)
  ↓ 应用上游模型覆盖  (路由层已用 resolveUpstreamModel 按 X-Upstream-Model-Map /
                       X-Upstream-Model 算出 upstream.model，此处写入 unified.model)
  ↓ scrubAnthropicOnlyFields  (always: 递归剥 cache_control)
  ↓ 分支:
      format=responses:
        scrubResponsesReasoningArtifacts  (剥每条 message 的 thinking /
                                            reasoning_content，防泄漏进 input)
        → responses.transformRequestIn    (消费 unified.reasoning 转成
                                            Responses reasoning:{effort,summary})
      format=chat-completions (默认):
        convertThinkingToReasoningContent  (assistant thinking → reasoning_content；
                                            reasoning 启用时给带 tool_calls 的消息
                                            兜底补 reasoning_content，满足 DeepSeek
                                            类上游"thinking 启用必带 reasoning_content")
        → scrubChatCompletionsIncompatibleFields  (剥顶层 reasoning)
        → [若流式] 注入 stream_options:{include_usage:true}
upstream-shaped body
  ↓ fetch upstream  (callUpstream 构造全新 headers：Content-Type/Authorization/
                     Accept + X-Upstream-Headers 白名单；不 spread 客户端 header)
upstream response
  ↓ [if format=responses] responses.transformResponseOut
unified-shaped response
  ↓ anthropic.transformResponseIn  (含上游 reasoning_content → Anthropic
                                    thinking 块归一化；流式路径额外合成 signature 封口)
client SSE / JSON
```

`format=chat-completions`（默认）时跳过两个 responses 步骤，unified body / response 直接当 Chat Completions 用——这是绝大多数第三方上游的路径。

### 错误格式

服务端所有错误都包装成 Anthropic 标准 `{ "type": "error", "error": { "type": "...", "message": "..." } }`，状态码映射在 `src/utils/upstream.ts` 的 `mapUpstreamStatusToAnthropicErrorType`，全局错误兜底在 `src/server.ts` 的 `setErrorHandler`。模型上游返回任意非 2xx 时，`forwardMessages()` 必须保留原状态码和错误体，并增加 `X-Should-Retry: true`，让 Claude Code 使用自身有界重试策略；router 自身不能再次请求上游，避免两层重试相乘。

## 重要约束（违反会出问题）

### 开源合规

代码、文档、注释、commit message 中**不能出现**特定企业内部系统相关字符串（如某些公司私有 gateway 的域名、协议头格式、内部 PSM 名等）。这些只允许出现在用户私人配置文件（如 `~/.zshrc` 的 alias）里。新增功能或测试 fixture 时使用 OpenAI 官方域名或抽象占位（`upstream.example.com`）。

### 不透传 Claude Code 原始 headers 给上游

Claude Code 客户端会带 `anthropic-version`、`anthropic-beta`、`x-stainless-*`、`user-agent` 等。**不要 spread `req.headers` 到上游 fetch**，要构造全新的 headers 对象（固定 `Content-Type` + `Authorization` + `Accept`，外加 `X-Upstream-Headers` 白名单里客户端显式声明的额外 header）。`utils/upstream.ts` 的 `callUpstream` 已按此实现，改动时保持。`parseUpstreamHeaders`（`auth.ts`）用 `PROTECTED_UPSTREAM_HEADERS` 黑名单 + `x-upstream-*` 前缀禁止客户端覆盖 `authorization` / `host` 等关键 header，改动时这套校验必须保留。

### Fastify 5 流式响应

`reply.send(webReadableStream)` 直接支持，无需 `Readable.fromWeb`。但**不要在 `setNotFoundHandler` 内 `reply.send(stream)`** — 那个 lifecycle 不兼容，stream 请求会挂起不返回。这就是 embedded-path 模式选用 catch-all `POST /*` 而非 setNotFoundHandler 的原因。

### 上游 Authorization 原值透传

服务端**不解析、不重组**上游 Authorization。Bearer 格式（OpenAI）和非 Bearer 格式（企业网关常见的自定义协议头）都要原样发给上游。仅做 CR/LF header 注入校验。

### transformer 的 logger 必须赋值

`anthropic.ts` 内仍有多处裸 `this.logger.debug(...)`（无可选链），未赋值会 runtime crash；`responses.ts` 已统一改为可选链 `this.logger?.`，不再有此风险。`routes/messages.ts` 的 `registerMessagesRoute` 实例化两个 transformer 后都统一赋值 `transformer.logger = fastify.log`，改动时务必保持（重新 vendor `anthropic.ts` 后尤其要确认 logger 仍被赋值）。

## 改动指引

| 任务 | 主要文件 |
|---|---|
| 加路由 / 接入新模式 | `src/routes/messages.ts` |
| 改 count_tokens 端点 | `src/routes/count_tokens.ts`（header 模式独立路由）+ `src/routes/messages.ts` 的 `handleCountTokens`（embedded-path 模式内联）——两处独立实现 |
| 改上游解析 / 模型映射 / 额外 header | `src/utils/auth.ts` |
| 改字段剥除规则 | `src/utils/strip.ts` |
| 改超时 / abort / 错误映射 | `src/utils/upstream.ts` |
| 改 token 估算 | `src/utils/tokenizer.ts` |
| 改 Anthropic ↔ unified 协议转换 | `src/transformers/anthropic.ts`（vendor 自 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)，慎改） |
| 改 unified ↔ Responses 协议转换 | `src/transformers/responses.ts`（vendor 自 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)，慎改） |

模块系统是 ESM（`"type": "module"`），源码 import 必须带 `.js` 扩展名后缀（TS 编译后生效）。新功能优先看 transformer vendor 里是否已有可复用的方法，不要自己实现 SSE 解析。

### 加新上游协议（如 Gemini / Vertex）的 4 步模板

1. **Vendor transformer** 到 `src/transformers/<name>.ts`，按下面"vendor cheat sheet"修
2. **`src/utils/auth.ts`** `UpstreamFormat` 加新枚举值，`parseUpstreamFormat` 加 `if` 分支
3. **`src/routes/messages.ts`** `registerMessagesRoute` new 第三个 transformer 实例 + 赋 logger；`forwardMessages` 当前请求侧是 `if (responses) {…} else {chat}`、响应侧 `if (responses) {…}`——加第三协议前先把请求侧 `else` 显式化为 `else if (format === "chat-completions")` 再追加新分支，响应侧同理，否则新协议会落进 chat 兜底被错误处理
4. **README** 加 `### 方式 D` 示例 + "请求头"表 `X-Upstream-Format` 行的可选值清单

路由层、auth 层、utils 都不动——这是 `X-Upstream-Format` header 设计的扩展点。

### Vendor [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) transformer 的 cheat sheet

> ⚠️ **重新 vendor 前必读：OCR 在 vendor 基础上加了若干运行时功能增强，整体重新 vendor 会静默覆盖丢失它们。** 重新 vendor 后必须逐项 diff 确认这些增强仍在（或手动 re-apply）——它们改变运行时行为，与下面的"类型层修复"性质不同，绝不能当"等价移植"被覆盖：
>
> | 增强 | 位置 | vendor 原版行为 |
> |---|---|---|
> | `tool_choice` Anthropic `any` → OpenAI `required` | `anthropic.ts` `transformRequestOut` | 原样透传 `any`，OpenAI 形态上游 400 |
> | 上游 `reasoning_content`（流式 delta + 非流式 message）→ Anthropic `thinking` 块（流式额外合成 signature 封口） | `anthropic.ts` `transformResponseIn` | 不识别 `reasoning_content`，DeepSeek/Kimi 推理内容被丢弃 |
> | `max_tokens` → `max_output_tokens` 映射、`tool_choice` 扁平化 | `responses.ts` `transformRequestIn` | 直接 `delete max_tokens`（丢失输出长度限制） |
> | 流式多工具 `getToolCallIndex(item.id)` 索引映射 | `responses.ts` `transformResponseOut` | 写死 `index:0`，只支持单工具 |
> | 非流式多 `function_call` 收集（`.filter().map()`） | `responses.ts` `transformResponseOut` | `.find()` 只取第一个 |
>
> 此外，请求侧的 thinking→reasoning_content 转换在 `src/utils/strip.ts`（`convertThinkingToReasoningContent`），不在 transformer 内，重新 vendor 不影响它，但二者协作，改动需一起验证。

上游有 bug fix / 新能力时整体重新 vendor（源文件在 `packages/core/src/transformer/`），避免局部 patch 与上游漂移。每次 vendor 至少要做这些**类型层修复**（运行时等价）才能过 `tsc --strict`：

| 必修 | 位置 | 改成 |
|---|---|---|
| import 路径 | 文件头 | `@/types/...` → `../types/.../js`，`@/api/middleware` → `./errors.js`，`@/utils/...` → `./...js` |
| `import { ChatCompletion }` | 头部 | `import type { ChatCompletion }` |
| `logger?: any;` 字段声明 | 类定义内 | 显式声明，TS strict 才能编译过（上游原版常未声明） |
| `this.logger.debug(...)` 无可选链 | 类内多处 | 改成 `this.logger?.debug(...)`（防御）；同时 `routes/messages.ts` 实例化时赋 logger 仍是必需 |
| 残留 `console.log(...)` | 偶发 | 删除 |
| Stream event 接口缺字段 | 接口定义 | 按代码实际访问的字段补齐（如 Responses 的 `annotation?` / `part?`） |
| `let xxx = null` 推断成 `null` 类型后赋复杂值 | 函数体 | 改成 `let xxx: any = null` |
| `request.parallel_tool_calls = false` 等动态字段赋值 | 函数体 | 用 `(request as any).parallel_tool_calls` |

完整改动列表：把 `src/transformers/anthropic.ts` / `responses.ts` 与 vendor 源文件逐一 `diff` 即可看出全部类型层修复 + 上面列出的功能增强。
