/**
 * Live protocol acceptance harness for a running open-claude-router.
 *
 * Required environment:
 *   OCR_LIVE_CHAT_URL       Chat Completions upstream endpoint
 *   OCR_LIVE_RESPONSES_URL  Responses upstream endpoint
 *   OCR_LIVE_AUTH           upstream Authorization value (never logged)
 *   OCR_LIVE_MODEL          upstream model name
 *
 * Optional environment:
 *   OCR_LIVE_ROUTER_URL     defaults to http://127.0.0.1:3457
 *
 * Run with:
 *   npx tsx scripts/verify-live-upstream.ts
 */

type UpstreamFormat = "chat-completions" | "responses";
type CaseStatus = "PASS" | "FAIL" | "SKIP";

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
  message?: Record<string, unknown>;
}

interface LiveResult {
  status: number;
  retry: string | null;
  contentType: string;
  json?: any;
  events?: AnthropicEvent[];
  elapsedMs: number;
}

interface CaseContext {
  name: string;
  format?: UpstreamFormat;
  stream?: boolean;
}

class OptionalSkip extends Error {
  constructor(readonly classification: string, message: string) {
    super(message);
  }
}

const CASE_TIMEOUT_MS = 120_000;
const ROUTER_URL = (
  process.env.OCR_LIVE_ROUTER_URL || "http://127.0.0.1:3457"
).replace(/\/+$/, "");
const CHAT_URL = requiredEnv("OCR_LIVE_CHAT_URL");
const RESPONSES_URL = requiredEnv("OCR_LIVE_RESPONSES_URL");
const AUTH = requiredEnv("OCR_LIVE_AUTH", false);
const MODEL = requiredEnv("OCR_LIVE_MODEL");
const ROUTER_MESSAGES_URL = `${ROUTER_URL}/v1/messages`;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PUBLIC_IMAGE_URL = "https://www.w3.org/Icons/w3c_home.png";

let passed = 0;
let failed = 0;
let skipped = 0;

function requiredEnv(name: string, trim = true): string {
  const value = process.env[name];
  if (!value || (trim && !value.trim())) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return trim ? value.trim() : value;
}

function redact(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  const candidates = [AUTH];
  const bearerToken = AUTH.replace(/^Bearer\s+/i, "");
  if (bearerToken !== AUTH && bearerToken.length >= 4) {
    candidates.push(bearerToken);
  }
  for (const secret of candidates) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function emit(
  status: CaseStatus,
  context: CaseContext,
  detail: string,
  elapsedMs?: number,
  classification?: string,
): void {
  const record = {
    status,
    case: context.name,
    ...(context.format ? { format: context.format } : {}),
    ...(context.stream !== undefined ? { stream: context.stream } : {}),
    ...(classification ? { classification } : {}),
    ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
    detail,
  };
  process.stdout.write(`${redact(record)}\n`);
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function parseSse(text: string): AnthropicEvent[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: AnthropicEvent[] = [];
  for (const frame of normalized.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as AnthropicEvent);
    } catch {
      throw new Error("Router returned malformed Anthropic SSE JSON");
    }
  }
  return events;
}

async function callRouter(
  format: UpstreamFormat,
  stream: boolean,
  body: Record<string, unknown>,
): Promise<LiveResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`case timeout after ${CASE_TIMEOUT_MS}ms`)),
    CASE_TIMEOUT_MS,
  );
  timer.unref();
  const started = Date.now();
  try {
    const response = await fetch(ROUTER_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-upstream-url":
          format === "responses" ? RESPONSES_URL : CHAT_URL,
        "x-upstream-authorization": AUTH,
        "x-upstream-format": format,
      },
      body: JSON.stringify({ ...body, stream }),
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const result: LiveResult = {
      status: response.status,
      retry: response.headers.get("x-should-retry"),
      contentType,
      elapsedMs: Date.now() - started,
    };
    if (contentType.includes("text/event-stream")) {
      result.events = parseSse(text);
    } else if (text) {
      try {
        result.json = JSON.parse(text);
      } catch {
        throw new Error(
          `Router returned non-JSON body with HTTP ${response.status}`,
        );
      }
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`case timed out after ${CASE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getRemoteError(result: LiveResult): string {
  const jsonMessage = result.json?.error?.message;
  if (typeof jsonMessage === "string") return redact(jsonMessage);
  const streamError = result.events?.find((event) => event.type === "error");
  if (typeof streamError?.error?.message === "string") {
    return redact(streamError.error.message);
  }
  return `HTTP ${result.status}`;
}

function assertRetryInvariant(result: LiveResult): void {
  if (result.status >= 200 && result.status < 300) {
    if (result.retry !== null) {
      throw new Error("successful response unexpectedly included X-Should-Retry");
    }
    return;
  }
  if (result.retry?.toLowerCase() !== "true") {
    throw new Error(
      `upstream non-2xx HTTP ${result.status} lacked X-Should-Retry:true`,
    );
  }
}

function assertSuccess(result: LiveResult): void {
  assertRetryInvariant(result);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `unexpected HTTP ${result.status}: ${getRemoteError(result)}`,
    );
  }
  if (result.json?.type === "error") {
    throw new Error(`Router JSON error: ${getRemoteError(result)}`);
  }
  const streamError = result.events?.find((event) => event.type === "error");
  if (streamError) {
    throw new Error(`Router SSE error: ${getRemoteError(result)}`);
  }
}

function assertStreamLifecycle(result: LiveResult): void {
  if (!result.contentType.includes("text/event-stream")) {
    throw new Error("stream:true response was not text/event-stream");
  }
  const events = result.events || [];
  if (!events.some((event) => event.type === "message_start")) {
    throw new Error("Anthropic SSE did not contain message_start");
  }
  if (!events.some((event) => event.type === "message_stop")) {
    throw new Error("Anthropic SSE did not contain message_stop");
  }

  const open = new Map<number, string>();
  for (const event of events) {
    if (event.type === "content_block_start") {
      if (typeof event.index !== "number") {
        throw new Error("content_block_start lacked numeric index");
      }
      if (open.has(event.index)) {
        throw new Error(`content block ${event.index} started twice`);
      }
      open.set(event.index, String(event.content_block?.type || "unknown"));
    } else if (event.type === "content_block_delta") {
      if (typeof event.index !== "number" || !open.has(event.index)) {
        throw new Error("content delta targeted a block that was not open");
      }
    } else if (event.type === "content_block_stop") {
      if (typeof event.index !== "number" || !open.delete(event.index)) {
        throw new Error("content block stopped without a matching start");
      }
    }
  }
  if (open.size > 0) {
    throw new Error("Anthropic SSE ended with an open content block");
  }
}

function assertNonStreamMessage(result: LiveResult): void {
  if (!result.contentType.includes("application/json")) {
    throw new Error("stream:false response was not application/json");
  }
  if (result.json?.type !== "message" || !Array.isArray(result.json.content)) {
    throw new Error("response was not an Anthropic message object");
  }
}

function responseText(result: LiveResult): string {
  if (result.events) {
    return result.events
      .filter(
        (event) =>
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta",
      )
      .map((event) => String(event.delta?.text || ""))
      .join("");
  }
  return (result.json?.content || [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block.text || ""))
    .join("");
}

function toolUseBlocks(result: LiveResult): Array<Record<string, unknown>> {
  if (result.events) {
    return result.events
      .filter(
        (event) =>
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use",
      )
      .map((event) => event.content_block || {});
  }
  return (result.json?.content || []).filter(
    (block: any) => block?.type === "tool_use",
  );
}

function assertDirectToolCallers(
  tools: Array<Record<string, unknown>>,
): void {
  for (const tool of tools) {
    const caller = tool.caller;
    if (
      !caller ||
      typeof caller !== "object" ||
      (caller as Record<string, unknown>).type !== "direct"
    ) {
      throw new Error("tool_use block did not preserve caller:direct");
    }
  }
}

function hasReasoning(result: LiveResult): boolean {
  if (result.events) {
    return result.events.some(
      (event) =>
        (event.type === "content_block_start" &&
          event.content_block?.type === "thinking") ||
        (event.type === "content_block_delta" &&
          (event.delta?.type === "thinking_delta" ||
            event.delta?.type === "signature_delta")),
    );
  }
  return (result.json?.content || []).some(
    (block: any) => block?.type === "thinking",
  );
}

function assertUsage(result: LiveResult): void {
  const usage = result.events
    ? result.events
        .filter((event) => event.usage)
        .map((event) => event.usage)
        .at(-1)
    : result.json?.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error("response did not contain usage");
  }
  const input = Number((usage as any).input_tokens ?? 0);
  const output = Number((usage as any).output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input + output <= 0) {
    throw new Error("response usage was missing or zeroed");
  }
}

function assertShape(result: LiveResult, stream: boolean): void {
  assertSuccess(result);
  if (stream) assertStreamLifecycle(result);
  else assertNonStreamMessage(result);
}

function unsupportedPattern(feature: string): RegExp {
  if (feature === "image") {
    return /image|vision|multimodal|input_image|media type|unsupported content/i;
  }
  if (feature === "document") {
    return /document|file|pdf|input_file|unsupported content/i;
  }
  if (feature === "reasoning") {
    return /reasoning|thinking|effort|encrypted_content|unsupported parameter/i;
  }
  return /not supported|unsupported/i;
}

function allowOptionalUnsupported(
  result: LiveResult,
  feature: "image" | "document" | "reasoning",
): void {
  if (result.status >= 200 && result.status < 300) return;
  assertRetryInvariant(result);
  const message = getRemoteError(result);
  if (
    [400, 404, 415, 422].includes(result.status) &&
    unsupportedPattern(feature).test(message)
  ) {
    throw new OptionalSkip(
      `${feature}_unsupported_by_upstream`,
      `upstream explicitly rejected ${feature} input (HTTP ${result.status})`,
    );
  }
  throw new Error(`unexpected HTTP ${result.status}: ${message}`);
}

function allowOptionalParallelUnsupported(result: LiveResult): void {
  if (result.status >= 200 && result.status < 300) return;
  assertRetryInvariant(result);
  const message = getRemoteError(result);
  if (
    [400, 404, 422].includes(result.status) &&
    /parallel[^\n]*(not supported|unsupported|unavailable)|parallel_tool_calls/i.test(
      message,
    )
  ) {
    throw new OptionalSkip(
      "parallel_tools_unsupported_by_upstream",
      `upstream explicitly rejected parallel tools (HTTP ${result.status})`,
    );
  }
  throw new Error(`unexpected HTTP ${result.status}: ${message}`);
}

function baseBody(
  messages: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 128,
    messages,
    ...extra,
  };
}

const TOOLS = [
  {
    name: "live_alpha",
    description: "Return the supplied alpha value.",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "live_beta",
    description: "Return the supplied beta value.",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];

async function runCase(
  context: CaseContext,
  execute: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  try {
    const detail = await execute();
    passed += 1;
    emit("PASS", context, detail, Date.now() - started);
  } catch (error) {
    if (error instanceof OptionalSkip) {
      skipped += 1;
      emit(
        "SKIP",
        context,
        errorMessage(error),
        Date.now() - started,
        error.classification,
      );
      return;
    }
    failed += 1;
    emit("FAIL", context, errorMessage(error), Date.now() - started);
  }
}

async function runSimpleMatrix(): Promise<void> {
  for (const format of ["chat-completions", "responses"] as const) {
    for (const stream of [false, true]) {
      await runCase(
        { name: "simple_text", format, stream },
        async () => {
          const result = await callRouter(
            format,
            stream,
            baseBody([
              {
                role: "user",
                content:
                  "Reply with one short non-empty sentence confirming live protocol connectivity.",
              },
            ]),
          );
          assertShape(result, stream);
          if (!responseText(result).trim()) {
            throw new Error("simple text response was empty");
          }
          assertUsage(result);
          return `text and usage preserved (HTTP ${result.status})`;
        },
      );
    }
  }
}

async function runToolMatrix(): Promise<void> {
  for (const format of ["chat-completions", "responses"] as const) {
    for (const stream of [false, true]) {
      await runCase(
        { name: "required_tool_call", format, stream },
        async () => {
          const result = await callRouter(
            format,
            stream,
            baseBody(
              [
                {
                  role: "user",
                  content:
                    "Call live_alpha with value exactly alpha-marker. Do not answer in prose.",
                },
              ],
              {
                tools: [TOOLS[0]],
                tool_choice: { type: "any", disable_parallel_tool_use: true },
              },
            ),
          );
          assertShape(result, stream);
          const tools = toolUseBlocks(result);
          if (tools.length < 1 || tools[0].name !== "live_alpha") {
            throw new Error("required tool_use block was not preserved");
          }
          assertDirectToolCallers(tools);
          return `${tools.length} tool_use block(s) preserved`;
        },
      );
    }

    await runCase(
      { name: "parallel_tool_calls", format, stream: true },
      async () => {
        const result = await callRouter(
          format,
          true,
          baseBody(
            [
              {
                role: "user",
                content:
                  "Call both live_alpha(value alpha-marker) and live_beta(value beta-marker) in parallel. Do not answer in prose.",
              },
            ],
            {
              tools: TOOLS,
              tool_choice: { type: "any", disable_parallel_tool_use: false },
            },
          ),
        );
        allowOptionalParallelUnsupported(result);
        assertShape(result, true);
        const tools = toolUseBlocks(result);
        if (tools.length === 1) {
          throw new Error(
            "upstream produced one tool call; parallel execution was not observed",
          );
        }
        if (tools.length < 2) {
          throw new Error("parallel tool request produced no tool_use blocks");
        }
        const names = new Set(tools.map((tool) => String(tool.name || "")));
        if (!names.has("live_alpha") || !names.has("live_beta")) {
          throw new Error("parallel tool identities were not preserved");
        }
        assertDirectToolCallers(tools);
        return "two parallel tool calls preserved as valid sequential blocks";
      },
    );
  }
}

function imageBlock(source: Record<string, unknown>): Record<string, unknown> {
  return { type: "image", source };
}

async function runImageCases(): Promise<void> {
  const sources = [
    {
      name: "top_level_base64_image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: TINY_PNG_BASE64,
      },
    },
    {
      name: "top_level_url_image",
      source: { type: "url", url: PUBLIC_IMAGE_URL },
    },
  ];

  for (const format of ["chat-completions", "responses"] as const) {
    for (const fixture of sources) {
      await runCase(
        { name: fixture.name, format, stream: false },
        async () => {
          const result = await callRouter(
            format,
            false,
            baseBody(
              [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Describe this image very briefly." },
                    imageBlock(fixture.source),
                  ],
                },
              ],
              // Reasoning-capable vision models can consume a small 128-token
              // budget before producing any visible text. Keep the live probe
              // focused on protocol fidelity instead of incidental truncation.
              { max_tokens: 512 },
            ),
          );
          allowOptionalUnsupported(result, "image");
          assertShape(result, false);
          if (!responseText(result).trim()) {
            throw new Error("vision response was empty");
          }
          return "typed image reached a vision-capable upstream";
        },
      );
    }

    await runCase(
      { name: "nested_tool_result_text_image", format, stream: false },
      async () => {
        const result = await callRouter(
          format,
          false,
          baseBody(
            [
              {
                role: "user",
                content: "Inspect an artifact using live_alpha.",
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "call_live_nested",
                    name: "live_alpha",
                    input: { value: "artifact" },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "call_live_nested",
                    content: [
                      { type: "text", text: "nested-text-marker" },
                      imageBlock({
                        type: "base64",
                        media_type: "image/png",
                        data: TINY_PNG_BASE64,
                      }),
                    ],
                  },
                  {
                    type: "text",
                    text: "Acknowledge the nested tool result briefly.",
                  },
                ],
              },
            ],
            { tools: [TOOLS[0]] },
          ),
        );
        allowOptionalUnsupported(result, "image");
        assertShape(result, false);
        if (!responseText(result).trim()) {
          throw new Error("nested multimodal tool-result response was empty");
        }
        return "nested tool_result text and image completed a tool round trip";
      },
    );
  }
}

async function runDocumentCases(): Promise<void> {
  for (const format of ["chat-completions", "responses"] as const) {
    await runCase(
      { name: "top_level_text_document", format, stream: false },
      async () => {
        const result = await callRouter(
          format,
          false,
          baseBody(
            [
              {
                role: "user",
                content: [
                  {
                    type: "document",
                    title: "live-document.txt",
                    source: {
                      type: "text",
                      data: "The live document marker is document-marker.",
                    },
                  },
                  {
                    type: "text",
                    text: "State the marker contained in the document.",
                  },
                ],
              },
            ],
            { max_tokens: 512 },
          ),
        );
        allowOptionalUnsupported(result, "document");
        assertShape(result, false);
        if (!responseText(result).includes("document-marker")) {
          throw new Error("document marker was not preserved");
        }
        return `${format === "responses" ? "input_file" : "file"} document path completed`;
      },
    );
  }
}

async function runReasoningCases(): Promise<void> {
  for (const stream of [false, true]) {
    await runCase(
      { name: "responses_reasoning_usage", format: "responses", stream },
      async () => {
        const result = await callRouter(
          "responses",
          stream,
          baseBody(
            [
              {
                role: "user",
                content:
                  "Solve 237 multiplied by 419. Return only the integer.",
              },
            ],
            {
              max_tokens: 2048,
              thinking: { type: "enabled", budget_tokens: 1024 },
              // A trivial low-effort prompt can legitimately produce zero
              // reasoning tokens, which cannot exercise the conversion path.
              output_config: { effort: "xhigh" },
            },
          ),
        );
        allowOptionalUnsupported(result, "reasoning");
        assertShape(result, stream);
        assertUsage(result);
        if (!hasReasoning(result)) {
          throw new Error(
            "upstream succeeded with usage but emitted no reasoning item",
          );
        }
        return "reasoning block/signature and usage preserved";
      },
    );
  }

  await runCase(
    { name: "responses_reasoning_history_replay", format: "responses", stream: false },
    async () => {
      const firstPrompt =
        "Solve 237 multiplied by 419. Return only the integer.";
      const reasoningOptions = {
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 1024 },
        output_config: { effort: "xhigh" },
      };
      const first = await callRouter(
        "responses",
        false,
        baseBody([{ role: "user", content: firstPrompt }], reasoningOptions),
      );
      assertShape(first, false);
      if (!hasReasoning(first)) {
        throw new Error("initial response did not expose replayable reasoning");
      }

      const second = await callRouter(
        "responses",
        false,
        baseBody(
          [
            { role: "user", content: firstPrompt },
            { role: "assistant", content: first.json.content },
            {
              role: "user",
              content: "Add one to the prior result. Return only the integer.",
            },
          ],
          reasoningOptions,
        ),
      );
      if (second.status < 200 || second.status >= 300) {
        assertRetryInvariant(second);
        const message = getRemoteError(second);
        if (
          second.status === 409 &&
          /item with id .+ not found|different (?:Azure )?OpenAI resource/i.test(
            message,
          )
        ) {
          throw new OptionalSkip(
            "reasoning_history_replay_not_supported_by_upstream",
            "upstream cannot resolve a replayed reasoning item across requests",
          );
        }
      }
      assertShape(second, false);
      assertUsage(second);
      if (!responseText(second).trim()) {
        throw new Error("reasoning history replay response was empty");
      }
      return "opaque reasoning signature replayed on the next turn";
    },
  );
}

async function runInvalidModelCases(): Promise<void> {
  for (const format of ["chat-completions", "responses"] as const) {
    await runCase(
      { name: "invalid_model_retry_boundary", format, stream: false },
      async () => {
        const result = await callRouter(
          format,
          false,
          {
            model: `ocr-live-intentionally-invalid-${Date.now()}`,
            max_tokens: 8,
            messages: [{ role: "user", content: "This must not succeed." }],
          },
        );
        if (result.status >= 200 && result.status < 300) {
          throw new Error("intentionally invalid model unexpectedly succeeded");
        }
        assertRetryInvariant(result);
        if (result.json?.type !== "error") {
          throw new Error("invalid model did not return an Anthropic error envelope");
        }
        return `HTTP ${result.status} preserved with X-Should-Retry:true`;
      },
    );
  }
}

async function main(): Promise<void> {
  await runSimpleMatrix();
  await runToolMatrix();
  await runImageCases();
  await runDocumentCases();
  await runReasoningCases();
  await runInvalidModelCases();

  emit(
    failed === 0 ? "PASS" : "FAIL",
    { name: "summary" },
    `${passed} passed, ${skipped} skipped, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  failed += 1;
  emit("FAIL", { name: "harness" }, errorMessage(error));
  process.exitCode = 1;
});
