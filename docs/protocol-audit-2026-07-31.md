# Anthropic ↔ OpenAI 协议审计（2026-07-31）

本文记录 open-claude-router 0.4.0 基线的请求、响应、流式和错误转换审计。判断依据是 Anthropic Messages、OpenAI Chat Completions / Responses 的正式语义、open-claude-router、CLIProxyAPI、claude-code-router 三个项目的源码及可执行测试；两个参考项目都只用于交叉验证，不被视为天然正确。

> 2026-08-01 收口：在第二轮对抗式审查后继续补齐 document/file、typed tool output、thinking budget、refusal `stop_details`、响应形态归一化及 incomplete tool 安全终态，并完成自动化与脱敏真实上游验证。当前代码是基于 0.4.0 发布基线的 0.5.0 候选。

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
- [Anthropic mid-conversation system messages and tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- [Anthropic deferred tools and tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
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
- Responses 的 `function_call_output.output` 保留 typed `input_text` / `input_image` / `input_file` 多 block 数组。

### Chat 与 Responses 的不可同构点

OpenAI Chat 的 `role:"tool"` content 正式只允许字符串或 text part，不能原生容纳 `image_url`。本次实现把整组并行 tool message 保持连续且 text-only，并把图片放到其后的标准 user 多模态 sidecar。每组附件前加入通用 provenance marker：工具在请求历史中的序号，加完整 `tool_call_id` 的可逆 UTF-16BE/base64url 编码。这样不会把任意 ID 当作自然语言，也不会因长公共前缀截断碰撞；图片字节、图片间顺序和并行结果归属可恢复。该 marker 仍是模型可见的有损兼容编码，不是 Chat 正式关联字段，text/image 的原始交错顺序无法同构。

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
| roles | 顶层 system → system；user/assistant 与普通中途 system 按原位置保留，并校验 system placement | system content part → `input_text`，角色和位置不变 | 会识别部分特定 reminder 结构 | 不引入业务 reminder 规则；原先丢弃 Claude Code 实际 system message 为**已修复 bug**。依赖 Anthropic server-tool result 的 system 历史因执行责任不可同构而明确 400 |
| developer | Anthropic Messages 无同名 message role，不合成 | 同左 | 部分 provider 路径会合成 | 没有可靠来源；**合理差异** |
| system string / block array | text 保序，wrapper `cache_control` 剥除 | string / array 现在走同一 system message 语义 | 实现因 translator 而异 | 原先 Responses 两种输入走 instructions / 多 message，已统一；**已修复 bug** |
| 普通 text content | string 或 text part 保留 | `input_text` / `output_text` | 基本等价 | 正确 |
| 顶层 base64 image | 已知 base64 source → 标准 data URL `image_url`，无额外字段；缺 media type 的裸 payload 不猜格式，自描述 data URL 保留 | 标准 `input_image` data URL | CLI：Chat/Codex 支持；claude-code-router gateway：丢弃 | 非标准 `media_type` 与截断、缺类型时默认猜 image/png 均为**已修复 bug**；参考 gateway 为明确缺陷 |
| 顶层 URL / file_id image | 已知 URL source → 标准 `image_url`；Anthropic Files API 的 provider-owned file source 本地 400，不冒充 OpenAI file id | URL → `input_image.image_url`；同样拒绝跨 provider file id | CLI：Chat 支持 URL、Codex 会丢 URL；两个参考路径未覆盖最新 file image | 未知未来 source 即使带 url 也按有界文本降级；已知但畸形 source 本地 400；盲目复用不同 provider 的 file id 是**已修复 bug** |
| document / file | base64 / text source → 正式 `file_data`；Chat 无正式 `file_url`，URL source 使用含 URL 的有界文本 fallback；`source:content` 展开全部 text/image，title/context 进入稳定 metadata text | base64/text/URL → `input_file`；content source 展开为 ordered input parts | CLI 多条路径会丢；claude-code-router gateway 的 tool document 仅在无 text 时 JSON 降级 | provider-owned file id 本地 400；未来 unknown source 有界降级；content/context 静默丢失为**已修复 bug** |
| unknown 顶层 block | 逐 block 有界 JSON 文本降级（对齐 tool_result 的做法），turn 不再被静默删除 | 同左 | 多数路径忽略 | 原先整轮消失、单轮请求可退化为 `messages: []`；**已修复 bug** |
| 已知 opaque control / replay state | 顶层 `container`、`redacted_thinking`、`compaction` / `fallback` / `container_upload` 明确 400（nullable container 为 null 时 no-op） | 同左 | 参考版本通常尚未覆盖 | 这些结构要求 provider-owned state 按原位回放；转成可见 JSON 或跨 provider 复用会改变语义，当前无 replay-safe OpenAI 同构；**已修复 bug / 协议限制** |
| `tool_use` | assistant `tool_calls[]`，ID/name/JSON args 保留；上游 function call 返回时补正式 `caller:{type:"direct"}` | 每个普通 call 成为 `function_call`，返回标记 direct caller；带 program caller 的 function call 与 `program` / `program_output` 必须连同 hosted-runtime 状态回放，当前明确 502 而不伪装 direct | 基本等价 | 已知 block 先校验角色、非空 id/name、object input 与 caller；历史 caller 缺省或 direct 可回放，code-execution caller 明确 400；custom tool 的 `allowed_callers` 仅 `direct` 可等价；OpenAI programmatic caller 无 Anthropic 同构；**已修复 bug / 协议限制** |
| `tools[].strict` | 显式 true/false 保真，未声明保持 Chat 默认 | Responses 正式要求 boolean，未声明映射为 `strict:false` | 参考路径版本不同 | 缺省 strict 导致严格 Responses 端点 400；**已修复 bug** |
| `output_config.format` | → `response_format.json_schema`；`null` 为 no-op | → `text.format` | 参考版本覆盖不一 | document/search-result citations 同时启用时优先按 Anthropic 正式冲突本地 400；单独启用 citations 因无请求侧同构也明确 400；**已修复 bug** |
| assistant text + `tool_use` 历史 | text 和 calls 均保留 | Router 内部 `output_blocks` 保留 thinking/text/tool 原顺序，回放为有序 reasoning/message/function_call items | CLI 会先 flush message；claude-code-router gateway 保留 text/calls | 原先遇 call 就丢全部 text、以及 `[thinking,tool,text]` 被重排均为**已修复 bug** |
| `tool_result` string | tool string | function output string | 两参考实现基本等价 | 正确 |
| `tool_result` text/image array | text-only tool + user image sidecar；每组附件前以工具序号 + 完整 ID 的可逆 opaque marker 保留并行归属，跨模态原始交错顺序仍降级 | 原生 output part 数组，跨模态顺序与归属保留 | CLI：Chat 非标准地把 image 放 tool、Codex 仅保 base64；claude-code-router gateway：image-only JSON 化，mixed 时丢 image | 原 JSON stringify 为**已修复 bug**；Chat marker/sidecar 是无正式同构字段时的**合理有损差异** |
| 中途工具可用性 | `defer_loading` 初始隐藏；direct 与 `mid_conv_system` wrapper 内的 `tool_addition` / `tool_removal`、自定义客户端 `tool_result.tool_reference` 按顺序计算当前 active tool 子集 | 同一 active 子集转 Responses 顶层 functions | 两个参考实现未形成通用基线 | wrapper 内文字保持 system、结构 directive 不再变成模型可见 JSON；inactive named/any tool choice 本地 400；全 deferred 工具集按 Anthropic 规则本地 400；Anthropic server-owned tools/history 与 MCP tool-change reference 无通用 OpenAI function-tool 同构，明确报错；内置 typed client tools 在实现版本化 schema 前明确报错而非伪造空 schema；**已修复 bug / 协议限制** |
| 同轮 `tool_result` + user text 顺序 | 连续 tool message 后再发 user follow-up | `function_call_output` 后再发 user `input_text` | claude-code-router gateway：Chat 正确、Responses 反序 | Router 当前顺序正确；新增参考回归测试 |
| 空 / 缺省 `tool_result.content` | `""` | output `""` | claude-code-router gateway 同为 `""`；CLI 路径不完全一致 | 原先缺字段或 `"[]"`；**已修复 bug** |
| unknown / document/search-result tool-result block | unknown 逐 block 有界文本 fallback；可表示为 `file_data` 的 document 移入随后 user file sidecar，URL-only 文件转含 URL 的文本；content document 与 search-result metadata/全部非空 text 展开；含 search result 的 tool result 按 Anthropic 正式规则保持同质，不接受其他可见 block 混排 | unknown → `input_text` fallback；document → `input_file` 或 ordered parts，search result → metadata + 全部 text，保留数组顺序和 tool 归属 | CLI mixed 场景可能丢；claude-code-router gateway 只在无 text 时 JSON 化，mixed 场景静默丢弃 | 已知 block 不再受 4096 字符 unknown fallback 限制；未来嵌套 image source 也不会生成 `null` input part；**已修复 bug** |
| `tool_result.is_error` | true 时在原内容前加入稳定 Router metadata text marker；false/缺省完全不改变内容 | 同左 | translator 路径处理不一 | OpenAI 两协议无直接 flag；marker 是通用、确定、可见的有损承载，不猜业务含义；原先 true/false 碰撞为**已修复 bug** |
| `tool_choice:any` | `required` | `required` | translator 各异 | 先校验 Anthropic 对象形状、枚举、named name 与 parallel flag；manual enabled thinking 禁止 forced choice，adaptive 允许；原样 `any` 会被 OpenAI 拒绝；**已修复 bug** |
| named tool choice | OpenAI function choice | Responses 扁平 function choice | 基本等价 | 正确 |
| parallel tools request | `disable_parallel_tool_use` 取反映射 | 同左；未指定时不覆盖上游默认 | 支持程度依路径 | 原 Responses 硬编码 false；**已修复 bug** |
| parallel tools stream | 按 OpenAI tool index 缓冲并输出顺序完整 Anthropic block | Responses 先映射 tool index，再走同一状态机 | CLI 有独立事件状态机 | 原先 delta 可写入已关闭 block；**已修复 bug** |
| thinking / effort / display request | `output_config.effort` 五值精确映射；thinking 内容使用兼容扩展 `reasoning_content`。Chat 无标准 encrypted replay state，Router 以自描述 opaque signature 无状态封装原 reasoning；显式 omitted 在 JSON/SSE 都隐藏明文 delta 并保留下一轮回放 | 五个显式 effort 精确映射；显式 omitted 不请求 detailed summary，但继续 include encrypted state | 两个参考项目均含 provider/路径特有映射，不能作为通用 clamp 依据 | Chat envelope 只做可逆协议承载，不声称是上游原生密文；Responses 缺 id/encrypted state 仍为 502。enabled/adaptive/budget 的本地 400 校验保持；**已修复 bug / Chat 协议限制** |
| reasoning history | Chat 把 Router 自有 signature 解回原 `reasoning_content`；未知/原生 Anthropic signature 不猜测、不透传为 Chat 扩展 | 请求 encrypted content；Router 把正式必需的 item ID 与 encrypted content 封入自描述 opaque signature，下一轮只解包自身 marker | CLI 会验证 provider signature，但其兼容路径省略 ID | Chat 与 Responses 使用不同版本前缀，避免跨协议误解包；**已修复并保守降级**。若兼容网关把相邻 Responses 请求路由到不同 state resource，正式回放仍可能被其 409 拒绝，Router 不猜测或删除历史 |
| reasoning response | visible `reasoning_content` → thinking；无原生 signature 时生成可逆 Router envelope，omitted 仅抑制可见 thinking delta，不丢回放状态 | 非流式优先 `reasoning_text`、无正文时回退 summary；流式覆盖 delta/done/item fallback 并去重；`{id, encrypted_content}` → Router signature envelope | 两个参考项目的字段与事件覆盖均随 provider/path 变化 | Chat envelope 不是加密承诺，只是无状态可逆承载；缺必填 Responses reasoning id、omitted 缺 encrypted state、SSE/JSON 不一致均为**已修复 bug** |
| `cache_control` | 只剥 protocol wrapper | 同左 | 多数路径剥除 | 原递归删除会破坏 JSON Schema 同名属性；**已修复 bug**。Anthropic 的 tool reference 与 tool-search 专页对 `defer_loading + cache_control` 可否组合存在相互矛盾的说明，Router 暂不据此新增拦截；该 wrapper 最终仍剥除，列为**尚需验证** |
| metadata / user_id | 当前不转发 | 当前不转发 | 有的映射到 OpenAI user | Anthropic metadata、OpenAI metadata/user/safety_identifier 不同构；**待验证** |
| `max_tokens` | 原样 | `max_output_tokens` | 基本等价 | 正确 |
| `temperature` / `top_p` | 原样 | 原样 | 因模型而异 | Responses 原先无条件删 temperature，top_p 丢失；**已修复 bug** |
| `stop_sequences` | → Chat `stop` | Responses 无直接正式等价，删除 | 部分 translator 丢失 | Chat 原先丢失；**已修复**。Responses 为**合理协议限制** |
| model mapping | header map / override 后写入 body | 同左 | provider 配置驱动 | 无状态 Router 的**合理设计差异** |
| unknown request fields | 仅显式支持字段进入 unified | 同左 | translator 通常白名单 | 防止跨协议泄漏，但新增正式字段需显式支持；**合理差异 / 持续审计** |
| non-stream multiple function calls | 全部转 tool_use | 全部 function_call 收集 | 新版 CLI 收集全部 | 既有增强保留 |
| legacy Chat `function_call` | 流式与非流式均归一为 `tool_use`（id 由 Router 合成），`finish_reason:"function_call"` → `tool_use` | 不适用 | CLI 有兼容映射 | 原先被静默丢弃并产出成功的空 turn（假成功）；**已修复 bug** |
| stop reason / incomplete tool | stop/length/tool_calls/function_call → end_turn/max_tokens/tool_use/tool_use；length/refusal 的 partial call 以有界文本诊断保留 | completed 且参数为 JSON object 才是 tool_use；incomplete 同样降级成有界文本并以 max_tokens/refusal 封口 | 映射粒度不同 | 流/非流均不再输出可执行-looking partial `tool_use`；**已修复 bug** |
| refusal / content filter | 流式与非流式 `refusal` 保留为普通 assistant text；与 content 同 delta 到达时两者都保留 | refusal delta/done/item 与非流式 refusal part 保留为普通 assistant text | 两个参考项目覆盖不一致，不能据此丢弃内容 | `stop_reason:"refusal"` 并携带 `{type:"refusal",category:null,explanation}` 的 `stop_details`；JSON→SSE 与 SSE→JSON 聚合均保留。原吞内容/终态信息为**已修复 bug** |
| usage | prompt/completion/cache → 当前 Anthropic Usage（含 nullable 字段、reasoning → thinking tokens、service tier） | input/output/cache/reasoning details 同步转换 | 基本等价 | Responses cached/reasoning usage 与 Message/MessageDeltaUsage 字段曾不完整；**已修复 bug** |
| annotations / web search result | Chat annotation 缺少 server call/action，使用有界 payload 文本降级，不伪造空 query | `web_search_call` 与 citation 分别转成有界 typed JSON 文本，保留 id/action/query/URL/range；citation 无 call-id，故不猜测二者归属 | 常带 provider 专用 web search | 原先丢 call id/query、末尾伪造空 query、丢 file citation/unknown payload；保真 fallback 为**已修复 bug / 合理协议降级** |
| HTTP errors | 当前 Anthropic error envelope（含 nullable `request_id`），保留 upstream status | 同左 | 错误映射表不同 | 402/409/413/504 已分别映射 billing/conflict/request-too-large/timeout；其他非标准状态保留 status 并安全降级为 `api_error`；**已修复 bug / 合理降级** |
| 所有 upstream 非 2xx | 单次上游请求，`X-Should-Retry:true` | 同左 | 不作为对齐项 | 用户确认的既定行为；**符合预期、保持不变并新增回归** |
| Chat SSE error chunk | Anthropic `{type:error,error:{...}}`，不追加成功终态 | 同左 | 实现不同 | 原 envelope 错且仍 end_turn；**已修复 bug** |
| SSE framing / chunk boundary | 共享增量 decoder：同 event 多 `data:` 以 LF 拼接，接受 LF/CRLF/CR，并跨 chunk 解码 UTF-8 | 同左 | 两个参考项目均有自己的 parser，行为不能替代正式 framing 测试 | 原先按单次 read/空行 split；**已修复 bug**。EOF 时没有空行的 trailing event 也会 dispatch，这是有意兼容扩展；`[DONE]` 会停止读取但不冒充成功终态 |
| Responses SSE lifecycle | — | completed/incomplete 必须携带匹配的 response/status；failed/cancelled/error 保留逻辑状态；JSON queued/in_progress/unknown 不再伪装成功 | 测试覆盖因 provider 而异 | cancelled → 409；queued/in_progress/未知非终态 → 502；HTTP 200 内嵌失败在 stream:false 下保持 400/429/500 与 retry contract；**已修复 bug** |
| SSE 截断 / 聚合 usage | 无终态 EOF 返回 error；终态后继续读取同批 usage-only chunk | 同左 | 状态机实现不同 | 原先截断伪装 end_turn、同一 read 内 usage 丢失；**已修复 bug** |
| unknown / empty SSE | 已知 Chat delta 处理，未知忽略；无任何响应 event 时返回 error | unknown output item/content/citation 的小 payload 有界 JSON 降级；未知 event 仍忽略，未知终态返回 error | 多为白名单 | 不再只保留 type 或伪装空 `end_turn`；未来纯事件增量的通用保真仍**待验证** |
| upstream image output | Anthropic assistant 无通用 image output block | 流式与非流式均转成去重的短占位符 `[generated image omitted]`，不内联 data URL / base64 | provider 支持不一 | 请求图片不受影响；有界占位降级为**已修复 bug**，原生生成图片语义仍需独立协议设计，**待验证** |
| upstream audio output | Chat JSON transcript → text；raw audio → 单个 `[generated audio omitted]` | Responses SSE transcript delta → text；audio delta → 单个占位符，done 不重复 | 参考实现覆盖不一 | 不把 base64 音频暴露成文本；**已修复 bug / 协议限制** |
| Responses opaque output | — | direct/缺省 caller 的 function call 正常；`program`/`program_output`、programmatic/未知 caller、`compaction`、响应侧 `function_call_output` 在 JSON、item added/done、terminal snapshot 均 502 | 参考实现常做 JSON fallback | 这些 item 含 hosted state，降级文本会伪造可回放成功；**已修复 bug** |

## 已实施改动

- 修正 base64 / URL 图片转换，并移除 Chat 非标准 `media_type`。
- 对 tool result 的 text/image/document/unknown/empty 内容做结构化转换；Responses 原生保留 `input_text` / `input_image` / `input_file` 多 block 顺序与归属；Chat tool message 保持 text-only，并把图片/可表示文件放入带可逆 provenance marker 的标准 user sidecar。
- 保留普通中途 system 角色与位置；direct block 与 `mid_conv_system` wrapper 恰好展开一层，wrapper 内文字保持 system、工具变更只进入结构投影；按历史顺序解释 `defer_loading`、自定义客户端 `tool_result` 中的 `tool_reference` 和 `tool_addition` / `tool_removal`，向 OpenAI 两协议投影当前生成的最终 active tool 子集。Anthropic server-owned tools（含 web search/fetch、code execution、advisor、tool search、MCP）及其历史结果因没有通用 OpenAI function-tool 同构而明确报错，不把服务端执行伪装成客户端函数；内置 typed client tools 在实现对应版本 schema 前也明确报错而非伪造空参数函数；`compaction` / `fallback` / `container_upload` 不会降级成模型可见 JSON。所有判断都来自协议类型，不加入模型名、网关或业务工具特判。
- Anthropic document 的 base64/text/URL source 建立统一内部 file envelope；Chat 正式使用 `file_data`、URL-only 安全降级，Responses 正式使用 `input_file.file_data`/`file_url`。`source:content`、context 与 search result 现在按稳定 metadata + 原 block 顺序展开；Anthropic provider-owned file id 不再盲目当作 OpenAI file id。
- 新增 `top_p`、Chat `stop`、并行工具参数映射；保留 Responses temperature；disabled thinking 不再误启用。
- 精确映射 `output_config.effort` 的五个正式值；null 为 no-op，其他非法显式值本地 400；enabled budget 必须为有限整数且至少 1024，adaptive 可省略且不得携带 budget；只有合法 enabled budget 才进入 Responses heuristic，不做模型名 clamp。
- Responses 历史同时保留 assistant text 与 function calls；工具名和 schema 完全按用户输入转换，删除特定工具名分支。
- wrapper 字段按协议位置剥除，不再递归破坏用户 JSON Schema。
- 修正并行工具 SSE block 生命周期、stream error envelope、截断检测与聚合 usage；共享 SSE decoder 正式处理 multi-data、LF/CRLF/CR 与跨 chunk UTF-8，并把无空行的 EOF trailing event 作为兼容扩展；malformed event 为致命错误，`[DONE]` 停止读取但不单独构成成功。
- 补 Responses model、usage（含 reasoning tokens 与流式首帧可确定的 service tier）、incomplete/failure/done-only fallback 与 reasoning_text；Chat/Responses refusal 保留普通 text 并输出正式 `stop_reason` / `stop_details`；partial function bytes 保留，但 incomplete 不产生 `tool_use` 成功终态；以包含 item ID 的 Router envelope 保留 reasoning encrypted state。Message / message_start / message_delta 现在补齐当前 nullable container 与 Usage / MessageDeltaUsage 字段，错误 envelope 补齐 nullable `request_id`。
- timeout timer `unref()`，避免短生命周期验证进程被一小时定时器占住；请求 AbortSignal 行为不变。
- 新增 `npm test` 自动化套件。

## 第二轮修复（0.5.0）

针对独立对抗式审查发现的 15 项问题（6 P1 / 7 P2 / 2 P3），全部修复并配套回归测试（`tests/protocol-fixes.test.ts`）：

1. **响应形态永远跟随客户端 `stream` 标志**（原 P1：`stream:true` 遇 JSON 上游会用 SSE 头包裹裸 JSON，客户端挂起到超时）。`stream:true` + JSON 上游 → 由完整消息合成完整 Anthropic SSE 序列；`stream:false` + SSE 上游 → 聚合为单条 JSON 消息，流中 error 事件转 502 而非伪造完成。见 `src/utils/anthropic-sse.ts`。
2. **数组型 Chat `delta.content` 归一为字符串**；同一 delta 同时携带 content 与 refusal 时两者都保留（原先 `||` 短路丢 refusal）。
3. **全 unknown block 的 user 轮逐 block 降级为有界 JSON 文本**，整轮不再消失；`messages: []` 不再可能由合法请求产生。
4. **不可转换的 image/system block 不再产出 `content: []` 空消息**（Chat 上游 400 的来源）；降级为 JSON 文本或整条跳过。
5. **多 reasoning item 完整回放**：非流式每个 reasoning item 产出独立 thinking 块（各自 id + encrypted_content 封口），并记录其后随的 tool call；回放时按配对交错还原 `reasoning → function_call` 邻接顺序。`UnifiedMessage.thinking_blocks` 为承载字段，`thinking` 保留单块兼容 Chat 路径。
6. **finish chunk 不再清零先到的 usage**：usage 先于 finish_reason 到达时保留合并。
7. **Responses 流式去重键双写**（item_id 与 output_index 各成一键，标记全部、命中任一），缺 item_id 的 delta 与带 id 的 done 不再各用一键导致内容重复输出。
8. **空 `data:` 心跳（WHATWG 合法）跳过**，不再进 `JSON.parse("")` 被判致命 malformed。
9. **annotation 处理加 guard**：第二轮先让非 url_citation annotation 跳过，不再抛 TypeError 且不再发出幻影 `web_search` 块；第三轮进一步改为逐位置有界文本保留。JSON.parse 与转换逻辑分离 try，内部异常报 `upstream response conversion failed` 而非诬告上游 malformed。
10. **SSE 解码器线性化**：无换行 chunk O(1) 追加进分段缓冲，出现换行才 join+扫描（原实现 4 MB 无换行行阻塞事件循环约 12 秒，现约 2 ms）；单行超 16 MB 抛错终止流而非无限缓冲。
11. **legacy `function_call`（流式 + 非流式）映射为 `tool_use`**，终态 `tool_use`，不再假成功空 turn。
12. **thinking budget 先按 Anthropic 形状校验**：enabled 必须提供有限整数且 `budget_tokens >= 1024`，缺失、0、小数或过小值本地返回 400；adaptive/disabled 必须省略 budget。只有合法 enabled budget 才参与 effort heuristic，不会静默升级成本。
13. **usage 减法加下界 `Math.max(0, …)`**，cached_tokens 大于 prompt_tokens 的网关不再产生负 `input_tokens`。
14. **生成图片输出转短占位符**，不再把 data URL / base64 JSON 化进用户可见文本。
15. **请求体形状校验**：messages/system/content/tools 中的 null/非对象元素返回 400 `invalid_request_error`，不再 500 泄漏 JS 内部错误消息；本地校验错误不带 retry header。

配套杂项：`content_filter` → `refusal` 并携带结构化 `stop_details`；顶层 user text block 重建为纯 `{type,text}`，`citations` 等 Anthropic 专有 sibling 不再透传上游；`choices[].index` 固定 0（不再挪用为内容序号）；`function_call_output.output` 纯文本时保持 string（旧 Responses 兼容网关友好），含 text/image/file 的多 block 则保持正式 typed 数组；document 映射 `input_file`；无 `input_schema` 的 tool 补默认 `parameters`；transformer 内全部 `this.logger?.` 可选链。

后续独立收口还增加了以下安全语义：客户端 `stream` 标志决定最终响应形态，JSON→SSE 的 `message_start` 使用空终态字段、`message_delta` 承载最终 `stop_reason` / `stop_details` / `stop_sequence`，SSE→JSON 聚合恢复同样信息；Responses incomplete function call 保留已收到的名称/参数字节用于诊断和历史保真，但以 `max_tokens` 封口而不是 `tool_use`，refusal/content filter 优先级更高；客户端取消会继续 cancel 已持有的上游 reader。

另：claude-code-router 锁定 gateway 的 6 条 fixture 论断已通过下载 `@the-next-ai/ai-gateway@1.0.15` tarball（sha512 与 lockfile 一致）+ sourcemap 还原源码 + 可执行探针独立复核证实，其中 image-only 本地 400 在带 system prompt 时同样触发（比原记录更宽）；该参考实现还存在多 reasoning item 塌缩且回放 id 随机重生成的缺陷，故本项目的多 reasoning 修复以正式 Responses 语义为准，不以参考项目为准。

## 第三轮独立复核与收口（0.5.0）

三个只读 Agent 分别复核多模态/工具/结构化输出、reasoning/history、SSE/error lifecycle，主 Agent 用源码与最小可执行 fixture 裁决。确认并修复：Responses 缺省 `strict:false`；document citations 与 structured output 冲突；Chat/Responses incomplete 工具在流/非流均降级为有界诊断文本；legacy stream function call 稳定 ID；`web_search_call` 与 citation 的 id/action/query/URL/range 有界保真且不猜测归属；web-search 等 fallback 等待 terminal 完整快照，citation 按 item/content/annotation 位置去重且 text→citation 顺序统一；生成图片流/非流均只发占位符；file/未知 citation 和未知 output payload 的有界保真；assistant history block 顺序；Chat reasoning 在 visible/omitted、JSON/SSE 与工具历史间使用 Router 自有可逆 signature 保持无状态回放；Responses unsigned/missing-id reasoning；Responses terminal response/status 与逐 `output_index` 工具身份校验；cancelled/queued/in-progress/unknown status；完整 item 后 delta 去重；工具参数只在 id/name 齐全后下发；cache-write usage；HTTP 200 SSE logical failure 的状态和 retry contract。

新增 `tests/protocol-edge-regressions.test.ts` 直接覆盖上述终态和责任边界。上游 HTTP 非 2xx 的既定策略未改：所有 3xx/4xx/5xx 仍只请求一次、保留状态/错误体并返回 `X-Should-Retry:true`。

## 第四轮真实 Claude Code 与 main A/B（0.5.0）

为避免只验证构造 fixture，本轮同时运行两个独立 Router 进程：`origin/main` 精确提交 `2683537d5097`（0.4.0）监听独立端口，候选为从该发布基线演进的当前 `codex/protocol-audit-fixes` 工作树；main 通过 `git archive` 导出到临时目录，没有切换当前分支或使用 worktree。两套上游、Chat / Responses 两种格式使用相同授权、模型和请求矩阵：

- main 在最终同构矩阵分别为 10/23、11/23 通过；失败覆盖正式 `tool_use.caller`、Responses 流式 text/usage/单与并行工具、document、reasoning/history。候选分别为 22/23（1 个上游状态限制 classified skip）与 23/23，0 failed；skip 是兼容上游跨请求 reasoning item 返回 409，绕过 Router 直连同样复现。
- 四个真实 Claude Code 2.1.220 TUI 均使用完整 `env ... claude` 命令启动，不依赖 alias 展开。三条兼容链路完成普通流式文本、并行 Read、Bash、PNG 识别和历史回放；剩余一条 Chat 端点连纯文本工具往返也持续返回上游 409。Router 日志显示每次上游请求都在数秒内结束，随后由 Claude Code 按 `X-Should-Retry:true` 执行有界重试，不是 Router 卡死。
- 先前收口探针还验证了四套原始环境都能启动并执行强制 `Read(package.json)`；其中发现的一条 Chat `display:"omitted"` 历史回放 502 已通过自描述 signature envelope 修复。最新完整多模态验收以上一条结果为准，JSON/SSE、native/coalesced signature 与历史回放均有回归测试。
- 剩余一条 Chat 兼容端点对正式 `role:user` 的 `text + image_url` 数组返回 409 `content expected a string`。脱敏结构探针确认候选没有发送 `content:null`；同端点的 Responses 路径可识图，OpenAI Chat 正式 schema也允许 user content part 数组，故归类为端点兼容限制，不加入网关或模型特判。
- main 的 Chat / Responses 图片历史会把 typed 图片压成字符串：Claude Code 显示 Read 后转而调用 Bash 或输出与 PNG 像素不符的描述，证明“HTTP 200”不等于视觉语义到达；main 的一条 Responses SSE 链路甚至完成空响应。候选修复了这一责任边界。

上述 A/B 不记录真实 endpoint、模型或凭证。Router 只按显式 `X-Upstream-Format` 选择协议，不根据任何上游身份、模型名或业务工具名改变请求。

## 第五轮当前协议字段收口（0.5.0）

三个并行 Agent 分别按 OpenAI 多模态/工具 schema、Anthropic 当前 Messages schema、Responses SSE/error lifecycle 做独立复核，主 Agent 再用源码、正式文档、最新 SDK 类型与最小反例交叉裁决。本轮新增的确认修复包括：

- Anthropic provider-owned `file_id`、`container`、`redacted_thinking`、启用 citations 等无法跨 provider 同构的状态不再静默透传或泄漏为模型可见 JSON，而是明确返回协议错误；nullable/no-op 形态仍兼容。
- document `source:content`、search-result metadata/全部文本、`tool_result.is_error` 与嵌套多 block 得到稳定保真；search-result 的非空文本及 tool-result 同质约束按正式协议校验，未来嵌套 image source 安全降级而不产生 `null` part；Responses programmatic caller、compaction、响应侧 function output 等 hosted-runtime 状态在 JSON/SSE 各入口一致拒绝。
- Chat/Responses 音频 transcript 保留为文本，原始音频只输出一次省略标记；Chat annotation fallback 在 JSON/SSE 中都位于被标注文本之后；当前 Message/Usage、reasoning tokens、service tier 与 error `request_id` 字段在可同构范围内统一，畸形 upstream error message 也不会破坏 Anthropic string schema。
- Responses `output_text`、refusal、reasoning text 的 delta/done/terminal snapshot 采用同一累计规则：相同快照去重、完整快照只补 suffix、分叉立即返回 502，避免 HTTP 200 但文字被截断或重复。

这些改动没有加入端点、模型、企业环境或业务工具判断，也没有改变所有上游非 2xx 的单次转发与可重试契约。

## 测试证据

`npm test` 覆盖：

- 顶层 base64 / URL 图片、data URL 和包含字面量 `base64` 的合法原始载荷；
- tool result string/text/base64 image/URL image/unknown/empty；
- 同一 Anthropic user turn 中 `tool_result` + follow-up text 到 Responses 的先后顺序；
- 顶层及 tool-result document 的 base64/text/URL/content source：Chat `file_data`、URL fallback 或 ordered content，Responses typed `input_file`（含 `file_url`）或 ordered input parts；provider-owned file source 400；
- Chat 严格 endpoint、视觉 sidecar、Responses typed function output；
- 文本模型拒绝标准图片的 400 责任边界；
- assistant text + tools、generic tool names、schema 同名字段、thinking/parallel/参数；
- `output_config.effort` 五值在 thinking absent/disabled/enabled/adaptive 下的精确 Chat / Responses 映射，以及 enabled budget 缺失、0、小数、过小和 adaptive 携带 budget 的本地 400；
- client tool 的非空名称、`defer_loading` 类型、全 deferred 工具集、`tool_choice` 形状/枚举及 manual thinking 强制工具冲突；`mid_conv_system` wrapper 展开；`tool_use` / `tool_result` 的角色和必填字段；所有已知 Anthropic server-owned tool 定义与历史块、typed client tool、opaque control block 均明确报错，不会变成空 schema 函数或模型可见 JSON；
- Chat 并行工具流、流式错误；
- Chat / Responses 同 event 多 `data:`、LF/CRLF/CR、逐字节 UTF-8、EOF trailing event、`[DONE]` 终止读取，以及 malformed event 即使后续存在合法 terminal 也不得合成成功；
- Responses created/completed/incomplete/failed、usage/cache、reasoning signature/reasoning_text、done-only fallback、refusal `stop_details`、partial/incomplete function call 安全终态，流式/非流式；
- Responses programmatic tool calling 的 `program` / `program_output` / programmatic 或未知 caller，以及 `compaction` / 响应侧 `function_call_output` 在 JSON、live SSE added/done 与 terminal-only SSE 均明确失败；缺省/direct caller 正常转换；
- 非 2xx 状态表 `300, 400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 504, 529`：均保留状态、只 fetch 一次、返回 `X-Should-Retry:true`；
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

当前候选的仓库自动化回归为 174/174 通过。另以 `scripts/verify-live-upstream.ts` 对两套独立兼容上游运行脱敏真实用例，最新完整矩阵合计 45 passed / 1 classified skip / 0 failed：

- Chat Completions 与 Responses 的普通文本，各覆盖 stream false/true（4）；
- 两协议 required tool call，各覆盖 stream false/true（4），以及两协议并行工具流（2）；所有成功工具块同时断言正式 `caller:{type:"direct"}`；
- 两协议顶层 base64 / URL 图片（4），两协议嵌套 tool-result text + image（2）；
- 两协议 document file/input_file（2）与 Responses reasoning usage 的 stream false/true（2）；
- Responses reasoning 历史跨轮回放（每套上游各 1）：一套成功完成签名回放；另一套返回 409 `item not found / different resource`，Router 保留状态与 retry header；直接绕过 Router 的两轮正式 Responses 回放也得到同类 409，因此只对该上游归类为跨资源状态限制并 skip；
- 两协议无效模型探针（每套上游各 2）分别返回 HTTP 404/502，Anthropic error envelope 和 `X-Should-Retry:true` 均保留。

另外使用本机 Claude Code 2.1.220 直接验证 shell 环境变量接入，而不是绕过客户端调用 Router：

- Chat Completions：embedded-path `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，普通 `claude -p` 成功；
- Responses：embedded-path `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Format: responses'`，普通 `claude -p` 成功；
- 两套上游 × 两种格式共四个 TUI 完成文本、并行 Read、Bash 与工具错误恢复；三条兼容链路完成 `Read(PNG) → tool_result(text/image) → assistant → history replay`，一条 Chat 端点按上文责任边界返回 409；
- Router 日志分别确认 `format=chat-completions` / `format=responses`，没有按端点、模型或工具名的运行时分支。

报告不记录真实 endpoint、模型名或凭证。使用自有上游复跑：

```bash
OCR_LIVE_ROUTER_URL=http://127.0.0.1:3457 \
OCR_LIVE_CHAT_URL=<chat-endpoint> \
OCR_LIVE_RESPONSES_URL=<responses-endpoint> \
OCR_LIVE_AUTH='<authorization-value>' \
OCR_LIVE_MODEL=<model> \
npm run test:live
```

## 兼容性与发布建议

- Chat tool-result 图片 sidecar 遵守正式 Chat schema，严格端点兼容性优于把 image 直接塞进 tool content；依赖非标准 tool-image 扩展的端点会看到结构变化。需要精确 tool/image 归属时使用 Responses。
- 当前依赖树保留 Node 20 兼容的 OpenAI 4.x / Anthropic 0.32.x 声明；最新 SDK 类型在隔离目录完成审计与 typecheck，但不升级运行依赖。旧 Responses-compatible 网关可能拒绝正式 function output 数组，应在发布说明中明确。
- Responses encrypted reasoning 与产生它的 provider / model 绑定；无状态 Router 会在自描述 envelope 中保留其 item ID 与密文并保真回放，切换到无法解密该历史的模型时，上游可能返回 `invalid_encrypted_content`。Router 不按模型名猜测并静默删历史。
- document/file 的 base64/text/URL/content 主路径已经 typed 化或按 metadata + ordered parts 保真展开；citations.enabled 因无 OpenAI 请求同构明确 400。未来 unknown block/event 仍走有界安全降级；原生生成图片/音频只输出短占位，不应为特定模型或工具做特判。
- Responses queued/in_progress/未知非终态现在明确返回 502，cancelled 返回 409，不再伪装成功。剩余限制是 Responses web-search citation 没有指向具体 `web_search_call` 的归属字段，且 Chat-only annotation 没有可逆 Anthropic 同构；当前分别按有界 typed JSON 文本降级，不伪造配对或工具结果。原生生成图片输出也仍是占位符。
- 当前 0.5.0 候选从 0.4.0 发布提交 `2683537` 的独立修复分支演进；建议按上述完整命令和真实 Chat / Responses canary 验收后发布 0.5.0。不要从旧的 `9c00b8f`、同机非发布 retry 分支或仅 cherry-pick 图片补丁发布，否则容易遗漏 0.4.0 已有的 retry-all 与本轮流式/文件/工具配套修复。
- 本次没有部署、推镜像或替换线上版本。所有 upstream 非 2xx 可重试行为保持不变。
