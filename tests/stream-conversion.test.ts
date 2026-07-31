import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

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

function decodeReasoningSignature(signature: string) {
  const prefix = "ocr-responses-reasoning-v1:";
  assert.ok(signature.startsWith(prefix));
  return JSON.parse(
    Buffer.from(signature.slice(prefix.length), "base64url").toString("utf8"),
  );
}

async function toAnthropicStream(response: Response): Promise<any[]> {
  const transformer = new AnthropicTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseIn!(response, {
    req: { id: "test" },
  } as any);
  return parseAnthropicSse(await converted.text());
}

test("parallel Chat tool deltas become sequential valid Anthropic blocks", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-1",
        model: "vision-test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "first", arguments: '{"a":' },
                },
                {
                  index: 1,
                  id: "call_2",
                  type: "function",
                  function: { name: "second", arguments: '{"b":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        model: "vision-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: "2}" } },
                { index: 0, function: { arguments: "1}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        model: "vision-test",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
      },
    ]),
  );

  const blockEvents = events.filter((event) =>
    event.type.startsWith("content_block_"),
  );
  const starts = blockEvents.filter(
    (event) => event.type === "content_block_start",
  );
  assert.deepEqual(
    starts.map((event) => [
      event.index,
      event.content_block.id,
      event.content_block.name,
    ]),
    [
      [0, "call_1", "first"],
      [1, "call_2", "second"],
    ],
  );

  for (const start of starts) {
    const related = blockEvents.filter((event) => event.index === start.index);
    assert.deepEqual(
      related.map((event) => event.type),
      [
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
      ],
    );
  }
  assert.deepEqual(
    blockEvents
      .filter((event) => event.type === "content_block_delta")
      .map((event) => event.delta.partial_json),
    ['{"a":1}', '{"b":2}'],
  );
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "tool_use",
  );
});

test("Chat stream errors use Anthropic error envelope and do not emit success", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-error",
        model: "test",
        error: { message: "upstream exploded" },
        choices: [],
      },
    ]),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.type, "api_error");
  assert.match(events[0].error.message, /upstream exploded/);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("empty upstream stream is an error, not a synthetic end_turn", async () => {
  const events = await toAnthropicStream(
    new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.message, /without response events/);
});

test("truncated Chat stream does not fabricate a successful terminal", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-truncated",
        model: "test",
        choices: [
          {
            index: 0,
            delta: { content: "partial" },
            finish_reason: null,
          },
        ],
      },
    ]),
  );
  assert.equal(events.at(-1)?.type, "error");
  assert.match(events.at(-1)?.error.message, /before a terminal event/);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("coalesced Chat finish and usage-only chunks retain final usage", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-usage",
        model: "test",
        choices: [
          {
            index: 0,
            delta: { content: "done" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-usage",
        model: "test",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
        ],
      },
      {
        id: "chatcmpl-usage",
        model: "test",
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 4,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    ]),
  );
  assert.deepEqual(
    events.find((event) => event.type === "message_delta")?.usage,
    {
      input_tokens: 8,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
    },
  );
});

test("Responses stream preserves model, usage, and encrypted reasoning signature", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const upstream = sse([
    {
      type: "response.created",
      response: {
        id: "resp_1",
        model: "gpt-test",
        created_at: 123,
      },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      delta: "considering",
    },
    {
      type: "response.output_item.done",
      item_id: "rs_1",
      item: {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "encrypted-reasoning-state",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      delta: "done",
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-test",
        output: [{ type: "message" }],
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
    },
  ]);
  const chatStream = await responses.transformResponseOut(upstream);
  const events = await toAnthropicStream(chatStream);

  assert.equal(
    events.find((event) => event.type === "message_start")?.message.model,
    "gpt-test",
  );
  assert.deepEqual(
    decodeReasoningSignature(
      events.find(
        (event) => event.delta?.type === "signature_delta",
      )?.delta.signature,
    ),
    {
      id: "rs_1",
      encrypted_content: "encrypted-reasoning-state",
    },
  );
  const terminal = events.find((event) => event.type === "message_delta");
  assert.deepEqual(terminal.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
  });
});

test("Responses stream failures do not turn into end_turn", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const chatStream = await responses.transformResponseOut(
    sse([
      {
        type: "response.failed",
        response: {
          id: "resp_failed",
          model: "gpt-test",
          error: { code: "server_error", message: "failed" },
        },
      },
    ]),
  );
  const events = await toAnthropicStream(chatStream);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("Responses incomplete content_filter does not become max_tokens", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const chatStream = await responses.transformResponseOut(
    sse([
      {
        type: "response.created",
        response: { id: "resp_filtered", model: "gpt-test" },
      },
      {
        type: "response.incomplete",
        response: {
          id: "resp_filtered",
          model: "gpt-test",
          incomplete_details: { reason: "content_filter" },
          output: [],
        },
      },
    ]),
  );
  const events = await toAnthropicStream(chatStream);
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "refusal",
  );
});

test("signature-only Responses reasoning remains replayable", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const chatStream = await responses.transformResponseOut(
    sse([
      {
        type: "response.created",
        response: { id: "resp_sig", model: "gpt-test" },
      },
      {
        type: "response.output_item.done",
        item_id: "rs_1",
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "fallback summary" }],
          encrypted_content: "encrypted-only",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_sig",
          model: "gpt-test",
          output: [{ type: "reasoning" }],
        },
      },
    ]),
  );
  const events = await toAnthropicStream(chatStream);
  assert.equal(
    events.find((event) => event.delta?.type === "thinking_delta")?.delta
      .thinking,
    "fallback summary",
  );
  assert.deepEqual(
    decodeReasoningSignature(
      events.find((event) => event.delta?.type === "signature_delta")?.delta
        .signature,
    ),
    { id: "rs_1", encrypted_content: "encrypted-only" },
  );
});

test("Responses done-only text with no-space SSE data is preserved", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const upstream = new Response(
    [
      `data:${JSON.stringify({
        type: "response.created",
        response: { id: "resp_done", model: "gpt-test" },
      })}`,
      "",
      `data:${JSON.stringify({
        type: "response.output_text.done",
        item_id: "msg_1",
        text: "done-only text",
      })}`,
      "",
      `data:${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_done",
          model: "gpt-test",
          output: [{ type: "message" }],
        },
      })}`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/event-stream" } },
  );
  const events = await toAnthropicStream(
    await responses.transformResponseOut(upstream),
  );
  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "done-only text",
  );
});

test("Responses refusal text is preserved as conservative assistant text", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const events = await toAnthropicStream(
    await responses.transformResponseOut(
      sse([
        {
          type: "response.created",
          response: { id: "resp_refusal", model: "gpt-test" },
        },
        {
          type: "response.refusal.done",
          item_id: "msg_1",
          refusal: "I cannot help with that.",
        },
        {
          type: "response.completed",
          response: {
            id: "resp_refusal",
            model: "gpt-test",
            output: [{ type: "message" }],
          },
        },
      ]),
    ),
  );
  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "I cannot help with that.",
  );
});

test("Responses done-only function arguments are preserved", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const events = await toAnthropicStream(
    await responses.transformResponseOut(
      sse([
        {
          type: "response.created",
          response: { id: "resp_tool", model: "gpt-test" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "read",
          },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: '{"path":"a"}',
        },
        {
          type: "response.completed",
          response: {
            id: "resp_tool",
            model: "gpt-test",
            output: [{ type: "function_call" }],
          },
        },
      ]),
    ),
  );
  assert.equal(
    events.find((event) => event.delta?.type === "input_json_delta")?.delta
      .partial_json,
    '{"path":"a"}',
  );
});

test("non-stream Responses preserves reasoning item and cached usage", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        created_at: 123,
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "considering" }],
            encrypted_content: "encrypted-reasoning-state",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 3 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, {
    req: { id: "test" },
  } as any);
  const body: any = await final.json();
  assert.equal(body.content[0].type, "thinking");
  assert.equal(body.content[0].thinking, "considering");
  assert.deepEqual(decodeReasoningSignature(body.content[0].signature), {
    id: "rs_1",
    encrypted_content: "encrypted-reasoning-state",
  });
  assert.deepEqual(body.usage, {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  });
});

test("non-stream signature-only reasoning is not dropped", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_sig",
        object: "response",
        created_at: 123,
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-only",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, {
    req: { id: "test" },
  } as any);
  const body: any = await final.json();
  assert.equal(body.content[0].type, "thinking");
  assert.equal(body.content[0].thinking, "");
  assert.deepEqual(decodeReasoningSignature(body.content[0].signature), {
    id: "rs_1",
    encrypted_content: "encrypted-only",
  });
});

test("non-stream Responses refusal text is not dropped", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_refusal",
        object: "response",
        created_at: 123,
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "refusal", refusal: "I cannot help with that." },
            ],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, {
    req: { id: "test" },
  } as any);
  assert.equal((await final.json() as any).content[0].text, "I cannot help with that.");
});

test("non-stream failed Responses object becomes an Anthropic error", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp_failed",
        object: "response",
        model: "gpt-test",
        status: "failed",
        error: { code: "server_error", message: "generation failed" },
        output: [],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const final = await anthropic.transformResponseIn!(chat, {
    req: { id: "test" },
  } as any);
  assert.equal(final.status, 500);
  assert.deepEqual(await final.json(), {
    type: "error",
    request_id: null,
    error: { type: "api_error", message: "generation failed" },
  });
});
