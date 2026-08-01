import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { SseBlockDecoder } from "../src/transformers/sse.js";
import { registerMessagesRoute } from "../src/routes/messages.js";
import { scrubResponsesReasoningArtifacts } from "../src/utils/strip.js";
import type { ApiError } from "../src/transformers/errors.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

const context = { req: { id: "protocol-fixes-test" } } as any;

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function parseAnthropicSse(text: string): any[] {
  return text
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line!.slice(6)));
}

async function chatStreamToAnthropic(response: Response): Promise<any[]> {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(response, context);
  return parseAnthropicSse(await converted.text());
}

async function responsesStreamToAnthropic(response: Response): Promise<any[]> {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  return chatStreamToAnthropic(await responses.transformResponseOut(response));
}

// Replicates src/server.ts's setErrorHandler so error-envelope behavior is
// verified end to end, not just at the route layer.
async function withRouter(
  handler: (body: any, url: string) => Response,
  run: (app: ReturnType<typeof Fastify>) => Promise<void>,
) {
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const originalFetch = globalThis.fetch;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const apiErr = error as ApiError;
    reply.code(apiErr.statusCode ?? 500).send({
      type: "error",
      error: {
        type: apiErr.type ?? "api_error",
        message: (error as Error)?.message ?? "internal error",
      },
    });
  });
  await registerMessagesRoute(app);
  globalThis.fetch = (async (input: any, init: any) =>
    handler(JSON.parse(String(init?.body)), String(input))) as typeof fetch;
  try {
    await run(app);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) {
      delete process.env.OCR_ACCESS_TOKENS;
    } else {
      process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  }
}

const upstreamHeaders = {
  "x-upstream-url": "https://upstream.example.com/v1/chat/completions",
  "x-upstream-authorization": "Bearer upstream-secret",
};

// ---------------------------------------------------------------------------
// F1: reply shape always follows the client's `stream` flag
// ---------------------------------------------------------------------------

test("stream:true with a JSON upstream yields a full synthesized Anthropic SSE stream", async () => {
  await withRouter(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-json",
          object: "chat.completion",
          created: 1,
          model: "gateway-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "hello",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"a"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(response.statusCode, 200);
      assert.match(
        String(response.headers["content-type"]),
        /text\/event-stream/,
      );
      const events = parseAnthropicSse(response.body);
      assert.equal(events[0].type, "message_start");
      assert.equal(events.at(-1)?.type, "message_stop");
      assert.equal(
        events.find((event) => event.delta?.type === "text_delta")?.delta.text,
        "hello",
      );
      assert.equal(
        events.find((event) => event.type === "content_block_start" &&
          event.content_block?.type === "tool_use")?.content_block.name,
        "read",
      );
      assert.deepEqual(
        events.find((event) => event.type === "content_block_start" &&
          event.content_block?.type === "tool_use")?.content_block.caller,
        { type: "direct" },
      );
      const terminal = events.find((event) => event.type === "message_delta");
      assert.equal(terminal.delta.stop_reason, "tool_use");
      assert.deepEqual(terminal.usage, {
        input_tokens: 8,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
      });
    },
  );
});

test("stream:false with an SSE upstream aggregates to one JSON message", async () => {
  await withRouter(
    () =>
      new Response(
        [
          { id: "c", model: "m", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] },
          { id: "c", model: "m", choices: [{ index: 0, delta: { content: "tial" }, finish_reason: "stop" }] },
          {
            id: "c",
            model: "m",
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(response.statusCode, 200);
      assert.match(
        String(response.headers["content-type"]),
        /application\/json/,
      );
      const body = response.json() as any;
      assert.equal(body.type, "message");
      assert.deepEqual(body.content, [{ type: "text", text: "partial" }]);
      assert.equal(body.stop_reason, "end_turn");
      assert.equal(body.usage.output_tokens, 2);
    },
  );
});

test("stream:false with a failing SSE upstream is a 502 error, not a fake message", async () => {
  await withRouter(
    () =>
      new Response(
        `data: ${JSON.stringify({
          id: "c",
          model: "m",
          error: { message: "mid-stream failure" },
          choices: [],
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(response.statusCode, 502);
      const body = response.json() as any;
      assert.equal(body.type, "error");
      assert.match(body.error.message, /mid-stream failure/);
    },
  );
});

// ---------------------------------------------------------------------------
// F2: array-typed delta.content and coexisting refusal
// ---------------------------------------------------------------------------

test("array-typed streaming delta.content is normalized to a text string", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-array",
        model: "m",
        choices: [
          {
            index: 0,
            delta: { content: [{ type: "text", text: "array text" }] },
            finish_reason: null,
          },
        ],
      },
      { id: "chatcmpl-array", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]),
  );
  const textDelta = events.find((event) => event.delta?.type === "text_delta");
  assert.equal(typeof textDelta?.delta.text, "string");
  assert.equal(textDelta?.delta.text, "array text");
});

test("a delta carrying both content and refusal keeps both", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-both",
        model: "m",
        choices: [
          {
            index: 0,
            delta: { content: "answer: ", refusal: "REFUSED" },
            finish_reason: null,
          },
        ],
      },
      { id: "chatcmpl-both", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]),
  );
  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "answer: REFUSED",
  );
});

// ---------------------------------------------------------------------------
// F11: legacy function_call must not become a successful empty turn
// ---------------------------------------------------------------------------

test("legacy streaming function_call becomes tool_use with stop_reason tool_use", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-legacy",
        model: "m",
        choices: [
          {
            index: 0,
            delta: { function_call: { name: "f", arguments: '{"a":1}' } },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-legacy",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "function_call" }],
      },
    ]),
  );
  const toolStart = events.find(
    (event) =>
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use",
  );
  assert.equal(toolStart?.content_block.name, "f");
  assert.deepEqual(toolStart?.content_block.caller, { type: "direct" });
  assert.equal(
    events.find((event) => event.delta?.type === "input_json_delta")?.delta
      .partial_json,
    '{"a":1}',
  );
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "tool_use",
  );
});

test("legacy non-stream function_call becomes tool_use", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(
      JSON.stringify({
        id: "chatcmpl-legacy",
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              function_call: { name: "f", arguments: '{"a":1}' },
            },
            finish_reason: "function_call",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    context,
  );
  const body: any = await converted.json();
  assert.equal(body.content[0].type, "tool_use");
  assert.equal(body.content[0].name, "f");
  assert.deepEqual(body.content[0].input, { a: 1 });
  assert.deepEqual(body.content[0].caller, { type: "direct" });
  assert.equal(body.stop_reason, "tool_use");
});

// ---------------------------------------------------------------------------
// F3/F4: unknown top-level blocks degrade instead of deleting the turn;
// no message ever ships an empty content array
// ---------------------------------------------------------------------------

test("a user turn of only unknown blocks degrades per-block and survives", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "user",
        content: [{ type: "future_search_result", value: 1 }],
      },
    ],
  });
  assert.equal(unified.messages.length, 1);
  assert.deepEqual(unified.messages[0].content, [
    { type: "text", text: '{"type":"future_search_result","value":1}' },
  ]);
});

test("a malformed image source is rejected instead of leaving empty content", async () => {
  const anthropic = new AnthropicTransformer();
  await assert.rejects(
    anthropic.transformRequestOut!({
      model: "claude-test",
      system: [{ type: "image", source: { type: "base64" } }],
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "file" } }],
      }],
    }),
    (error: any) =>
      error.statusCode === 400 && /provider-owned/.test(error.message),
  );
});

test("oversized documents stay typed and oversized unknown blocks stay bounded", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "A".repeat(100_000),
            },
          },
          { type: "future_large_block", payload: "B".repeat(100_000) },
        ],
      },
    ],
  });
  const [document, unknown] = unified.messages[0].content as any[];
  assert.equal(document.type, "file");
  assert.equal(document.file.filename, "document.pdf");
  assert.equal(
    document.file.file_data,
    `data:application/pdf;base64,${"A".repeat(100_000)}`,
  );
  assert.ok(document.fallback_text.length < 5000);
  assert.match(document.fallback_text, /100000 base64 chars/);
  assert.deepEqual(unknown, {
    type: "text",
    text: "[unsupported future_large_block block omitted: 100042 chars]",
  });
});

// ---------------------------------------------------------------------------
// F15: malformed request shapes are 400 invalid_request_error end to end
// ---------------------------------------------------------------------------

test("null entries in messages/system/content/tools return 400, not 500", async () => {
  await withRouter(
    () => {
      throw new Error("upstream must not be called");
    },
    async (app) => {
      const payloads = [
        { messages: [null] },
        { system: [null], messages: [{ role: "user", content: "hi" }] },
        { messages: [{ role: "user", content: [null] }] },
        {
          messages: [{ role: "user", content: "hi" }],
          tools: [null],
        },
        { messages: "not-an-array" },
      ];
      for (const extra of payloads) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: upstreamHeaders,
          payload: { model: "claude-test", max_tokens: 8, ...extra },
        });
        assert.equal(
          response.statusCode,
          400,
          `expected 400 for ${JSON.stringify(extra)}`,
        );
        const body = response.json() as any;
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "invalid_request_error");
        assert.doesNotMatch(body.error.message, /Cannot read properties/);
        assert.equal(response.headers["x-should-retry"], undefined);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// F5: multiple reasoning items survive the full round trip
// ---------------------------------------------------------------------------

test("two reasoning items with two tool calls replay interleaved with both ids", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;

  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_multi",
        object: "response",
        created_at: 1,
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "R1" }],
            encrypted_content: "E1",
          },
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "f",
            arguments: "{}",
          },
          {
            id: "rs_2",
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "R2" }],
            encrypted_content: "E2",
          },
          {
            id: "fc_2",
            type: "function_call",
            call_id: "call_2",
            name: "g",
            arguments: "{}",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, context);
  const message: any = await final.json();

  // Interleaved Anthropic content: thinking(rs_1), tool_use(call_1),
  // thinking(rs_2), tool_use(call_2).
  assert.deepEqual(
    message.content.map((block: any) => block.type),
    ["thinking", "tool_use", "thinking", "tool_use"],
  );

  // Replay the assistant turn and confirm both reasoning ids survive,
  // adjacent to their calls.
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: message.content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "ok1" },
          { type: "tool_result", tool_use_id: "call_2", content: "ok2" },
        ],
      },
    ],
  });
  scrubResponsesReasoningArtifacts(unified as any);
  const replay: any = await responses.transformRequestIn!(unified);
  // Encrypted state replays each item self-containedly, so it — not a
  // server-side id — is what keeps the two reasoning items distinct.
  const shape = replay.input.map((item: any) =>
    item.type === "reasoning"
      ? `reasoning:${item.encrypted_content}`
      : item.type === "function_call"
        ? `function_call:${item.call_id}`
        : item.type === "function_call_output"
          ? `output:${item.call_id}`
          : `message:${item.role}`,
  );
  assert.deepEqual(shape, [
    "message:user",
    "reasoning:E1",
    "function_call:call_1",
    "reasoning:E2",
    "function_call:call_2",
    "output:call_1",
    "output:call_2",
  ]);
  const reasoningItems = replay.input.filter(
    (item: any) => item.type === "reasoning",
  );
  assert.deepEqual(
    reasoningItems.map((item: any) => item.encrypted_content),
    ["E1", "E2"],
  );
  assert.deepEqual(
    reasoningItems.map((item: any) => item.id),
    ["rs_1", "rs_2"],
  );
});

// ---------------------------------------------------------------------------
// F6: usage arriving before the finish chunk is preserved
// ---------------------------------------------------------------------------

test("usage delivered before the finish chunk is not zeroed", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-usage-first",
        model: "m",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
      {
        id: "chatcmpl-usage-first",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
  );
  assert.deepEqual(
    events.find((event) => event.type === "message_delta")?.usage,
    {
      input_tokens: 60,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
    },
  );
});

// ---------------------------------------------------------------------------
// F13: cached_tokens larger than prompt_tokens cannot go negative
// ---------------------------------------------------------------------------

test("cached tokens exceeding prompt tokens clamp input_tokens at zero", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(
      JSON.stringify({
        id: "chatcmpl-cache",
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4096 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    context,
  );
  const body: any = await converted.json();
  assert.equal(body.usage.input_tokens, 0);
  assert.equal(body.usage.cache_read_input_tokens, 4096);
});

// ---------------------------------------------------------------------------
// F7: dedup keys align between id-less deltas and id-carrying done events
// ---------------------------------------------------------------------------

test("output_text delta without item_id is not duplicated by its done event", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.created",
        response: { id: "resp_dedup", model: "gpt-test" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "hello world",
      },
      {
        type: "response.output_text.done",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        text: "hello world",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_dedup",
          model: "gpt-test",
          output: [{ type: "message" }],
        },
      },
    ]),
  );
  assert.deepEqual(
    events
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text),
    ["hello world"],
  );
});

test("reasoning delta without item_id is not duplicated by output_item.done", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.created",
        response: { id: "resp_dedup_rs", model: "gpt-test" },
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "thinking...",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_1",
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "thinking..." }],
          encrypted_content: "E1",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_dedup_rs",
          model: "gpt-test",
          output: [{ type: "reasoning" }],
        },
      },
    ]),
  );
  assert.deepEqual(
    events
      .filter((event) => event.delta?.type === "thinking_delta")
      .map((event) => event.delta.thinking),
    ["thinking..."],
  );
});

// ---------------------------------------------------------------------------
// F8: empty data: keepalives do not abort a healthy stream
// ---------------------------------------------------------------------------

test("an empty data: keepalive mid-stream does not abort the response", async () => {
  const wire =
    `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    })}\n\n` +
    "data: \n\n" +
    `data: ${JSON.stringify({
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n` +
    "data: [DONE]\n\n";
  const events = await chatStreamToAnthropic(
    new Response(wire, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.at(-1)?.type, "message_stop");
});

// ---------------------------------------------------------------------------
// F9: non-url_citation annotations are ignored, not fatal
// ---------------------------------------------------------------------------

test("annotations without url_citation neither crash the stream nor fake a web_search block", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-ann",
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              content: "text",
              annotations: [{ type: "file_citation", file_citation: {} }],
            },
            finish_reason: null,
          },
        ],
      },
      { id: "chatcmpl-ann", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]),
  );
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(
    events.some(
      (event) => event.content_block?.type === "server_tool_use",
    ),
    false,
  );
  assert.equal(events.at(-1)?.type, "message_stop");
});

// ---------------------------------------------------------------------------
// F10: decoder is linear and refuses unbounded lines
// ---------------------------------------------------------------------------

test("a multi-megabyte un-newlined line stays fast and bounded", () => {
  const decoder = new SseBlockDecoder();
  const encoder = new TextEncoder();
  const chunk = encoder.encode("x".repeat(4096));
  const start = process.hrtime.bigint();
  let threw = false;
  try {
    // 8 MB of a single line in 4 KB chunks: linear scanning must stay well
    // under a second (the quadratic version took ~24s at this size).
    for (let i = 0; i < 2048; i++) {
      decoder.push(chunk);
    }
    // Push past the 16 MB cap to trigger the guard.
    for (let i = 0; i < 4096; i++) {
      decoder.push(chunk);
    }
  } catch (error: any) {
    threw = true;
    assert.match(error.message, /SSE line exceeded/);
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(threw, "oversized line did not throw");
  assert.ok(elapsedMs < 5000, `decoder too slow: ${elapsedMs}ms`);
});

test("decoder still splits CRLF across chunks after the scan-offset change", () => {
  const decoder = new SseBlockDecoder();
  const encoder = new TextEncoder();
  const events: any[] = [];
  events.push(...decoder.push(encoder.encode('data: {"a":1}\r')));
  events.push(...decoder.push(encoder.encode("\n\r\n")));
  events.push(...decoder.push(encoder.encode('data: {"b":2}\n\n')));
  events.push(...decoder.finish());
  assert.deepEqual(
    events.map((event) => event.data),
    ['{"a":1}', '{"b":2}'],
  );
});

// ---------------------------------------------------------------------------
// F12: absent budget_tokens must not escalate to high effort
// ---------------------------------------------------------------------------

test("adaptive thinking without budget omits effort instead of assuming high", async () => {
  const anthropic = new AnthropicTransformer();
  const responses = new OpenAIResponsesTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
  });
  assert.deepEqual(unified.reasoning, { enabled: true });
  const result: any = await responses.transformRequestIn!(
    structuredClone(unified),
  );
  assert.deepEqual(result.reasoning, { summary: "detailed" });
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
});

test("enabled thinking rejects a missing or sub-minimum budget locally", async () => {
  const anthropic = new AnthropicTransformer();
  for (const thinking of [
    { type: "enabled" },
    { type: "enabled", budget_tokens: 0 },
  ]) {
    await assert.rejects(
      anthropic.transformRequestOut!({
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        thinking,
      }),
      (error: any) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.type, "invalid_request_error");
        assert.match(error.message, /budget_tokens/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// F14: generated images become a short placeholder, not inline data
// ---------------------------------------------------------------------------

test("generated images never inline data URLs into text blocks", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_img",
        object: "response",
        created_at: 1,
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "here" },
              {
                type: "output_image_base64",
                image_base64: "A".repeat(50_000),
                mime_type: "image/png",
              },
            ],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, context);
  const body: any = await final.json();
  for (const block of body.content) {
    assert.equal(block.type, "text");
    assert.ok(block.text.length < 5000, "oversized text block");
    assert.doesNotMatch(block.text, /data:image/);
  }
  assert.equal(body.content[0].text, "here");
  assert.equal(body.content[1].text, "[generated image omitted]");
});

// ---------------------------------------------------------------------------
// X-Upstream-Effort-Map: explicit client-declared effort vocabulary mapping
// ---------------------------------------------------------------------------

test("X-Upstream-Effort-Map remaps explicit efforts; absent header stays exact", async () => {
  let captured: any;
  await withRouter(
    (body) => {
      captured = body;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-ok",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const payload = {
        model: "claude-test",
        max_tokens: 8,
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "hi" }],
      };
      let response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...upstreamHeaders, "x-upstream-effort-map": "max=xhigh" },
        payload,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(captured.reasoning_effort, "xhigh");

      response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(captured.reasoning_effort, "max");

      response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...upstreamHeaders, "x-upstream-effort-map": "*=off" },
        payload,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(
        Object.hasOwn(captured, "reasoning_effort"),
        false,
        "*=off must strip the effort field",
      );

      response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...upstreamHeaders, "x-upstream-effort-map": "bogus=low" },
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.type, "invalid_request_error");
    },
  );
});

// ---------------------------------------------------------------------------
// Upstream error bodies are bounded before reaching the client
// ---------------------------------------------------------------------------

test("a huge non-JSON upstream error body is truncated, not echoed whole", async () => {
  const html = `<html><body>${"x".repeat(60_000)}</body></html>`;
  await withRouter(
    () =>
      new Response(html, {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(response.statusCode, 502);
      assert.equal(response.headers["x-should-retry"], "true");
      const message = response.json().error.message;
      assert.ok(
        message.length < html.length,
        "the whole document must not be inlined",
      );
      assert.ok(message.length <= 4096 + 100);
      assert.match(
        message,
        new RegExp(`truncated, ${html.length} chars total`),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Reasoning-related upstream rejections remain single-attempt
// ---------------------------------------------------------------------------

function effortPayload(extra: Record<string, unknown> = {}) {
  return {
    model: "claude-test",
    max_tokens: 8,
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

test("a Chat rejection naming reasoning_effort is returned without mutation or retry", async () => {
  const sent: any[] = [];
  await withRouter(
    (body) => {
      sent.push(body);
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Function tools with reasoning_effort are not supported for this model",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: effortPayload(),
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.headers["x-should-retry"], "true");
      assert.match(response.json().error.message, /reasoning_effort/);
      assert.equal(sent.length, 1, "router must remain single-attempt");
      assert.equal(sent[0].reasoning_effort, "max");
    },
  );
});

test("a Responses rejection naming reasoning.effort is returned without retry", async () => {
  const sent: any[] = [];
  await withRouter(
    (body) => {
      sent.push(body);
      return new Response(
        JSON.stringify({
          error: { message: "Unsupported parameter: 'reasoning'" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...upstreamHeaders, "x-upstream-format": "responses" },
        payload: effortPayload(),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-should-retry"], "true");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].reasoning.effort, "max");
    },
  );
});

test("an unresolvable replayed reasoning item is preserved in a single request", async () => {
  const signature =
    "ocr-responses-reasoning-v1:" +
    Buffer.from(JSON.stringify({ id: "rs_1", encrypted_content: "E1" })).toString(
      "base64url",
    );
  for (const message of [
    "The encrypted content gAAA...= could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    "The requested item was created under a different Azure OpenAI resource.",
    "Item with id 'rs_1' not found.",
  ]) {
    const sent: any[] = [];
    await withRouter(
      (body) => {
        sent.push(body);
        return new Response(JSON.stringify({ error: { message } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: { ...upstreamHeaders, "x-upstream-format": "responses" },
          payload: {
            model: "claude-test",
            max_tokens: 8,
            messages: [
              { role: "user", content: "first" },
              {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "t", signature },
                  { type: "text", text: "answer" },
                ],
              },
              { role: "user", content: "second" },
            ],
          },
        });
        assert.equal(response.statusCode, 400, message);
        assert.equal(response.headers["x-should-retry"], "true", message);
        assert.equal(sent.length, 1, message);
        assert.equal(
          sent[0].input.some((i: any) => i?.type === "reasoning"),
          true,
          message,
        );
      },
    );
  }
});

test("rejections unrelated to reasoning effort never trigger a second call", async () => {
  for (const message of [
    "model not found",
    "context length exceeded",
    'diagnostic context: {"reasoning":"upstream trace omitted"}',
  ]) {
    const sent: any[] = [];
    await withRouter(
      (body) => {
        sent.push(body);
        return new Response(JSON.stringify({ error: { message } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: upstreamHeaders,
          payload: effortPayload(),
        });
        assert.equal(response.statusCode, 400, message);
        assert.equal(response.headers["x-should-retry"], "true", message);
        assert.equal(sent.length, 1, `${message}: router stays single-attempt`);
      },
    );
  }
});

test("a request without an effort never triggers a second call", async () => {
  const sent: any[] = [];
  await withRouter(
    (body) => {
      sent.push(body);
      return new Response(
        JSON.stringify({ error: { message: "reasoning_effort is bad" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(sent.length, 1);
    },
  );
});

test("a reasoning rejection preserves its original status and body in one attempt", async () => {
  const sent: any[] = [];
  await withRouter(
    (body) => {
      sent.push(body);
      return new Response(
        JSON.stringify({
          error: { message: "reasoning_effort rejected", type: "bad_request" },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: upstreamHeaders,
        payload: effortPayload(),
      });
      assert.equal(response.statusCode, 409, "original status is preserved");
      assert.equal(response.headers["x-should-retry"], "true");
      assert.match(response.json().error.message, /reasoning_effort rejected/);
      assert.equal(sent.length, 1, "router must remain single-attempt");
    },
  );
});

// ---------------------------------------------------------------------------
// Assistant turns survive a chat-alias -> responses-alias switch
// ---------------------------------------------------------------------------

test("Responses history keeps an assistant turn whose blocks are all unreplayable", async () => {
  let captured: any;
  await withRouter(
    (body) => {
      captured = body;
      return new Response(
        JSON.stringify({
          id: "resp-ok",
          object: "response",
          created_at: 1,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...upstreamHeaders, "x-upstream-format": "responses" },
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [
            { role: "user", content: "first" },
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "",
                  // A Chat-origin signature the Responses upstream cannot resolve.
                  signature: "ocr-chat-reasoning-v1:eyJhIjoxfQ",
                },
              ],
            },
            { role: "user", content: "second" },
          ],
        },
      });
      assert.equal(response.statusCode, 200);

      const roles = captured.input
        .filter((item: any) => typeof item.role === "string")
        .map((item: any) => item.role);
      assert.deepEqual(
        roles,
        ["user", "assistant", "user"],
        "the assistant turn must survive even when every block is unreplayable",
      );
      assert.equal(
        roles.join(",").includes("user,user"),
        false,
        "two consecutive user turns mean the assistant turn was erased",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP 200 carrying an error body keeps the upstream's own semantics
// ---------------------------------------------------------------------------

test("Chat HTTP 200 with an error body keeps status, retry ownership and Anthropic vocabulary", async () => {
  const anthropicTypes = new Set([
    "invalid_request_error",
    "authentication_error",
    "billing_error",
    "permission_error",
    "not_found_error",
    "conflict_error",
    "request_too_large",
    "rate_limit_error",
    "timeout_error",
    "overloaded_error",
    "api_error",
  ]);
  const cases = [
    { error: { message: "busy", type: "rate_limit_exceeded" }, status: 429, type: "rate_limit_error" },
    { error: { message: "overloaded", type: "overloaded_error" }, status: 529, type: "overloaded_error" },
    { error: { message: "bad", code: "unsupported_value" }, status: 400, type: "invalid_request_error" },
    { error: { message: "nope", type: "invalid_api_key" }, status: 401, type: "authentication_error" },
    { error: { message: "nope", type: "invalid_request_error", code: "invalid_api_key" }, status: 401, type: "authentication_error" },
    { error: { message: "pay", type: "billing_error" }, status: 402, type: "billing_error" },
    { error: { message: "who knows", type: "weird_thing" }, status: 502, type: "api_error" },
    { error: { message: "slow down", type: "rate_limit_error" }, status: 429, type: "rate_limit_error" },
  ];

  for (const { error, status, type } of cases) {
    for (const stream of [false, true]) {
      await withRouter(
        () =>
          new Response(JSON.stringify({ error }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        async (app) => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/messages",
            headers: upstreamHeaders,
            payload: {
              model: "claude-test",
              max_tokens: 8,
              stream,
              messages: [{ role: "user", content: "hi" }],
            },
          });
          const label = `${error.type ?? error.code}/stream=${stream}`;
          assert.equal(response.statusCode, status, label);
          assert.equal(response.headers["x-should-retry"], "true", label);
          const body = response.json();
          assert.equal(body.type, "error", label);
          assert.ok(
            anthropicTypes.has(body.error.type),
            `${label}: ${body.error.type} must be an Anthropic error type`,
          );
          assert.equal(body.error.type, type, label);
          assert.equal(body.error.message, error.message, label);
        },
      );
    }
  }
});

// ---------------------------------------------------------------------------
// X-Upstream-Effort-Levels: clamp to the nearest level the upstream declared
// ---------------------------------------------------------------------------

test("X-Upstream-Effort-Levels clamps to the nearest declared level", async () => {
  let captured: any;
  await withRouter(
    (body) => {
      captured = body;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-ok",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const send = async (effort: string, levels?: string, extra = {}) => {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: {
            ...upstreamHeaders,
            ...(levels ? { "x-upstream-effort-levels": levels } : {}),
            ...extra,
          },
          payload: {
            model: "claude-test",
            max_tokens: 8,
            output_config: { effort },
            messages: [{ role: "user", content: "hi" }],
          },
        });
        assert.equal(response.statusCode, 200, `${effort} via ${levels}`);
        return captured.reasoning_effort;
      };

      // A gateway that enumerates none..xhigh: max has no home and lands on the
      // adjacent xhigh, everything else is already supported and stays exact.
      const upTo = "none,low,medium,high,xhigh";
      assert.equal(await send("max", upTo), "xhigh");
      assert.equal(await send("xhigh", upTo), "xhigh");
      assert.equal(await send("high", upTo), "high");
      assert.equal(await send("low", upTo), "low");

      // A narrower gateway pulls max further down — the target follows the
      // declared range instead of a hardcoded xhigh.
      assert.equal(await send("max", "low,medium,high"), "high");
      assert.equal(await send("xhigh", "low,medium"), "medium");

      // Ties resolve downward: medium sits between low and high.
      assert.equal(await send("medium", "low,high"), "low");

      // `none` is a switch, not an intensity, so it never becomes a target.
      assert.equal(await send("max", "none"), "max");

      // Absent header keeps the router's exact passthrough.
      assert.equal(await send("max"), "max");

      // The map renames first, then the level list clamps what survived.
      assert.equal(
        await send("max", "low,medium,high", {
          "x-upstream-effort-map": "max=xhigh",
        }),
        "high",
      );

      // `off` short-circuits the clamp entirely.
      const stripped = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          ...upstreamHeaders,
          "x-upstream-effort-map": "*=off",
          "x-upstream-effort-levels": "low,medium,high",
        },
        payload: {
          model: "claude-test",
          max_tokens: 8,
          output_config: { effort: "max" },
          messages: [{ role: "user", content: "hi" }],
        },
      });
      assert.equal(stripped.statusCode, 200);
      assert.equal(Object.hasOwn(captured, "reasoning_effort"), false);

      for (const malformed of ["low,,high", "low, ,high", ","]) {
        const bad = await app.inject({
          method: "POST",
          url: "/v1/messages",
          headers: {
            ...upstreamHeaders,
            "x-upstream-effort-levels": malformed,
          },
          payload: {
            model: "claude-test",
            max_tokens: 8,
            output_config: { effort: "max" },
            messages: [{ role: "user", content: "hi" }],
          },
        });
        assert.equal(bad.statusCode, 400, malformed);
        assert.equal(bad.json().error.type, "invalid_request_error", malformed);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// P3: tool without input_schema still yields valid parameters
// ---------------------------------------------------------------------------

test("a tool without input_schema gets a default parameters object", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bare_tool", description: "no schema" }],
  });
  assert.deepEqual(unified.tools?.[0].function.parameters, {
    type: "object",
    properties: {},
  });
});

// ---------------------------------------------------------------------------
// P3: Anthropic-only sibling fields do not leak into Chat content parts
// ---------------------------------------------------------------------------

test("top-level text citations are rejected instead of silently discarded", async () => {
  const anthropic = new AnthropicTransformer();
  await assert.rejects(
    anthropic.transformRequestOut!({
      model: "claude-test",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "cited",
              citations: [{ type: "char_location" }],
            },
          ],
        },
      ],
    }),
    (error: any) =>
      error.statusCode === 400 && /citations/.test(error.message),
  );
});
