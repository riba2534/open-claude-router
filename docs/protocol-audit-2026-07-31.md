# Anthropic ↔ OpenAI 协议审计（2026-07-31）

本文记录 open-claude-router 0.4.0 基线的请求、响应、流式和错误转换审计。判断依据是 Anthropic Messages、OpenAI Chat Completions / Responses 的正式语义、open-claude-router、CLIProxyAPI、claude-code-router 三个项目的源码及可执行测试；两个参考项目都只用于交叉验证，不被视为天然正确。

## 基线与方法

- 委派 worktree 最初位于 `9c00b8f`（`package.json` 为 0.3.1），落后于实际发布版本。
- 远端 0.4.0 提交是 `2683537d5097a17d57c2a1127a325c21d1b58084`，其父提交 `89cd523` 引入“所有上游非 2xx 均返回 `X-Should-Retry: true`”。
- 同机 `codex/retry-all-upstream-errors` 的 `5fe2f69` 包含等价 retry-all 逻辑，但不是发布提交。
- 发布镜像 `riba2534/open-claude-router:0.4.0` 的 amd64 构建产物同时包含 retry-all 和本次修复前的图片转换代码。当前工作树已先 fast-forward 到精确发布提交，再实施修复。
- 第三个对照项目 claude-code-router 固定在 HEAD `4a152d959c016b476220339e856c9f4f94624c42`。其通用 gateway 转换不是仓库内 MCP 代码，而是 `package-lock.json` 锁定的 `@the-next-ai/ai-gateway@1.0.15`。
- 对锁定 gateway 包同时做了 source map 源码审计和真实进程 fixture：启动其公开 HTTP gateway，以严格 mock Chat / Responses upstream 捕获实际请求体；不是只根据类型或函数名推断行为。
- 测试使用 transformer 单元测试、Fastify inject、严格 mock upstream、实际 0.4.0 镜像代码检查，并运行 CLIProxyAPI 对应 Go translator 测试和 claude-code-router 锁定 gateway fixture。

正式语义参考：

- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- [Anthropic errors](https://platform.claude.com/docs/en/api/errors)
- [OpenAI Chat Completions types](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)
- [OpenAI Responses types](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)
- [OpenAI Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create)

## 图片问题与责任边界

### 根因

1. 顶层 base64 图片已被转换成正确 data URL，但 Chat content part 额外携带非标准 sibling `media_type`。严格兼容端点可以因此返回 400。
2. `formatBase64()` 曾对任何包含字面量 `base64` 的原始数据执行 split。该字面量本身由合法 base64 字符组成，因此会静默截断有效载荷。
3. 非字符串 `tool_result.content` 曾被整体 `JSON.stringify`。text/image 的类型、顺序和视觉语义在进入 Chat 或 Responses transformer 前已经不可逆丢失。

### 最小复现裁决

| 场景 | 修复前上游实际看到的关键结构 | 状态 | 责任 |
|---|---|---:|---|
| 顶层 base64 图片，严格 Chat 端点 | `{"type":"image_url","image_url":{...},"media_type":"image/png"}` | 400 unknown field | Router：发送了非标准字段 |
| 顶层 URL 图片，文本模型 | 标准 `image_url` | 400 model does not support images | 模型 / 上游：Router 不应按模型名猜测能力或删图 |
| `tool_result` text + image，Chat | tool content 是包含 block JSON 的字符串 | 200 | Router：HTTP 成功不代表模型获得 typed image |
| 同一工具结果，Responses | `function_call_output.output` 是同一 JSON 字符串 | 200 | Router：数组在第一阶段已经被压扁 |

这些请求形态与 `stream` 无关，因此流式、非流式、历史回放和工具往返共享同一请求侧责任。回归测试 `tests/image-boundary.test.ts` 使用严格 mock 证明：

- 标准顶层图片不含 `media_type`；
- 文本模型仍可拒绝标准图片，Router 保留 400；
- Chat tool message 保持 text-only，图片进入随后的 user multimodal sidecar；
- Responses 的 `function_call_output.output` 保留 typed `input_text` / `input_image`。

### Chat 与 Responses 的不可同构点

OpenAI Chat 的 `role:"tool"` content 正式只允许字符串或 text part，不能原生容纳 `image_url`。本次实现把整组并行 tool message 保持连续且 text-only，并把图片放到其后的标准 user 多模态 sidecar。图片字节、图片间顺序和视觉输入得以保留，但原始跨模态顺序及图片与某个具体 tool output 的强归属会降级。

Responses 的 `function_call_output.output` 正式允许字符串或 `input_text` / `input_image` / `input_file` 数组，因此可原生保留归属。需要精确多模态工具结果语义时，应优先使用 Responses。

CLIProxyAPI 的 Chat translator 把 `image_url` 直接放进 tool message 数组；一些兼容端点可能接受，但这超出 Chat 正式规范，所以本项目没有机械照抄。其 Codex / Responses translator 能保留 base64 工具图片，但会丢 URL 图片、document 和 unknown block，也是参考项目自身限制。

### claude-code-router 锁定 gateway 的真实 fixture

claude-code-router HEAD `4a152d959c016b476220339e856c9f4f94624c42` 通过 `@the-next-ai/ai-gateway@1.0.15` 执行通用协议转换。对这个精确锁定包运行公开 gateway 后，mock upstream 实际捕获到：

| Anthropic fixture | Chat upstream 实际收到 | Responses upstream 实际收到 | 裁决 |
|---|---|---|---|
| 顶层 base64 image + URL image + text | 仅 text；两张图片均被丢弃 | 仅 `input_text`；两张图片均被丢弃 | 参考 gateway 的明确图片转换缺陷 |
| 仅顶层 image | gateway 本地 400，未请求 upstream | 同左 | 图片先被丢弃，继而触发“无有效 message/system”校验 |
| image-only `tool_result` | Anthropic image block 的 JSON 字符串 | 同一 JSON 字符串 `function_call_output.output` | HTTP 200，但没有视觉语义 |
| text + URL image + unknown + text 的 `tool_result` | 仅 `"left\nright"`，image/unknown 被静默丢弃 | 同左 | 比整体 JSON 降级更不安全；mixed block 不保真 |
| document-only / unknown-only / empty `tool_result` | document/unknown 成为 JSON 字符串；empty 为 `""` | 同左 | 仅无 text 时才保留残余 JSON；没有文件语义 |
| 同一 user turn 的 `tool_result` + follow-up text | tool message 在 user message 前 | user `input_text` 在 `function_call_output` 前 | Chat 顺序正确；Responses 顺序错误 |

fixture 还确认并行 `tool_use` 的 call ID、结果顺序和后续历史 assistant text 可以保留，但 `tool_result.is_error` 最终仍丢失。source map 与运行结果一致：内部 tool-result 形态是 string-only，遇到任何 text 就提前返回拼接文本；因此图片、document 和 unknown block 无法抵达 Responses 正式支持的结构化 output。

claude-code-router 的 Fusion Vision 是显式注册的独立 MCP server，由工具参数自行取图并另发视觉模型请求；它不是 `/v1/messages` 的通用协议转换路径。Router 不得复制这种工具名、业务流程或模型能力判断来掩盖协议转换缺陷。

## 逐项差异矩阵

状态含义：

- **已修复 bug**：正式语义足够明确，且已有回归测试。
- **合理差异**：Router 定位或目标协议不可同构导致的有意选择。
- **参考限制**：CLIProxyAPI 和 claude-code-router 锁定 gateway 本身也不完整，不能作为对齐目标。
- **待验证**：没有足够稳定、通用且可逆的映射，本次不猜测实现。

| 项目 | Anthropic → Chat | Anthropic → Responses | 参考项目对照 | 裁决 / 当前状态 |
|---|---|---|---|---|
| roles | 顶层 system → system；message 仅接受正式 user/assistant | system 统一成为 input 中的 system message | 会识别部分特定 reminder 结构 | 不引入业务 reminder 规则；**合理差异** |
| developer | Anthropic Messages 无同名 message role，不合成 | 同左 | 部分 provider 路径会合成 | 没有可靠来源；**合理差异** |
| system string / block array | text 保序，wrapper `cache_control` 剥除 | string / array 现在走同一 system message 语义 | 实现因 translator 而异 | 原先 Responses 两种输入走 instructions / 多 message，已统一；**已修复 bug** |
| 普通 text content | string 或 text part 保留 | `input_text` / `output_text` | 基本等价 | 正确 |
| 顶层 base64 image | 标准 data URL `image_url`，无额外字段 | 标准 `input_image` data URL | CLI：Chat/Codex 支持；claude-code-router gateway：丢弃 | 非标准 `media_type` 与截断均为**已修复 bug**；参考 gateway 为明确缺陷 |
| 顶层 URL image | 标准 `image_url` | 标准 `input_image` | CLI：Chat 支持、Codex 会丢；claude-code-router gateway：丢弃 | Router 当前更完整；两参考路径各有**参考限制** |
| document / file | 顶层当前无原生映射 | 顶层当前无原生映射 | CLI 多条路径会丢；claude-code-router gateway 的 tool document 仅在无 text 时 JSON 降级 | 需定义 file ID/URL/base64/MIME；**待验证** |
| unknown 顶层 block | 当前忽略 | 当前忽略 | 多数路径忽略 | 应在将来选择显式 400 或安全降级；**待验证** |
| `tool_use` | assistant `tool_calls[]`，ID/name/JSON args 保留 | 每个 call 成为 `function_call` | 基本等价 | 正确 |
| assistant text + `tool_use` 历史 | text 和 calls 均保留 | message 后顺序追加 function calls；原 `[text,tool,text]` 交错位置会归一化 | CLI 会先 flush message；claude-code-router gateway 保留 text/calls | 原先遇 call 就丢全部 text 是**已修复 bug**；block 交错不完全可逆 |
| `tool_result` string | tool string | function output string | 两参考实现基本等价 | 正确 |
| `tool_result` text/image array | text-only tool + user image sidecar；图片字节与图片间顺序保留，跨模态原顺序和具体 tool 强绑定降级 | 原生 output part 数组，跨模态顺序与归属保留 | CLI：Chat 非标准地把 image 放 tool、Codex 仅保 base64；claude-code-router gateway：image-only JSON 化，mixed 时丢 image | 原 JSON stringify 为**已修复 bug**；Chat sidecar 是**合理差异** |
| 同轮 `tool_result` + user text 顺序 | 连续 tool message 后再发 user follow-up | `function_call_output` 后再发 user `input_text` | claude-code-router gateway：Chat 正确、Responses 反序 | Router 当前顺序正确；新增参考回归测试 |
| 空 / 缺省 `tool_result.content` | `""` | output `""` | claude-code-router gateway 同为 `""`；CLI 路径不完全一致 | 原先缺字段或 `"[]"`；**已修复 bug** |
| unknown / document tool-result block | 逐 block compact JSON text fallback，不丢数据 | 逐 block `input_text` fallback | CLI mixed 场景可能丢；claude-code-router gateway 只在无 text 时 JSON 化，mixed 场景静默丢弃 | Router 更安全；document 尚无视觉/文件语义 |
| `tool_result.is_error` | 当前不转发 | 当前不转发 | translator 路径处理不一 | OpenAI 两协议无直接同构 flag；是否编码进文本/状态需设计，**待验证** |
| `tool_choice:any` | `required` | `required` | translator 各异 | 原样 `any` 会被 OpenAI 拒绝；既有修复保留 |
| named tool choice | OpenAI function choice | Responses 扁平 function choice | 基本等价 | 正确 |
| parallel tools request | `disable_parallel_tool_use` 取反映射 | 同左；未指定时不覆盖上游默认 | 支持程度依路径 | 原 Responses 硬编码 false；**已修复 bug** |
| parallel tools stream | 按 OpenAI tool index 缓冲并输出顺序完整 Anthropic block | Responses 先映射 tool index，再走同一状态机 | CLI 有独立事件状态机 | 原先 delta 可写入已关闭 block；**已修复 bug** |
| thinking / effort request | `output_config.effort` 的 `low/medium/high/xhigh/max` 精确转成 `reasoning_effort`；thinking 内容仍使用兼容扩展 `reasoning_content` | 五个显式 effort 精确转成 `reasoning.effort`，不因 thinking 模式或模型名截断；仅在没有合法显式 effort 且 thinking 为 enabled/adaptive 时，沿用既有 `budget_tokens` → none/low/medium/high heuristic | 两个参考项目均含 provider/路径特有的推理映射，不能作为通用 clamp 依据 | disabled 原先可能误启用、显式 effort 原先未映射；均为**已修复 bug**。Router 不按模型能力改写显式值 |
| reasoning history | Chat 保留 reasoning_content 文本，signature 无标准承载 | 请求 encrypted content；Router 把正式必需的 item ID 与 encrypted content 封入自描述 opaque signature，下一轮只解包自身 marker | CLI 会验证 provider signature，但其兼容路径省略 ID | 原生 Claude/未知/合成 signature 不会误传；**已修复并保守降级** |
| reasoning response | `reasoning_content` → thinking，缺 signature 时合成局部占位 | 非流式优先 `reasoning_text`、无正文时回退 summary；流式覆盖 reasoning_text delta/done/item fallback，并按 `content_index` / `summary_index` 去重；`{id, encrypted_content}` → Router signature envelope | 两个参考项目的字段与事件覆盖均随 provider/path 变化 | 原先找错字段、用 item ID 冒充 signature、丢 signature-only/reasoning_text item 或重复/误抑制 fallback；**已修复 bug** |
| `cache_control` | 只剥 protocol wrapper | 同左 | 多数路径剥除 | 原递归删除会破坏 JSON Schema 同名属性；**已修复 bug** |
| metadata / user_id | 当前不转发 | 当前不转发 | 有的映射到 OpenAI user | Anthropic metadata、OpenAI metadata/user/safety_identifier 不同构；**待验证** |
| `max_tokens` | 原样 | `max_output_tokens` | 基本等价 | 正确 |
| `temperature` / `top_p` | 原样 | 原样 | 因模型而异 | Responses 原先无条件删 temperature，top_p 丢失；**已修复 bug** |
| `stop_sequences` | → Chat `stop` | Responses 无直接正式等价，删除 | 部分 translator 丢失 | Chat 原先丢失；**已修复**。Responses 为**合理协议限制** |
| model mapping | header map / override 后写入 body | 同左 | provider 配置驱动 | 无状态 Router 的**合理设计差异** |
| unknown request fields | 仅显式支持字段进入 unified | 同左 | translator 通常白名单 | 防止跨协议泄漏，但新增正式字段需显式支持；**合理差异 / 持续审计** |
| non-stream multiple function calls | 全部转 tool_use | 全部 function_call 收集 | 新版 CLI 收集全部 | 既有增强保留 |
| legacy Chat `function_call` | 未处理，只支持现代 `tool_calls` | 不适用 | CLI 有兼容映射 | OpenAI 旧类型仍保留该字段；**兼容缺口 / 待实现** |
| stop reason | stop/length/tool_calls → end_turn/max_tokens/tool_use | completed/incomplete/tool calls 同步映射 | 映射粒度不同 | `content_filter` 没有无损 Anthropic stop reason，保守映射 end_turn；**合理限制** |
| refusal / content filter | 流式与非流式 `refusal` 保留为普通 assistant text | refusal delta/done/item 与非流式 refusal part 保留为普通 assistant text | 两个参考项目覆盖不一致，不能据此丢弃内容 | refusal 原先会被吞；**已修复 bug**。其 stop reason 仍按上一行保守表达 |
| usage | prompt/completion/cached → Anthropic usage | input/output/cached 同步转换 | 基本等价 | Responses cached usage 原先丢失；**已修复 bug** |
| annotations / web search result | annotation 被配对成 server_tool_use + result | 同左 | 常带 provider 专用 web search | 空 annotation 不再生成 phantom block；不按请求 tool 名猜业务 |
| HTTP errors | Anthropic error envelope，保留 upstream status | 同左 | 错误映射表不同 | 408/409/413 等细分 error type 仍粗粒度；状态不丢，**待细化** |
| 所有 upstream 非 2xx | 单次上游请求，`X-Should-Retry:true` | 同左 | 不作为对齐项 | 用户确认的既定行为；**符合预期、保持不变并新增回归** |
| Chat SSE error chunk | Anthropic `{type:error,error:{...}}`，不追加成功终态 | 同左 | 实现不同 | 原 envelope 错且仍 end_turn；**已修复 bug** |
| SSE framing / chunk boundary | 共享增量 decoder：同 event 多 `data:` 以 LF 拼接，接受 LF/CRLF/CR，并跨 chunk 解码 UTF-8 | 同左 | 两个参考项目均有自己的 parser，行为不能替代正式 framing 测试 | 原先按单次 read/空行 split；**已修复 bug**。EOF 时没有空行的 trailing event 也会 dispatch，这是有意兼容扩展；`[DONE]` 会停止读取但不冒充成功终态 |
| Responses SSE lifecycle | — | created/completed/incomplete/failed/error 映射；model/usage 保留；done-only text/tool/reasoning 有 fallback | 测试覆盖因 provider 而异 | 原先终态和 fallback 被吞；**已修复主要终态**，但 terminal-only 空 completion 仍待验证 |
| SSE 截断 / 聚合 usage | 无终态 EOF 返回 error；终态后继续读取同批 usage-only chunk | 同左 | 状态机实现不同 | 原先截断伪装 end_turn、同一 read 内 usage 丢失；**已修复 bug** |
| unknown / empty SSE | 已知 Chat delta 处理，未知忽略；无任何响应 event 时返回 error | 已知 Responses event 处理，未知忽略；未知终态最终返回 error | 多为白名单 | 不再伪装空 `end_turn`；未来 event 的通用保真仍**待验证** |
| upstream image output | Anthropic assistant 无通用 image output block | 非流式转成安全文本 fallback；流式 image output 未完整表达 | provider 支持不一 | 请求图片不受影响；生成图片需要独立协议设计，**待验证** |

## 已实施改动

- 修正 base64 / URL 图片转换，并移除 Chat 非标准 `media_type`。
- 对 tool result 的 text/image/unknown/empty 内容做结构化转换；Responses 原生保留跨模态顺序与 typed output；Chat 使用标准 user sidecar，并明确记录跨模态顺序/归属降级。
- 新增 `top_p`、Chat `stop`、并行工具参数映射；保留 Responses temperature；disabled thinking 不再误启用。
- 精确映射 `output_config.effort` 的五个正式值；只有未提供合法显式 effort 的既有 Responses thinking 路径继续使用 budget heuristic，不做模型名 clamp。
- Responses 历史同时保留 assistant text 与 function calls；工具名和 schema 完全按用户输入转换，删除特定工具名分支。
- wrapper 字段按协议位置剥除，不再递归破坏用户 JSON Schema。
- 修正并行工具 SSE block 生命周期、stream error envelope、截断检测与聚合 usage；共享 SSE decoder 正式处理 multi-data、LF/CRLF/CR 与跨 chunk UTF-8，并把无空行的 EOF trailing event 作为兼容扩展；malformed event 为致命错误，`[DONE]` 停止读取但不单独构成成功。
- 补 Responses model、usage、incomplete/failure/done-only fallback 与 reasoning_text；Chat/Responses refusal 均保守映射为普通 text；以包含 item ID 的 Router envelope 保留 reasoning encrypted state。
- timeout timer `unref()`，避免短生命周期验证进程被一小时定时器占住；请求 AbortSignal 行为不变。
- 新增 `npm test` 自动化套件。

## 测试证据

`npm test` 覆盖：

- 顶层 base64 / URL 图片、data URL 和包含字面量 `base64` 的合法原始载荷；
- tool result string/text/base64 image/URL image/unknown/empty；
- 同一 Anthropic user turn 中 `tool_result` + follow-up text 到 Responses 的先后顺序；
- document-only 与 mixed text/document tool result 的逐 block JSON 文本安全降级；
- Chat 严格 endpoint、视觉 sidecar、Responses typed function output；
- 文本模型拒绝标准图片的 400 责任边界；
- assistant text + tools、generic tool names、schema 同名字段、thinking/parallel/参数；
- `output_config.effort` 五值在 thinking absent/disabled/enabled/adaptive 下的精确 Chat / Responses 映射、非法值与 budget fallback；
- Chat 并行工具流、流式错误；
- Chat / Responses 同 event 多 `data:`、LF/CRLF/CR、逐字节 UTF-8、EOF trailing event、`[DONE]` 终止读取，以及 malformed event 即使后续存在合法 terminal 也不得合成成功；
- Responses created/completed/incomplete/failed、usage/cache、reasoning signature/reasoning_text、done-only fallback、refusal，流式/非流式；
- 非 2xx 状态表 `300, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 504, 529`：均保留状态、只 fetch 一次、返回 `X-Should-Retry:true`；
- header 与 embedded-path 两种接入；200 和本地 400 不带 retry header。

仓库验收命令：

```bash
npm ci
npm run typecheck
npm test
npm run test:stream
npm run build
```

CLIProxyAPI 对照测试也已运行：

```bash
go test ./internal/translator/openai/claude \
  -run 'TestConvertClaudeRequestToOpenAI_(ToolResultOrderAndContent|ToolResultObjectContent|ToolResultTextAndImageContent|ToolResultURLImageOnly)$' \
  -count=1

go test ./internal/translator/codex/claude \
  -run 'TestConvertClaudeRequestToCodex_PreservesContentOrderAcrossToolAndReasoningItems$' \
  -count=1
```

## 兼容性与发布建议

- Chat tool-result 图片 sidecar 遵守正式 Chat schema，严格端点兼容性优于把 image 直接塞进 tool content；依赖非标准 tool-image 扩展的端点会看到结构变化。需要精确 tool/image 归属时使用 Responses。
- 当前依赖树内的 OpenAI SDK 版本较旧，其 TypeScript 类型仍把 function output 写成 string-only；实现依据是当前正式 Responses 语义。旧 Responses-compatible 网关可能拒绝 output 数组，应在发布说明中明确。
- Responses encrypted reasoning 与产生它的 provider / model 绑定；无状态 Router 会在自描述 envelope 中保留其 item ID 与密文并保真回放，切换到无法解密该历史的模型时，上游可能返回 `invalid_encrypted_content`。Router 不按模型名猜测并静默删历史。
- document/file、metadata、未来 unknown block/event、生成图片输出仍需协议设计，不应为特定模型或工具做特判。
- legacy Chat `function_call`、Responses queued/cancelled 等异步状态、完全没有 content/output item 的 terminal-only 空 completion、citation block 的流/非流位置完全一致性，以及只含空/未知 block 的 system array 仍是兼容缺口；当前现代 Claude Code / OpenAI 主路径不受影响。refusal 内容已保留为普通 assistant text，但 content-filter 仍因 Anthropic 无同构 stop reason 而保守使用 `end_turn`。
- 建议从 0.4.0 发布提交 `2683537` 创建独立修复分支，经上述完整命令和至少一个真实 Chat / Responses 上游 canary 后发布 patch 版本。不要从旧的 `9c00b8f` 或仅 cherry-pick 图片补丁发布，否则容易遗漏 retry-all 或流式配套修复。
- 本次没有部署、推镜像或替换线上版本。所有 upstream 非 2xx 可重试行为保持不变。
