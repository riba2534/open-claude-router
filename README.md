# open-claude-router

`open-claude-router` is a high-concurrency Rust service that converts the Anthropic Messages API to OpenAI Chat Completions or Responses and converts upstream responses back to Anthropic format.

The router is stateless: every request supplies its upstream URL, authorization value, model selection, and optional compatibility controls. The service does not load provider configuration and does not persist credentials.

## Features

- Axum + Tokio asynchronous server with a shared `reqwest` connection pool.
- Anthropic Messages request and response compatibility, including JSON and SSE.
- OpenAI Chat Completions and Responses upstream protocols.
- Text, thinking, tools, parallel tool calls, images, documents, structured output, refusals, usage, and token estimation.
- Header and embedded-path access modes.
- Optional service authentication.
- Bounded response buffering and SSE parsing.
- Fail-open model interaction logging with configurable retention.
- A single release binary and a minimal container image.

## Build and run

Rust 1.97 or newer is required.

```bash
cargo run --locked --manifest-path rust/Cargo.toml
```

The server listens on `0.0.0.0:3457` by default.

```bash
HOST=127.0.0.1 PORT=8080 \
  cargo run --locked --release --manifest-path rust/Cargo.toml
```

Health check:

```bash
curl http://127.0.0.1:3457/healthz
```

## Request modes

### Header mode

Send Anthropic requests to `POST /v1/messages` and provide the upstream connection in headers:

```bash
curl http://127.0.0.1:3457/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'X-Upstream-Url: https://api.openai.com/v1/chat/completions' \
  -H 'X-Upstream-Authorization: Bearer YOUR_UPSTREAM_KEY' \
  -d '{
    "model": "UPSTREAM_MODEL",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

For OpenAI Responses, use the Responses endpoint and select the protocol explicitly:

```bash
curl http://127.0.0.1:3457/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'X-Upstream-Url: https://api.openai.com/v1/responses' \
  -H 'X-Upstream-Authorization: Bearer YOUR_UPSTREAM_KEY' \
  -H 'X-Upstream-Format: responses' \
  -d '{
    "model": "UPSTREAM_MODEL",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Embedded-path mode

Put the complete upstream endpoint after the router origin. Claude-compatible clients append `/v1/messages` automatically:

```text
http://127.0.0.1:3457/https://api.openai.com/v1/chat/completions
```

In this mode, `Authorization: Bearer <value>` carries the upstream authorization value; the router removes only the outer `Bearer ` prefix. When service authentication is enabled, use `X-OCR-Token` for the router token.

## Headers

| Header | Purpose |
|---|---|
| `X-Upstream-Url` | Required upstream URL in header mode. |
| `X-Upstream-Authorization` | Required upstream Authorization value in header mode; forwarded without reconstruction. |
| `X-Upstream-Format` | `chat-completions` by default; set to `responses` for OpenAI Responses. |
| `X-Upstream-Model` | Overrides the request model. |
| `X-Upstream-Model-Map` | Comma-separated exact model mappings such as `client-a=upstream-a`. |
| `X-Upstream-File-Map` | Non-empty JSON object mapping client file IDs to IDs owned by the selected upstream. |
| `X-Upstream-Effort-Map` | Maps Anthropic effort values; `off` removes the upstream effort field. |
| `X-Upstream-Effort-Levels` | Declares upstream effort levels for deterministic clamping. |
| `X-Upstream-Headers` | Non-empty JSON object containing explicitly allowed additional upstream headers. |
| `X-OCR-Token` | Service token in embedded-path mode when `OCR_ACCESS_TOKENS` is enabled. |

The router constructs a new upstream header set. Client SDK headers are never copied wholesale, and protected headers cannot be overridden through `X-Upstream-Headers`.

## Service authentication

Set a comma-separated token list:

```bash
OCR_ACCESS_TOKENS='token-a,token-b' \
  cargo run --locked --release --manifest-path rust/Cargo.toml
```

- Header mode uses `Authorization: Bearer <service-token>`.
- Embedded-path mode uses `X-OCR-Token: <service-token>`.

## Token counting

`POST /v1/messages/count_tokens` accepts the same request shape. The result is a local `o200k` estimate rather than a provider-authoritative count. Embedded-path mode also supports the count-tokens suffix.

## Error and retry contract

- Every upstream non-2xx response preserves its status and is returned with `X-Should-Retry: true`.
- Upstream connection, timeout, read, malformed response, and truncated stream failures are retryable gateway errors.
- Local request validation errors do not carry the retry header.
- A confirmed downstream client disconnect returns 499 without the retry header.
- The router never retries an upstream request itself. Retry count and backoff belong to the client.

## Resource limits

- Responses that require full buffering are limited to 64 MiB.
- A partial SSE line or one SSE event is limited to 16 MiB of UTF-8 data.
- One SSE event is limited to 65,536 lines.
- Model log body capture is independently bounded and never changes forwarded bytes.

## Model interaction logs

Logs default to `./logs` and retain seven UTC days. Authorization and additional upstream headers are not logged.

| Environment variable | Default | Meaning |
|---|---:|---|
| `OCR_MODEL_LOG_MODE` | `full` | `full`, `metadata`, or `off`. |
| `OCR_MODEL_LOG_DIR` | `./logs` | Log directory. |
| `OCR_MODEL_LOG_RETENTION_DAYS` | `7` | Non-negative UTC-day retention. |
| `OCR_MODEL_LOG_MAX_BODY_BYTES` | `1048576` | Maximum captured request or response body bytes. |

Logging is fail-open: filesystem errors, cleanup errors, and logger backpressure do not alter request count, response status, response bytes, or retry behavior.

## Development

Run the complete Rust acceptance suite:

```bash
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path rust/Cargo.toml --all-targets
cargo build --locked --release --manifest-path rust/Cargo.toml
```

Important modules:

| Responsibility | Path |
|---|---|
| HTTP routes and request lifecycle | `rust/src/router.rs` |
| Authentication and upstream selection | `rust/src/auth.rs` |
| Upstream HTTP transport | `rust/src/upstream.rs` |
| Anthropic request conversion | `rust/src/transform/request.rs` |
| Chat response conversion | `rust/src/transform/response.rs` |
| Responses protocol conversion | `rust/src/transform/responses.rs` |
| SSE decoding and streaming | `rust/src/sse.rs`, `rust/src/streaming.rs` |
| Token estimation | `rust/src/tokenizer.rs` |
| Model interaction logs | `rust/src/model_log.rs` |
| HTTP contract tests | `rust/tests/router_contract.rs` |

## Container image

Build locally:

```bash
docker build --pull -t open-claude-router:local .
docker run --rm -p 3457:3457 \
  -e OCR_MODEL_LOG_MODE=off \
  open-claude-router:local
```

Release tags trigger a Rust validation workflow and publish `linux/amd64` and `linux/arm64` images. A release tag must be valid SemVer, optionally prefixed with `v`, and must match the version in `rust/Cargo.toml`.

## Security

- Do not commit upstream endpoints, model identifiers, credentials, or private gateway details.
- Upstream redirects are disabled.
- Authorization values are validated against CR/LF injection.
- Provider-owned file IDs require an explicit `X-Upstream-File-Map` mapping before they can be sent to another provider.
- Unknown or non-isomorphic protocol state is rejected or bounded; it is not silently promoted into executable tool state.

## License

MIT. See [LICENSE](LICENSE).
