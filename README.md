<p align="center">
  <img src="docs/logo.png" alt="open-claude-router Logo" width="120" />
</p>

<h1 align="center">open-claude-router</h1>

<p align="center">
  让 Claude Code 通过 Anthropic Messages API 使用 OpenAI Chat Completions 或 Responses 协议上游，<br/>并自带一个可视化看板，完整还原每一次经过 Router 的模型流量。
</p>

<p align="center">
  <a href="https://github.com/riba2534/open-claude-router/releases/latest"><img src="https://img.shields.io/github/v/release/riba2534/open-claude-router?style=for-the-badge&color=2ea44f" alt="GitHub Release" /></a>
  <a href="https://hub.docker.com/r/riba2534/open-claude-router"><img src="https://img.shields.io/docker/pulls/riba2534/open-claude-router?style=for-the-badge&color=2496ED&logo=docker&logoColor=white" alt="Docker Pulls" /></a>
  <a href="https://github.com/riba2534/open-claude-router/stargazers"><img src="https://img.shields.io/github/stars/riba2534/open-claude-router?style=for-the-badge&color=f5a623" alt="Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
</p>

---

## 这是什么

[Claude Code](https://code.claude.com/docs/en/overview) 使用 Anthropic Messages API。open-claude-router 在客户端与 OpenAI 协议上游之间转换请求和响应：

```
Claude Code  ──(Anthropic Messages)──▶  open-claude-router  ──(OpenAI Chat Completions / Responses)──▶  上游
```

服务的协议路由和会话是无状态的。上游 URL、Authorization 和模型名由客户端逐请求传入；服务端不读取上游配置文件、不持久化凭证、不维护对话状态。一份部署可以同时服务多个客户端和上游。

上游凭证在转发时会经过 Router 进程，但不会写入模型交互日志。默认审计日志会记录客户端原始 Anthropic 请求、转换后的上游请求、上游原始响应和直接客户端 IP，按 UTC 日期保存 7 天；可调整保留期、只记录元数据或完全关闭。镜像同时内置流量观测看板（Lens）：读取这份日志，把每次转发还原成可视化的会话、工具调用与费用视图（见[流量观测看板](#流量观测看板lens)）。

典型场景：

- **个人自部署**：启动一个容器或二进制，在 shell alias 里配置上游
- **团队共享**：内网部署一份服务，每人通过自己的 alias 逐请求提供上游配置；服务端不需要维护统一的上游账号表
- **多家上游切换**：不同 alias 指向不同上游 / 模型，无需重启服务

## 目录

[快速开始](#快速开始) · [配置说明](#配置说明) · [协议覆盖与边界](#协议覆盖与边界) · [API](#api) · [环境变量](#环境变量) · [模型交互日志](#模型交互日志) · [流量观测看板](#流量观测看板lens) · [常见问题](#常见问题) · [安全](#安全)

## 特性

- **路由和会话无状态**：服务侧不持久化 API Key、不读上游配置、不维护会话状态；上游信息由客户端逐请求传入
- **模型交互日志**：按请求 ID 记录直接客户端 IP、接入模式、客户端原始 Anthropic 请求、转换后实际发给上游的 JSON、上游原始 JSON/SSE 和取消阶段，默认按 UTC 天轮转并保留 7 天；正文模式、保留期、目录和单条上限均可配置
- **流量观测看板（Lens）**：镜像内置的 Web 后台（`:3458`），基于交互日志还原每次转发的双协议视角（Claude↔Router 的 Anthropic 侧、Router↔网关 的 OpenAI 侧），提供会话聚合、工具调用与思考块渲染、SSE 事件流、费用估算、调用方筛选和实时刷新；纯观测组件，不参与转发，可用 `LENS_ENABLED=false` 关闭
- **调用方身份标签**：客户端可通过可选的 `X-OCR-Client` 请求头自报身份（如容器名 / 业务线），Router 记入日志、看板按其区分和筛选流量；该 header 只用于观测，不会被转发给上游
- **Authorization 值透明转发**：合法的 Bearer 或非 Bearer 上游鉴权值不会被解析或重组
- **覆盖 Claude Code 核心链路**：支持流式 SSE、工具调用、多模态输入、thinking、结构化输出、错误转换和客户端取消；不能安全转换的边界会明确报错
- **支持两种 OpenAI 协议**：默认使用 Chat Completions；通过 `X-Upstream-Format: responses` 选择 Responses API
- **alias 里完成全部配置**：Claude Code 标准模型环境变量、上游 URL、上游凭证、服务鉴权和额外网关 header 都能随 alias 注入
- **遵循 Claude Code 模型配置**：通过 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL` 直接填写真实上游模型；Router 默认原样转发请求体中的 `model`
- **结构化输出与严格工具**：Anthropic `output_config.format` 和 `tools[].strict` 分别映射到 Chat Completions / Responses 的正式结构，不按模型名猜测支持能力
- **上游错误统一交给客户端重试**：上游返回任意非 2xx 时保留原状态码和错误内容，同时响应 `X-Should-Retry: true`，由 Claude Code 使用自身有界重试策略处理；服务端不读取错误文本后修改请求体重发
- **两种接入方式**：上游信息可以放 HTTP header，也可以直接拼在 URL path 里
- **Rust 单二进制运行时**：复用上游连接，流式链路逐 chunk 转换并传播背压与取消；转发只需一个可执行文件，观测看板是可独立启停的第二个二进制

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

官方镜像内是**两个独立进程**：转发器 `open-claude-router`（`:3457`）和看板 `ocr-lens`（`:3458`）。二者之间没有任何 RPC，唯一的契约是磁盘上的 NDJSON 交互日志：

```mermaid
flowchart LR
    subgraph Image["官方镜像（一个容器，两个进程）"]
        Router["open-claude-router<br/>:3457 转发"]
        Log[("模型交互日志<br/>NDJSON / 按 UTC 天")]
        Lens["ocr-lens<br/>:3458 观测看板"]
        Db[("SQLite<br/>lens.db")]
        Router -- "异步追加写（fail-open）" --> Log
        Log -- "只读 tail" --> Lens
        Lens --> Db
    end
    Client["Claude Code"] --> Router
    Router --> Upstream[("OpenAI 协议上游")]
    Browser["浏览器"] --> Lens
```

转发器把每次交换异步追加写入日志（fail-open，日志故障不改变转发行为），看板只读地 tail 日志入 SQLite 并提供 Web 界面。两个进程的地位并不对等：**转发器退出会结束容器**（交给编排层重启），而**看板退出只损失看板**——entrypoint 会带退避原地重启它（`LENS_MAX_RESTARTS` 次后放弃），转发全程不受影响。看板还原请求响应时直接复用转发器的协议转换代码（`lens` crate 以库依赖引用 `rust` crate），因此展示的 Anthropic 响应与线上真实返回同源。任一侧故障不影响另一侧；`LENS_ENABLED=false` 时只启动转发器。

## 快速开始

### 1. 启动服务

可以使用 Docker，也可以直接下载单个 Rust 可执行文件在本机运行。

#### Docker

镜像发布在 [Docker Hub](https://hub.docker.com/r/riba2534/open-claude-router)，支持 amd64 + arm64：

```bash
docker pull riba2534/open-claude-router:latest
docker run -d --name ocr --restart unless-stopped \
  -p 3457:3457 -p 3458:3458 \
  -v ocr-model-logs:/app/logs -v ocr-lens-data:/app/data \
  riba2534/open-claude-router:latest
```

转发服务监听 `:3457`，流量看板监听 `:3458`（浏览器打开 `http://<主机>:3458`），服务端无需任何配置即可启动。公网部署可加 `-e OCR_ACCESS_TOKENS=token1,token2`（`OCR` 即 open-claude-router 缩写）启用转发端鉴权。

看板端口的暴露范围完全由你在启动时决定：只想本机访问就写 `-p 127.0.0.1:3458:3458`；不映射 `3458` 则外界不可达；只要纯转发可加 `-e LENS_ENABLED=false` 连看板进程都不启动。

启动后验证服务就绪：

```bash
curl http://localhost:3457/healthz   # 转发服务，预期 {"status":"ok"}
curl http://localhost:3458/healthz   # 观测看板，预期 {"status":"ok"}
```

> 端口被占用时改宿主端口即可，例如 `-p 13457:3457`，并把下面 alias 里的 `localhost:3457` 同步改成 `localhost:13457`。

<details>
<summary>不用 Docker：下载预编译二进制</summary>

每个稳定版本都会在 [GitHub Releases](https://github.com/riba2534/open-claude-router/releases) 提供以下归档，不需要安装 Rust：

| 系统 | amd64 / x86-64 | arm64 / Apple Silicon |
|---|---|---|
| Linux | `linux-amd64.tar.gz`（静态 musl） | `linux-arm64.tar.gz`（静态 musl） |
| macOS | `macos-amd64.tar.gz` | `macos-arm64.tar.gz` |
| Windows | `windows-amd64.zip` | `windows-arm64.zip` |

完整文件名格式为 `open-claude-router-vX.Y.Z-<平台>.tar.gz` 或 `.zip`。Release 同时提供 `SHA256SUMS`，建议在运行前校验下载文件。

Linux / macOS：

```bash
# 把版本和平台替换成 Release 页面中的实际值
VERSION=v0.7.5
PLATFORM=linux-amd64
ARCHIVE="open-claude-router-${VERSION}-${PLATFORM}.tar.gz"

curl -fLO "https://github.com/riba2534/open-claude-router/releases/download/${VERSION}/${ARCHIVE}"
curl -fLO "https://github.com/riba2534/open-claude-router/releases/download/${VERSION}/SHA256SUMS"

# Linux 校验；macOS 可改用：grep " ${ARCHIVE}$" SHA256SUMS | shasum -a 256 -c -
grep " ${ARCHIVE}$" SHA256SUMS | sha256sum -c -
tar -xzf "${ARCHIVE}"
cd "open-claude-router-${VERSION}-${PLATFORM}"
./open-claude-router
```

Windows PowerShell：

```powershell
$Version = "v0.7.5"
$Platform = "windows-amd64" # Windows on ARM 使用 windows-arm64
$Archive = "open-claude-router-$Version-$Platform.zip"

Invoke-WebRequest "https://github.com/riba2534/open-claude-router/releases/download/$Version/$Archive" -OutFile $Archive
Expand-Archive $Archive
& ".\open-claude-router-$Version-$Platform\open-claude-router.exe"
```

二进制默认监听 `0.0.0.0:3457`，模型交互日志写到当前目录的 `./logs`；端口、鉴权和日志配置与 Docker 版本使用相同的[环境变量](#环境变量)。Release 归档只包含**转发器**，[流量观测看板](#流量观测看板lens)随官方 Docker 镜像发布，也可从源码自行构建（见下方开发者章节）。macOS/Windows 产物目前没有商业代码签名；如系统拦截，请先用 `SHA256SUMS` 验证文件确实来自本项目 Release，再按系统提示放行。

</details>

<details>
<summary>开发者：本地裸跑</summary>

```bash
# 直接运行 Rust 转发服务
rustup toolchain install 1.97.1 --profile minimal
cargo run --manifest-path rust/Cargo.toml

# release 二进制
cargo build --locked --release --manifest-path rust/Cargo.toml
./rust/target/release/open-claude-router

# 另开一个终端跑观测看板（读同一份交互日志目录）
OCR_MODEL_LOG_DIR=./logs LENS_DB_PATH=./data/lens.db \
  cargo run --manifest-path lens/Cargo.toml
```

仓库有两个 Rust crate：`rust/`（转发器，同时是被看板复用的协议转换库）和 `lens/`（观测看板）。官方镜像同时包含两者。

> 镜像只能由仓库的 GitHub Actions 发布流程构建并推送。本机和部署机器禁止执行 `docker build` / `docker buildx build`，只允许拉取已发布镜像并做运行验证。
</details>

### 2. 把 Claude Code alias 写入 `~/.zshrc`

推荐把一个上游完整配置成一条 alias。以后输入 alias 名称即可启动 Claude Code；要切换上游或模型，就使用另一条 alias。Router 服务端不需要保存上游配置。

先确认下面三个值：

| 占位符 | 填写内容 |
|---|---|
| `upstream.example.com` | 上游域名，远程上游应使用 HTTPS |
| `YOUR_UPSTREAM_API_KEY` | 上游要求的鉴权值 |
| `YOUR_UPSTREAM_MODEL` | 上游接受的真实模型 ID |

下面的 alias 都是**一整行**，复制到 `~/.zshrc` 后再替换占位符。

#### 上游使用 Chat Completions

Chat Completions 是默认协议，不需要额外的协议 Header：

```bash
alias ocr-chat="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/chat/completions ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_OPUS_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_SONNET_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_HAIKU_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_SUBAGENT_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_EFFORT_LEVEL=high API_TIMEOUT_MS=3600000 claude"
```

#### 上游使用 Responses API

Responses alias 需要把上游路径改为 `/v1/responses`，并声明 `X-Upstream-Format: responses`：

```bash
alias ocr-responses="ANTHROPIC_BASE_URL=http://127.0.0.1:3457/https://upstream.example.com/v1/responses ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Format: responses' ANTHROPIC_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_OPUS_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_SONNET_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_HAIKU_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_SUBAGENT_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_EFFORT_LEVEL=high API_TIMEOUT_MS=3600000 claude"
```

加载配置并启动：

```bash
source ~/.zshrc
ocr-chat       # 使用 Chat Completions 上游
ocr-responses  # 使用 Responses 上游
```

进入 Claude Code 后可先发送一个简单问题，再执行一次需要工具的任务，确认文本、流式输出和工具调用都正常。

> alias 会在个人 shell 配置中明文保存上游地址和凭证。不要把真实 alias、截图或 `~/.zshrc` 提交到版本控制；建议执行 `chmod 600 ~/.zshrc`。如果 Router 不在本机，客户端到 Router、Router 到上游两段连接都应使用 HTTPS。

## 配置说明

### alias 中的 Claude Code 环境变量

主示例只使用 [Claude Code 官方支持的环境变量](https://code.claude.com/docs/en/env-vars)：

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_BASE_URL` | 指向 Router；path 模式下同时把完整上游 URL 拼在 Router 地址后面 |
| `ANTHROPIC_AUTH_TOKEN` | Claude Code 会在外层加上 `Bearer `；path 模式下 Router 剥掉这一层后，把剩余值作为上游 Authorization |
| `ANTHROPIC_MODEL` | 当前会话默认模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET` / `HAIKU` | Claude Code 内置模型槽位对应的真实上游模型 ID |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 Agent 使用的模型；单模型上游通常与主模型保持一致 |
| `CLAUDE_CODE_EFFORT_LEVEL` | Claude Code 推理等级；示例使用 `high`，可改为当前客户端和模型支持的等级，或删除后使用客户端默认值 |
| `API_TIMEOUT_MS` | Claude Code 请求超时，示例设为 1 小时，与 Router 的上游超时一致 |
| `ANTHROPIC_CUSTOM_HEADERS` | 通过 Claude Code 给 Router 增加请求 Header；多个 Header 用换行分隔 |

上面的单模型 alias 把所有模型槽位都指向同一个上游模型。如果上游提供多个模型，分别设置即可：

```bash
ANTHROPIC_MODEL='YOUR_DEFAULT_MODEL' ANTHROPIC_DEFAULT_OPUS_MODEL='YOUR_OPUS_MODEL' ANTHROPIC_DEFAULT_SONNET_MODEL='YOUR_SONNET_MODEL' ANTHROPIC_DEFAULT_HAIKU_MODEL='YOUR_HAIKU_MODEL' CLAUDE_CODE_SUBAGENT_MODEL='YOUR_SUBAGENT_MODEL'
```

### 推理等级

Router 不根据模型名猜测推理能力。Claude Code 显式发送 `low`、`medium`、`high`、`xhigh` 或 `max` 时，默认原样转换为：

- Chat Completions：`reasoning_effort`；
- Responses：`reasoning.effort`。

如果上游只支持部分等级，可以在 alias 中声明。例如上游最高支持 `high`：

```bash
# Chat Completions
ANTHROPIC_CUSTOM_HEADERS='X-Upstream-Effort-Levels: low,medium,high'

# Responses：与协议 Header 放在同一个变量中
ANTHROPIC_CUSTOM_HEADERS=$'X-Upstream-Format: responses\nX-Upstream-Effort-Levels: low,medium,high'
```

此时 `xhigh` 和 `max` 会在请求上游前就近调整为 `high`。也可使用 `X-Upstream-Effort-Map: max=xhigh` 做精确映射，或使用 `X-Upstream-Effort-Map: *=off` 删除推理等级。未配置这些 Header 时，Router 不改写等级；如果上游拒绝，Router 保留错误并交给 Claude Code 决定是否重试。

### path 模式与 header 模式

接入模式和上游协议是两个独立选择：

| 配置维度 | 选项 | 说明 |
|---|---|---|
| 上游信息入口 | path / header | path 把上游 URL 拼进 `ANTHROPIC_BASE_URL`；header 使用 `X-Upstream-Url` 和 `X-Upstream-Authorization` |
| 上游协议 | Chat Completions / Responses | Chat 是默认值；Responses 增加 `X-Upstream-Format: responses` |

快速开始里的 alias 使用 path 模式。Claude Code 会把 `ANTHROPIC_AUTH_TOKEN` 放进外层 `Authorization: Bearer ...`；Router 只剥掉第一层 `Bearer `，剩余内容原样作为上游 Authorization。因此：

- 上游需要 `Authorization: Bearer ...`：写 `ANTHROPIC_AUTH_TOKEN='Bearer YOUR_UPSTREAM_API_KEY'`；
- 上游需要非 Bearer 值：把引号内内容替换为上游要求的完整值。

path 模式不包含 URL query。上游 URL 必须带 query，或希望把 Router 鉴权与上游鉴权明确分开时，使用 header 模式：

```bash
alias ocr-header="ANTHROPIC_BASE_URL=http://127.0.0.1:3457 ANTHROPIC_AUTH_TOKEN='YOUR_ROUTER_ACCESS_TOKEN' ANTHROPIC_CUSTOM_HEADERS=$'X-Upstream-Url: https://upstream.example.com/v1/chat/completions\nX-Upstream-Authorization: Bearer YOUR_UPSTREAM_API_KEY' ANTHROPIC_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_OPUS_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_SONNET_MODEL='YOUR_UPSTREAM_MODEL' ANTHROPIC_DEFAULT_HAIKU_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_SUBAGENT_MODEL='YOUR_UPSTREAM_MODEL' CLAUDE_CODE_EFFORT_LEVEL=high API_TIMEOUT_MS=3600000 claude"
```

header 模式使用 Responses 时，把 `X-Upstream-Url` 改为 `/v1/responses`，并在 `ANTHROPIC_CUSTOM_HEADERS` 中增加 `\nX-Upstream-Format: responses`。

如果服务启用了 `OCR_ACCESS_TOKENS`：

- header 模式：`ANTHROPIC_AUTH_TOKEN` 填 Router 访问 token；
- path 模式：在 `ANTHROPIC_CUSTOM_HEADERS` 中增加 `X-OCR-Token: YOUR_ROUTER_ACCESS_TOKEN`。

`X-Upstream-Headers` 可显式添加上游要求的额外 Header。Router 不会透传 Claude Code 的其他原始请求头，也不允许覆盖 Authorization、Host、协议选择 Header 和逐跳 Header。

## 协议覆盖与边界

下面是排障和评估上游兼容性时使用的详细参考。首次使用只需完成前面的快速开始。

<details>
<summary>展开协议兼容性明细</summary>


| 能力 | 默认（Chat Completions） | Responses API |
|---|---|---|
| 文本流式 SSE | ✅ 正式处理 multi-data、LF/CRLF/CR 与跨 chunk UTF-8；兼容 EOF trailing event。Chat 兼容端点在中间 delta 返回空 `finish_reason:""` 时按 `null`（非终态）处理并等待正式终态；未知的非空 reason 仍按上游协议错误关闭 | 同左 |
| 工具调用（`tool_use` / `tool_result` 双向增量） | ✅ 含现代 `tool_calls` 并行工具；流式工具增量会先按调用缓冲，再输出合法的顺序 block；普通 OpenAI function call 返回为正式 `caller:{type:"direct"}`。Anthropic 合法但超过 Chat 64 字符限制的工具名会在单次请求内做稳定、无碰撞、双向透明映射。完整终态中的参数若不是 JSON object，按上游协议错误返回 retryable 502 | ✅ 含并行工具；历史 thinking/text/tool block 通过内部有序表示保真回放为 Responses items，超过 Responses 64 字符限制的历史 `call_id` 会稳定缩短并保持调用/结果严格配对。`program` / `program_output`、programmatic/未知 caller，以及响应侧 `compaction` / `function_call_output` 都依赖无法映射的 hosted-runtime 状态，明确返回 502；caller 缺省或 `direct` 正常转换 |
| 顶层多模态图片（base64 / URL / file） | ✅ base64 / URL 精确映射为标准 `image_url`；provider-owned `file_id` 无法跨上游安全复用，因此本地 400；已知但畸形的 source 返回 400，未来未知 source 有界文本降级；自描述 data URL 保留 | ✅ URL 转标准 `input_image.image_url`；provider-owned `file_id` 同样不跨 provider 盲传，不按模型名猜视觉能力 |
| `tool_result` 中的图片 / 文件 | ⚠️ Chat 的 tool message 只能放文本；base64/URL 图片及可表示为 `file_data` 的文件会在整组 tool message 后转成标准 user 多模态 sidecar。单个多模态 tool result 依靠相邻顺序归属，不增加模型可见 marker；同批合并多个并行结果时，才在各组附件之后追加通用 provenance marker（工具序号 + 完整 ID 的可逆 UTF-16BE/base64url 编码）。视觉/文件输入得以保留，但 text/image 原始交错顺序仍会降级。URL-only 文件转有界文本；`is_error:true` 以前置的稳定 Router metadata marker 保留，false/缺省不改变内容 | ✅ `function_call_output.output` 原生保留 `input_text` / `input_image` / `input_file` 多 block 数组的顺序与归属；`is_error:true` marker 同样保留；纯文本保持 string 以兼容旧端点 |
| 中途 `system` / 工具变更 | ✅ 普通 `messages[].role:"system"` 按正式位置规则保留为 system；direct block 与正式 `mid_conv_system` wrapper 都会展开；`defer_loading`、自定义客户端工具在 `tool_result` 返回的 `tool_reference`，以及 direct `tool_reference` 的 `tool_addition` / `tool_removal` 按历史顺序投影成当前生成应看到的最终工具子集，不把结构指令改成模型可见文本 | 同左；system content part 转正式 `input_text`。依赖服务端执行环境的 hosted tools、hosted tool history 和 opaque replay state 没有通用 OpenAI function-tool 同构，会明确返回协议错误，不伪造成客户端可执行工具或模型可见 JSON |
| document / file block | ✅ base64 / text source 转 Chat `file_data`；Chat 没有正式 `file_url`，URL source 转含 URL 的有界文本；`source:content` 按原顺序展开 text/image，并用 metadata text 保留 title/context；未来未知 source 有界降级；provider-owned `file_id` 本地 400 | ✅ base64/text/URL 转 `input_file`，`source:content` 原样展开为正式 input parts；provider-owned `file_id` 不跨 provider 盲传 |
| provider-owned replay state | ⚠️ 顶层 `container`、`redacted_thinking`、`compaction` / `container_upload` 等 opaque state 无法跨 Anthropic 与 OpenAI provider 重放，显式返回协议错误；对应 nullable 字段为 null 时是 no-op | 同左；Responses 输出的 compaction / hosted function-output state 同样显式 502，不伪装成普通文本 |
| `/model sonnet` / `opus` / haiku 切换 | ✅ body.model 字段透传 | 同左 |
| 客户端中断（Ctrl+C） | ✅ 取消当前上游 reader / fetch | 同左 |
| `output_config.effort` / `thinking` budget | ✅ `low/medium/high/xhigh/max` 精确转成 `reasoning_effort`，不按模型名截断；`thinking.type:"enabled"` 必须提供有限整数且 `budget_tokens >= 1024`，不能与强制 `any` / named tool choice 组合；`adaptive` 必须省略 budget | ✅ 显式 effort 精确转成 `reasoning.effort`；没有显式 effort 时，只有合法 enabled budget 才派生 heuristic 档位，adaptive 交给上游默认且允许强制工具 |
| `thinking` 块 / display | ⚠️ 使用兼容扩展 `reasoning_content`；Chat 没有标准 encrypted replay state，Router 因此把上游明文 reasoning 封入自描述 opaque signature。普通模式显示 thinking，显式 `display:"omitted"` 只返回空 thinking + signature，下一轮再无状态解包回原 `reasoning_content`；这保证协议往返，但不是上游原生加密状态 | ✅ reasoning summary / `reasoning_text` 转 thinking；`{item id, encrypted_content}` 封装成 opaque signature，多个 reasoning item 独立封口并按与 tool call 的邻接关系回放。正式回放始终保留必填 id；可见模式下上游没有 encrypted state 时以 id + 可见 reasoning 兜底，显式 omitted 则必须保留 encrypted state |
| 严格工具 / 结构化输出 | ✅ `tools[].strict` 保真；`output_config.format` → `response_format.json_schema` | ✅ 未声明 strict 时显式发送 `strict:false`；`output_config.format` → `text.format` |
| citations / search result | ⚠️ Anthropic `search_result` 的 title/source metadata 与全部非空 text block 按顺序保留；按 Anthropic 正式规则，`tool_result` 一旦含 search result 就不能混入其他可见 block。启用 document/search-result citations，或回放带非空 citations 的 text block 时，因 OpenAI 请求协议无可逆同构，本地 400；`citations:null` / 空数组为 no-op。若同时请求 structured output，优先返回 Anthropic 的 citations/structured-output 冲突 400 | ⚠️ 同左。响应侧 `web_search_call` 与 citation 按有界 typed JSON 文本保留 id/action/query/URL/range；Responses citation 没有 search-call 归属字段，Router 不猜测配对关系 |
| 音频输出 | ⚠️ Chat 非流式 `message.audio.transcript` 转 text；原始音频字节只产生一次 `[generated audio omitted]`，不泄漏 base64 | ⚠️ SSE transcript delta 转 text；audio delta 只产生一次相同占位符，done 不重复 |
| usage / 错误 | ✅ 输出当前 Anthropic Message/Usage nullable 字段，并映射 reasoning tokens 与可从流式首帧确定的 service tier；错误 envelope 含 nullable `request_id` | ✅ Responses reasoning tokens 保留到 Anthropic `thinking_tokens`。402/409/413/504/529 分别映射 `billing_error` / `conflict_error` / `request_too_large` / `timeout_error` / `overloaded_error`；所有上游非 2xx 均标记可重试且 Router 保持单次上游调用。上游合法且单值的 `Retry-After` / `Retry-After-Ms` 会原值返回，其他响应头不会随之透传 |
| refusal / content filter | ✅ refusal 文本保留为普通 assistant 文本；`content_filter` 映射 `stop_reason:"refusal"`，并返回 `{type:"refusal",category:null,explanation}` 形式的 `stop_details` | 同左；refusal 优先于同一响应中的 function call，工具调用仅保留为有界诊断文本，绝不生成可执行 `tool_use`；流式与非流式、SSE 聚合保持一致 |
| incomplete / 截断工具调用 | ✅ Chat `length` 映射 `max_tokens`；调用名/参数原始字节以有界文本诊断保留，不生成可执行 `tool_use` | ✅ response 或 function item 明确标记 incomplete 时同样以有界文本保留原始字节并返回 `max_tokens`；完整终态中的畸形参数返回 retryable 502 |
| stop sequence | ⚠️ 请求侧 `stop_sequences` 转 Chat `stop`；Chat 响应只报告通用 `finish_reason:"stop"`，无法恢复命中的具体分隔符 | ⚠️ Responses 没有 stop sequence 请求参数，转换时省略该字段 |
| Responses phase / channel | 不适用 | ⚠️ Responses item 的 `phase` / channel 元数据没有 Anthropic Messages 同构字段；Router 保留 reasoning/tool/text 的语义顺序，但不能无损往返 phase 标签 |
| 输出长度 | ⚠️ 最终 model controls 生效后，`model` 必须是非空字符串，`max_tokens` 必须是非负整数；`max_tokens:0` 用于只填充 prompt cache，不能与 stream、thinking、structured output 或强制工具选择组合。Chat 路径保留正式 Chat `max_tokens`，不会按模型名猜测并改写成 `max_completion_tokens`；只接受后者的端点应改走 Responses | ✅ 同一套本地校验；Anthropic `max_tokens` 映射为 Responses `max_output_tokens` |
| legacy `function_call`（旧式 Chat 工具调用） | ✅ 流式与非流式均归一为 `tool_use`，不会静默丢弃 | 不适用 |
| 流式/非流式形态错位 | ✅ 响应形态永远跟随客户端 `stream` 标志：上游对 `stream:true` 回 JSON 时合成完整 SSE，对 `stream:false` 回 SSE 时聚合成 JSON | 同左 |
| 需要缓冲的上游响应体 | ⚠️ Router 不额外限制 JSON、非 2xx 及 `stream:false` 聚合响应的总大小；直接 SSE 转发也不限制总流量，但单个事件仍受 16 MiB / 65,536 行上限 | 同左 |
| Prompt cache（`cache_control`） | ⚠️ Anthropic 显式 breakpoint 会被剥（避免严格上游 400）；若上游自行报告 cached tokens，usage 会映射返回 | 同左 |
| `count_tokens` 端点 | ⚠️ 使用本地 tokenizer 做近似估算，不是上游精确值：统计 system/text、tool input/result、tools，图片固定按 256 token；其他 block 不额外推断 | 同左 |

Router 只做协议转换，不根据模型名猜测视觉、推理或工具能力。标准图片结构仍被文本模型或能力不完整的兼容端点拒绝时，错误属于所选模型 / 上游；Router 会保留上游状态并按既定策略标记为可重试。无法在两个协议间安全同构的状态会明确报错或使用有界降级，不会被静默丢弃或伪造成可执行工具状态。

</details>

## 开发与发布

### 开发验证

仓库完整验证：

```bash
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path rust/Cargo.toml --all-targets
cargo build --locked --release --manifest-path rust/Cargo.toml
```

看板 crate 同样需要通过：

```bash
cargo fmt --manifest-path lens/Cargo.toml -- --check
cargo clippy --locked --manifest-path lens/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path lens/Cargo.toml --all-targets
```

协议改动必须同时增加对应的 Rust 单元测试或 `rust/tests/router_contract.rs` HTTP 契约测试。测试 fixture 不得写入真实 endpoint、模型名或凭证。

### 发布版本

推送版本 tag 时，GitHub Actions 会自动执行 Rust fmt/clippy/test 和 release 构建。验证通过后会同时发布：

- Docker Hub `linux/amd64`、`linux/arm64` 多架构镜像（含转发器与观测看板两个二进制），并校验 manifest / attestations；
- GitHub Release 的 Linux、macOS、Windows amd64/arm64 六个转发器二进制归档和 `SHA256SUMS`。

所有产物都在对应架构的 GitHub 托管 Runner 上原生编译，不使用 QEMU。发布前须在仓库 Actions secrets 配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN`；tag 必须是 SemVer（可带 `v` 前缀），且必须与 `rust/Cargo.toml` 一致。使用 annotated tag，并显式推送该 tag：

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
| `X-Upstream-Effort-Levels` | 两种模式都可用 | 可选 | 声明上游支持的 effort 集合，例如 `low,medium,high`。已知强度顺序为 `minimal < low < medium < high < xhigh < max`；请求值不在集合中时就近调整，平局取较低等级。`none` / `auto` 只做精确匹配，不参与强度调整。与 Map 同时使用时先映射、再调整；Map 命中 `off` 时直接删除字段。未配置时不调整 |
| `X-Upstream-Headers` | 两种模式都可用 | 可选 | JSON object，显式声明要额外转发给上游的 header；不能覆盖受保护 header |
| `Authorization: Bearer <token>` | header | 仅 `OCR_ACCESS_TOKENS` 启用时校验 | 服务自身访问鉴权 |
| `X-OCR-Token` | path | 仅 `OCR_ACCESS_TOKENS` 启用时校验 | path 模式下 `Authorization` 被上游凭证占用，服务鉴权改走此 header |
| `X-Upstream-Format` | 两种模式都可用 | 可选 | `chat-completions`（默认）或 `responses`，声明上游 OpenAI 协议变体 |
| `X-OCR-Client` | 两种模式都可用 | 可选 | 调用方自报身份标签（trim 后截断至 120 字符），记入交互日志的 `client_tag` 字段并用于看板筛选；**只用于观测，不会被转发给上游**。Claude Code 客户端可经 `ANTHROPIC_CUSTOM_HEADERS` 注入 |

### Path 模式

把上游完整 URL 直接拼在服务地址后面，例如：

```
http://localhost:3457/https://upstream.example.com/v1/chat/completions
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
| `OCR_MODEL_LOG_MAX_BODY_BYTES` | `1048576` | 每个请求或响应最多保留的正文 byte 数；超出后只截断日志副本，不影响实际转发。官方镜像调为 32 MiB，保证看板能完整还原大请求 |

以下变量属于[流量观测看板](#流量观测看板lens)进程（`ocr-lens`），对转发行为没有任何影响：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LENS_ENABLED` | `true` | 官方镜像 entrypoint 使用；设为 `false` / `0` / `no` / `off` 时只启动转发器，不启动看板 |
| `LENS_MAX_RESTARTS` | `5` | 看板进程连续异常退出多少次后放弃重启（转发不受影响，容器继续运行） |
| `LENS_RESTART_DELAY` | `5` | 看板进程异常退出后的重启退避秒数 |
| `LENS_PORT` | `3458` | 看板监听端口 |
| `LENS_HOST` | `0.0.0.0` | 看板监听地址；容器内保持 `0.0.0.0`，暴露范围用 `docker run -p` 控制 |
| `LENS_DB_PATH` | `data/lens.db` | SQLite 文件路径（相对当前工作目录）；官方镜像对应 `/app/data/lens.db` |
| `LENS_ACCESS_TOKEN` | unset | 设置后所有数据接口需带 `X-Lens-Token: <token>` 或 `?token=<token>`（页面本身会弹出令牌输入框）；不设则不鉴权 |
| `LENS_RETENTION_DAYS` | `30` | 看板数据库保留天数（按记录时间），每小时清理一次；`0` 表示不清理 |
| `LENS_PRICING_JSON` | unset | 追加价目表条目的 JSON 数组，条目形如 `[{"pattern":"my-model","display":"My Model","input":5,"output":30,"cache_read":0.5,"cache_creation":0,"reasoning":30}]`（单位 USD/MTok）；按模型名最长子串匹配，同长度时自定义条目优先，解析失败会告警并回落内置表 |
| `OCR_MODEL_LOG_DIR` | `logs` | 与转发器共用；看板从这里读取 NDJSON 日志，必须与转发器指向同一目录 |

> 上游请求默认超时 **1 小时**（`rust/src/main.rs`，为长补全 / 推理模型留足余量），目前硬编码、暂不可通过环境变量调整。客户端中断（Ctrl+C）会立即取消当前上游读取。

### 模型交互日志

模型交互日志用于直接核对 Router 的协议边界：`client_request` 是客户端发来的原始 Anthropic JSON（转换发生前）；`model_request` 是 Anthropic 请求完成转换后、实际发给模型方的 OpenAI JSON；`model_response` 是任何响应转换发生前的上游原始 JSON 或 SSE。三者通过 `request_id` 关联，另含以下追溯字段：

- `client_ip`：TCP 直连客户端 IP，不含临时端口；不信任也不读取客户端可伪造的 `X-Forwarded-For` / `X-Real-IP`。部署在反向代理后时这里记录代理 IP，应由代理单独保留真实来源日志。
- `route_mode`：`header` 或 `embedded-path`，用于区分两种接入方式。
- `client_tag`：调用方经 `X-OCR-Client` header 自报的身份标签（未提供时为 null）。
- 上游 URL（已移除 userinfo、query、fragment）、协议格式、模型、HTTP 状态、耗时和正文 byte 数。
- `complete` 表示原始 HTTP body 是否读到 EOF；`protocol_complete` 表示流中是否已经出现 `[DONE]` 或正式 Responses 终态。两者分开后，可以区分“协议已完成后取消底层读取”和真正的半途断开。
- 客户端在上游响应完成前断开时写 `model_cancelled`，并用 `stage` 区分 `waiting_for_upstream_response` 与 `reading_upstream_response`；连接上游失败则写 `model_transport_error`。正常运行且日志存储可写时，每个已发往上游的 `model_request` 都会留下可关联的终态；进程被强杀或日志 fail-open 丢弃时仍可能缺失。

日志文件名为 `model-interactions-YYYY-MM-DD.ndjson`，按 UTC 日期切分。服务启动时及运行中每小时清理过期文件；默认保留当天和前 6 个 UTC 日期。修改保留期示例：

```bash
# 查看官方 Docker 示例当前日期的日志
docker exec ocr sh -c 'tail -n 20 /app/logs/model-interactions-$(date -u +%F).ndjson'

# 在宿主机按直接客户端 IP 汇总当天实际转发次数
jq -s '
  map(select(.event == "model_request"))
  | group_by(.client_ip)
  | map({client_ip: .[0].client_ip, requests: length})
  | sort_by(-.requests)
' ./logs/model-interactions-$(date -u +%F).ndjson

# 用 request_id 还原同一次转发的请求、响应 / 错误 / 取消终态
jq -c --arg id 'YOUR_REQUEST_ID' 'select(.request_id == $id)' \
  ./logs/model-interactions-*.ndjson
```

```bash
# 保留 30 天、每个方向最多记录 4 MiB 正文
docker run -d --name ocr --restart unless-stopped -p 3457:3457 \
  -e OCR_MODEL_LOG_RETENTION_DAYS=30 \
  -e OCR_MODEL_LOG_MAX_BODY_BYTES=4194304 \
  -v ocr-model-logs:/app/logs \
  riba2534/open-claude-router:latest

# 二进制运行同样可自定义；不设置时保留 7 天
OCR_MODEL_LOG_RETENTION_DAYS=30 ./open-claude-router

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

## 流量观测看板（Lens）

官方镜像内置的只读 Web 看板，默认监听 `:3458`，浏览器直接打开即可。它不参与转发，只 tail 转发器写下的模型交互日志、落进 SQLite 并做可视化；看板挂掉不影响转发，转发器写日志失败也不影响转发。

```bash
# 镜像已经同时启动了两个进程，打开浏览器即可
open http://localhost:3458
```

<p align="center">
  <img src="docs/lens-detail.png" alt="请求详情：Claude ↔ Router 视角" width="900" />
  <br/>
  <sub>请求详情页 · Claude ↔ Router（Anthropic）视角，thinking 与 Markdown 正文都已结构化渲染</sub>
</p>

<p align="center">
  <img src="docs/lens-overview.png" alt="总览页" width="900" />
  <br/>
  <sub>总览页 · 请求量、成功率、延迟分位、token 与费用汇总（图中为本地 mock 上游产生的演示数据）</sub>
</p>

### 能看到什么

| 页面 | 内容 |
|---|---|
| **总览** | 请求数、成功/失败、token 与费用汇总、模型与调用方分布、最近请求 |
| **请求** | 按时间倒序的请求列表，可按调用方筛选；点进去是单次交换的完整还原 |
| **会话** | 按 Claude Code 会话聚合的对话，含轮次、累计 token 与费用 |

请求详情页提供**双视角**，对应 Router 两侧的协议边界：

- **Claude ↔ Router（Anthropic）**：客户端发来的原始请求，以及还原成 Anthropic 格式的响应。还原直接复用转发器的转换代码（`transform_chat_json_response` / `transform_responses_json` / SSE 聚合），与线上真实返回一致。
- **Router ↔ 上游（OpenAI）**：转换后实际发出的 JSON，以及上游原始 JSON / SSE 事件流。

两侧都支持渲染视图与原始 JSON 双切换：Markdown 正文、思考块、工具调用与工具结果都会结构化展开，JSON 以可折叠的语法高亮树呈现，整块（system / 每条消息 / 每个工具调用）可点标题栏折叠，默认全展开以便浏览器内 `Ctrl+F` 搜索。详情页还能一键生成复现该次上游调用的 `curl` 命令。

### 会话聚合口径

会话严格按 **Claude Code 自己的 session id** 聚合：客户端在 `metadata.user_id` 中携带该 id，看板解析后与调用方标识组合成 `<调用方>:<session_id>` 作为会话键（不同调用方可能生成相同的确定性 id，因此必须带调用方前缀）。请求里没有 session id 时，回落到 `客户端 IP + system 提示词头部 + 首条 user 消息头部` 的启发式指纹。

### 区分调用方

Router 不猜测调用方身份，也不从部署环境推断——身份由调用方自己声明：请求带上 `X-OCR-Client: <标签>`，Router 原样记录到日志的 `client_tag`，看板据此分组和筛选。它只用于观测，不会被转发给上游（发往上游的额外 header 只来自客户端在 `X-Upstream-Headers` 中显式声明的内容）；不带这个 header 时按客户端 IP 归类。

Claude Code 侧通过环境变量注入即可：

```bash
export ANTHROPIC_CUSTOM_HEADERS="X-OCR-Client: my-laptop"
```

多条 header 用换行分隔。容器化部署可以把容器名、业务线或链路名写进去，看板顶栏就能按标签筛选各自的流量。

### 费用估算

费用按五个互斥 token 桶估算：把 usage 归一成五个桶（未命中缓存的输入、缓存读、缓存写、普通输出、reasoning），分别乘以内置价目表中的 USD/MTok；模型按名称最长子串匹配，未命中时回退 Sonnet 档位。价目表可用 `LENS_PRICING_JSON` 追加或覆盖，且费用是**查询时实时计算**的，改价会自动作用于历史数据。

> 这是估算值，不是账单：以上游自己报告的 usage 为输入，部分网关不报告 cached tokens，此时缓存读会按全价计入。

### 关闭与访问控制

- `LENS_ENABLED=false` 时容器只启动转发器，不启动看板进程。
- 看板默认不鉴权，**任何能访问该端口的人都能看到完整提示词和模型输出**。镜像本身不对你的网络做任何假设：只想本机可见就用 `-p 127.0.0.1:3458:3458`，不映射端口则外部不可达，需要口令再加 `-e LENS_ACCESS_TOKEN=...`——页面会提示输入令牌，接口也接受 `X-Lens-Token` header 或 `?token=` 查询参数。
- 看板只读取日志，`OCR_MODEL_LOG_MODE=metadata` / `off` 时相应地看不到正文；单条正文超过 `OCR_MODEL_LOG_MAX_BODY_BYTES` 会被截断，官方镜像默认放到 32 MiB 就是为了保证大请求可还原。
- 看板数据落在 `LENS_DB_PATH`（镜像内 `/app/data/lens.db`），需要持久化就挂卷；`LENS_RETENTION_DAYS` 控制保留期。

## 常见问题

- **上游错误会重试吗**：会上报为可重试。上游返回任意非 2xx、连接/读取超时，或已请求上游后发现 JSON/SSE 畸形、截断、缺少正式终态时，服务保留/映射状态与 Anthropic 错误体，并增加 `X-Should-Retry: true`。合法、单值的 `Retry-After`（非负秒数或 HTTP-date）和 `Retry-After-Ms`（非负毫秒数）会保持原值返回；重复或畸形值会被丢弃，不会连带透传其他上游响应头。实时 SSE 只能在初始 HTTP 响应已有这些提示时返回，因为流开始后 HTTP header 已不可修改。本地请求校验 400 不带该 header；只有明确的客户端断开返回 499 且不标记重试。具体次数和退避由 Claude Code 决定，Router 自身始终只请求上游一次。
- **上游报 401 / 403**：先确认 `ANTHROPIC_AUTH_TOKEN` 没填反——path 模式里它是**上游凭证**、服务鉴权走 `X-OCR-Token`；header 模式里它是**Router 访问 token**、上游凭证走 `X-Upstream-Authorization`（见[path 模式与 header 模式](#path-模式与-header-模式)）。另外启用了 `OCR_ACCESS_TOKENS` 却没带对应 token 也会被服务拒绝。
- **连不通 / `upstream_unreachable`（502）**：检查上游 URL 是否写全（path 模式要拼到 `/chat/completions` 或 `/responses` 这一级）；Docker 下不要在容器内设 `HOST=127.0.0.1`（见[自定义监听地址](#自定义监听地址)的警告）。
- **上游报 `thinking is enabled but reasoning_content is missing in assistant tool call message`**：部分 Chat Completions 上游在开启 thinking 时，要求带工具调用的 assistant 消息必须携带 `reasoning_content`。服务会把 Anthropic `thinking` 转成 `reasoning_content`，并对缺失的历史工具调用消息补空字符串；若仍遇到，请确认运行的是最新版本。
- **上游报未知字段 400（如 `cache_control` / `reasoning`）**：服务默认会剥掉 Anthropic 专有字段，正常不会发生；若你接的是 Responses 协议上游，确认 alias 带了 `X-Upstream-Format: responses`。
- **Chat 端点拒绝 `max_tokens`**：Router 不按模型名猜字段。如果同一上游提供 Responses API，请把 URL 改为 `/v1/responses` 并设置 `X-Upstream-Format: responses`，此时会发送 `max_output_tokens`。
- **返回里没有 `cache_read_input_tokens` / 看不到 thinking**：Anthropic `cache_control` breakpoint 不会透传；只有上游 usage 自身报告 cached tokens 时才会返回。Chat 的 thinking 依赖非标准 `reasoning_content` 兼容扩展；需要原生 reasoning 请使用 Responses API alias。

## 安全

- 上游凭证会经过 Router 进程；远程上游应使用 HTTPS，Router 对外提供服务时客户端到 Router 也应使用 HTTPS
- 公网部署强烈建议设置 `OCR_ACCESS_TOKENS` 防止扫描滥用
- JSON 运行日志和模型交互日志都不记录请求 Header；模型交互日志中的上游 URL 会移除 userinfo、query 和 fragment
- `client_ip` 属于访问来源数据，`full` 模式还会记录提示词、工具内容和模型输出；敏感场景请缩短 `OCR_MODEL_LOG_RETENTION_DAYS`，或改用 `OCR_MODEL_LOG_MODE=metadata` / `off`
- 不要把上游凭证写入版本控制；可以保存在权限受限的个人 shell 配置中，或在启动 alias 前由本机凭证工具注入
- 观测看板（`:3458`）是完整提示词和模型输出的可读视图，默认不鉴权。镜像不对部署网络做任何假设，端口的可达范围由你在 `docker run` 时决定：仅本机可见用 `-p 127.0.0.1:3458:3458`，不需要看板就不映射该端口或设 `LENS_ENABLED=false`，需要共享访问时用 `LENS_ACCESS_TOKEN` 并在其前面加 HTTPS 反代
- `X-OCR-Client` 是调用方自报的标签，Router 只做记录、不做校验，也不会把它转发给上游；不要把它当作可信身份，也不要在其中写入敏感信息

## Star History

<a href="https://star-history.com/#riba2534/open-claude-router&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=riba2534/open-claude-router&type=Date" />
  </picture>
</a>

## License

MIT
