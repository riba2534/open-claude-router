# Repository guidance

## Project

`open-claude-router` is a stateless Rust service that converts Anthropic Messages requests to OpenAI Chat Completions or Responses and converts upstream responses back to Anthropic format. The Cargo project is in `rust/` and uses Axum, Tokio, Reqwest, Serde, and rustls.

The router receives the upstream URL, authorization value, model, and compatibility controls on every request. It must not load provider configuration or persist credentials.

## Required checks

Run these after code changes:

```bash
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path rust/Cargo.toml --all-targets
cargo build --locked --release --manifest-path rust/Cargo.toml
```

Protocol changes require focused unit tests and HTTP contract tests. Do not place real endpoints, model names, credentials, or private gateway details in source, tests, documentation, commits, or logs.

## Architecture

| Responsibility | Path |
|---|---|
| Router construction and request lifecycle | `rust/src/router.rs` |
| Authentication, access modes, headers, model and effort controls | `rust/src/auth.rs` |
| Upstream connection pool and bounded response reads | `rust/src/upstream.rs` |
| Anthropic request conversion | `rust/src/transform/request.rs` |
| Chat response conversion and Anthropic output | `rust/src/transform/response.rs` |
| OpenAI Responses conversion | `rust/src/transform/responses.rs` |
| SSE parsing and stream state machines | `rust/src/sse.rs`, `rust/src/streaming.rs` |
| Error envelopes and retry metadata | `rust/src/error.rs` |
| Token estimation | `rust/src/tokenizer.rs` |
| Model interaction logs | `rust/src/model_log.rs` |
| HTTP contract tests | `rust/tests/router_contract.rs` |

Both access modes converge on the same conversion and transport path:

- Header mode: `POST /v1/messages`, with `X-Upstream-Url` and `X-Upstream-Authorization`.
- Embedded-path mode: `POST /http(s)://.../v1/messages`, with upstream authorization in the outer Bearer header.
- `X-Upstream-Format` selects `chat-completions` or `responses` independently of the access mode.

## Invariants

- Construct upstream headers from an allowlist. Never copy all client headers.
- Preserve the upstream Authorization value exactly in header mode; reject CR/LF injection.
- Disable upstream redirects.
- Every upstream non-2xx response is retryable for the client, including deterministic 4xx responses. Preserve the status when possible and set `X-Should-Retry: true`.
- The router performs exactly one upstream request. It must not mutate a failed request and retry internally.
- Local validation errors are not retryable. A confirmed downstream disconnect is 499 and is not retryable.
- Upstream timeout, read, malformed JSON/SSE, missing terminal state, and protocol truncation errors are retryable.
- A dropped downstream body must cancel the active upstream reader.
- Model logging is fail-open and must not receive Authorization or additional upstream headers.
- Fully buffered upstream bodies are bounded at 64 MiB. SSE partial lines and individual events are bounded at 16 MiB and 65,536 lines.
- Do not infer model capabilities from model names, provider names, tool names, or business scenarios.
- Preserve typed `tool_result` blocks. Chat tool messages remain text-only; multimodal bytes use a following user sidecar. Responses uses typed function output parts.
- Provider-owned file IDs must be explicitly mapped through `X-Upstream-File-Map`.
- Incomplete or malformed parallel function calls are atomic: if one call is unsafe, none of the sibling calls may be exposed as executable `tool_use`.
- A Responses stream succeeds only after a formal completed or incomplete terminal event. EOF or `[DONE]` alone is not a success declaration.
- Refusal has higher terminal priority than incomplete tool calls.
- `thinking.display:"omitted"` hides visible thinking only when explicitly requested while preserving replay state.
- Unknown protocol state must use a bounded, typed fallback or an explicit error; never silently invent provider-owned state.

## Change map

- Routes and access modes: `rust/src/router.rs`
- Header parsing, service auth, model/file/effort mappings: `rust/src/auth.rs`
- Timeouts, redirects, response size, upstream read failures: `rust/src/upstream.rs`
- Request fields, tools, thinking, documents, images: `rust/src/transform/request.rs`
- Chat JSON/SSE responses and Anthropic event shape: `rust/src/transform/response.rs`, `rust/src/streaming.rs`
- Responses request/items/events/terminal handling: `rust/src/transform/responses.rs`, `rust/src/streaming.rs`
- SSE framing limits and decoding: `rust/src/sse.rs`
- Error type/status/retry mapping: `rust/src/error.rs`
- Token estimation: `rust/src/tokenizer.rs`
- Logging and retention: `rust/src/model_log.rs`

When adding an upstream protocol, add an explicit format enum and parser branch, then add explicit request and response conversion branches. Never allow a new protocol to fall through to the Chat default.
