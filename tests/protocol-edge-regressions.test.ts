import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { registerMessagesRoute } from "../src/routes/messages.js";
import type { ApiError } from "../src/transformers/errors.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function parseSse(text: string): any[] {
  return text
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => !!line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

test("client-side structured-output conflicts and unsigned thinking fail with 400", async () => {
  const transformer = new AnthropicTransformer();
  const base = {
    model: "claude-test",
    max_tokens: 64,
  };

  await assert.rejects(
    transformer.transformRequestOut!({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "source",
              },
              citations: { enabled: true },
            },
          ],
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: {} },
        },
      },
    }),
    (error: ApiError) => error.statusCode === 400,
  );

  await assert.rejects(
    transformer.transformRequestOut!({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "history" }],
        },
      ],
    }),
    (error: ApiError) => error.statusCode === 400,
  );
});

test("Chat length terminals preserve partial tool bytes without tool_use", async () => {
  const transformer = new AnthropicTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseIn!(
    jsonResponse({
      id: "chat_partial_tool",
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_partial",
                type: "function",
                function: { name: "lookup", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: "length",
        },
      ],
    }),
    { req: { id: "partial-tool", body: {} } } as any,
  );
  const body: any = await converted.json();
  assert.equal(body.stop_reason, "max_tokens");
  assert.equal(body.content.some((block: any) => block.type === "tool_use"), false);
  assert.match(body.content[0].text, /lookup/);
  assert.match(body.content[0].text, /\{"q":/);
});

test("Responses rejects missing reasoning IDs and non-terminal JSON statuses", async () => {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;

  await assert.rejects(
    transformer.transformResponseOut(
      jsonResponse({
        id: "resp_missing_reasoning_id",
        object: "response",
        model: "m",
        status: "completed",
        output: [
          {
            type: "reasoning",
            encrypted_content: "opaque",
            summary: [],
          },
        ],
      }),
      { thinkingDisplay: "omitted" },
    ),
    (error: ApiError) => error.statusCode === 502,
  );

  for (const status of ["queued", "in_progress", "future_status"]) {
    const converted = await transformer.transformResponseOut(
      jsonResponse({
        id: `resp_${status}`,
        object: "response",
        model: "m",
        status,
        output: [],
      }),
    );
    assert.equal(converted.status, 502, status);
  }

  const cancelled = await transformer.transformResponseOut(
    jsonResponse({
      id: "resp_cancelled",
      object: "response",
      model: "m",
      status: "cancelled",
      output: [],
    }),
  );
  assert.equal(cancelled.status, 409);
});

test("Responses terminal SSE requires a matching response object and status", async () => {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;

  const missing = await transformer.transformResponseOut(
    sse([{ type: "response.completed" }]),
  );
  const missingEvents = parseSse(await missing.text());
  assert.equal(missingEvents[0].error.status, 502);

  const failed = await transformer.transformResponseOut(
    sse([
      {
        type: "response.completed",
        response: {
          id: "resp_failed_in_completed",
          model: "m",
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "slow down" },
          output: [],
        },
      },
    ]),
  );
  const failedEvents = parseSse(await failed.text());
  assert.equal(failedEvents[0].error.status, 429);
  assert.equal(failedEvents[0].error.type, "rate_limit_error");

  const mismatch = await transformer.transformResponseOut(
    sse([
      {
        type: "response.completed",
        response: {
          id: "resp_mismatch",
          model: "m",
          status: "incomplete",
          output: [],
        },
      },
    ]),
  );
  assert.equal(parseSse(await mismatch.text())[0].error.status, 502);
});

test("full Responses items followed by deltas are not duplicated", async () => {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const item = {
    id: "msg_full_then_delta",
    type: "message",
    content: [
      { type: "output_text", text: "ANSWER" },
      { type: "refusal", refusal: "NO" },
    ],
  };
  const converted = await transformer.transformResponseOut(
    sse([
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "ANSWER",
      },
      {
        type: "response.refusal.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 1,
        delta: "NO",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_full_then_delta",
          model: "m",
          status: "completed",
          output: [item],
        },
      },
    ]),
  );
  const chunks = parseSse(await converted.text());
  assert.deepEqual(
    chunks.flatMap((chunk) => {
      const delta = chunk.choices?.[0]?.delta;
      return [delta?.content, delta?.refusal].filter(Boolean);
    }),
    ["ANSWER", "NO"],
  );
});

test("multiple deltas for one Responses content part are all preserved", async () => {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseOut(
    sse([
      {
        type: "response.output_text.delta",
        item_id: "msg_multi_delta",
        output_index: 0,
        content_index: 0,
        delta: "hel",
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_multi_delta",
        output_index: 0,
        content_index: 0,
        delta: "lo",
      },
      {
        type: "response.refusal.delta",
        item_id: "msg_multi_delta",
        output_index: 0,
        content_index: 1,
        delta: "no",
      },
      {
        type: "response.refusal.delta",
        item_id: "msg_multi_delta",
        output_index: 0,
        content_index: 1,
        delta: "pe",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_multi_delta",
          model: "m",
          status: "completed",
          output: [],
        },
      },
    ]),
  );
  const chunks = parseSse(await converted.text());
  assert.deepEqual(
    chunks.flatMap((chunk) => {
      const delta = chunk.choices?.[0]?.delta;
      return [delta?.content, delta?.refusal].filter(Boolean);
    }),
    ["hel", "lo", "no", "pe"],
  );
});

test("a later length terminal cannot leave an already-emitted tool_use", async () => {
  const transformer = new AnthropicTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseIn!(
    sse([
      {
        id: "chat_interleaved_partial",
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_dangerous",
                  type: "function",
                  function: {
                    name: "dangerous_action",
                    arguments: '{"ok":true}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat_interleaved_partial",
        model: "m",
        choices: [
          { index: 0, delta: { content: "after" }, finish_reason: null },
        ],
      },
      {
        id: "chat_interleaved_partial",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
    ]),
    { req: { id: "interleaved-partial", body: {} } } as any,
  );
  const events = parseSse(await converted.text());
  assert.equal(
    events.some((event) => event.content_block?.type === "tool_use"),
    false,
  );
  const text = events
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");
  assert.match(text, /dangerous_action/);
  assert.match(text, /after/);
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "max_tokens",
  );
});

test("Responses function added bytes are combined and bare skeletons match by index", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;

  const validChat = await responses.transformResponseOut(
    sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_initial_args",
          call_id: "call_initial_args",
          type: "function_call",
          name: "lookup",
          arguments: '{"a":',
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_initial_args",
        output_index: 0,
        delta: "1}",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_initial_args",
          model: "m",
          status: "completed",
          output: [
            {
              id: "fc_initial_args",
              call_id: "call_initial_args",
              type: "function_call",
              name: "lookup",
              arguments: '{"a":1}',
            },
          ],
        },
      },
    ]),
  );
  const valid = await anthropic.transformResponseIn!(validChat, {
    req: { id: "initial-args", body: {} },
  } as any);
  const validEvents = parseSse(await valid.text());
  assert.deepEqual(
    JSON.parse(
      validEvents.find((event) => event.delta?.type === "input_json_delta")
        ?.delta.partial_json,
    ),
    { a: 1 },
  );

  const malformed = await responses.transformResponseOut(
    sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_first",
          call_id: "call_first",
          type: "function_call",
          name: "first",
          arguments: "{}",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_parallel_skeleton",
          model: "m",
          status: "completed",
          output: [
            {
              id: "fc_first",
              call_id: "call_first",
              type: "function_call",
              name: "first",
              arguments: "{}",
            },
            { type: "function_call" },
          ],
        },
      },
    ]),
  );
  assert.equal(
    parseSse(await malformed.text()).some((chunk) => chunk.error?.status === 502),
    true,
  );
});

test("multiple web searches and citations degrade identically without guessed ownership", async () => {
  const output = [
    {
      id: "search_one",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "one" },
    },
    {
      id: "msg_one",
      type: "message",
      content: [
        {
          type: "output_text",
          text: "first",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/one",
              title: "one",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    },
    {
      id: "search_two",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "two" },
    },
    {
      id: "msg_two",
      type: "message",
      content: [
        {
          type: "output_text",
          text: "second",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/two",
              title: "two",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
    },
  ];
  const payload = {
    id: "resp_two_searches",
    object: "response",
    model: "m",
    status: "completed",
    output,
  };
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;

  const jsonChat = await responses.transformResponseOut(jsonResponse(payload));
  const jsonAnthropic = await anthropic.transformResponseIn!(jsonChat, {
    req: { id: "two-search-json", body: {} },
  } as any);
  const jsonBody: any = await jsonAnthropic.json();
  const jsonText = jsonBody.content.map((block: any) => block.text || "").join("");

  const streamChat = await responses.transformResponseOut(
    sse([{ type: "response.completed", response: payload }]),
  );
  const streamAnthropic = await anthropic.transformResponseIn!(streamChat, {
    req: { id: "two-search-stream", body: {} },
  } as any);
  const streamEvents = parseSse(await streamAnthropic.text());
  const streamText = streamEvents
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");

  for (const marker of [
    "search_one",
    "search_two",
    "https://example.com/one",
    "https://example.com/two",
    "start_index",
    "end_index",
  ]) {
    assert.match(jsonText, new RegExp(marker));
    assert.match(streamText, new RegExp(marker));
  }
  assert.equal(
    jsonBody.content.some((block: any) => block.type === "server_tool_use"),
    false,
  );
  assert.equal(
    streamEvents.some(
      (event) => event.content_block?.type === "server_tool_use",
    ),
    false,
  );
});

test("Responses stream waits for the terminal web-search payload", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const completedSearch = {
    id: "search_final",
    type: "web_search_call",
    status: "completed",
    action: {
      type: "search",
      query: "final query",
      sources: [{ url: "https://example.com/final" }],
    },
  };
  const nonStream: any = await (
    await responses.transformResponseOut(
      jsonResponse({
        id: "resp_search_final",
        object: "response",
        model: "m",
        status: "completed",
        output: [completedSearch],
      }),
    )
  ).json();
  const stream = await responses.transformResponseOut(
    sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "search_final",
          type: "web_search_call",
          status: "in_progress",
          action: { type: "search", query: "final query" },
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_search_final",
          model: "m",
          status: "completed",
          output: [completedSearch],
        },
      },
    ]),
  );
  const streamText = parseSse(await stream.text())
    .map((chunk) => chunk.choices?.[0]?.delta?.content || "")
    .join("");
  assert.equal(streamText, nonStream.choices[0].message.content);
  assert.match(streamText, /completed/);
  assert.match(streamText, /example\.com\/final/);
  assert.doesNotMatch(streamText, /"status":"in_progress"/);
});

test("Responses citation fallback preserves text order and duplicate positions", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const citation = {
    type: "url_citation",
    url: "https://example.com/repeated",
    title: "same",
    start_index: 0,
    end_index: 6,
  };
  const message = {
    id: "msg_repeated_citation",
    type: "message",
    content: [
      {
        type: "output_text",
        text: "answer",
        annotations: [citation, citation],
      },
    ],
  };
  const nonStream: any = await (
    await responses.transformResponseOut(
      jsonResponse({
        id: "resp_repeated_citation",
        object: "response",
        model: "m",
        status: "completed",
        output: [message],
      }),
    )
  ).json();
  const stream = await responses.transformResponseOut(
    sse([
      {
        type: "response.completed",
        response: {
          id: "resp_repeated_citation",
          model: "m",
          status: "completed",
          output: [message],
        },
      },
    ]),
  );
  const streamText = parseSse(await stream.text())
    .map((chunk) => chunk.choices?.[0]?.delta?.content || "")
    .join("");
  const nonStreamText = nonStream.choices[0].message.content;
  assert.equal(streamText, nonStreamText);
  assert.equal(streamText.startsWith("answer"), true);
  assert.equal(streamText.match(/citation annotation/g)?.length, 2);
});

test("Responses generated-image message parts never expose payload bytes", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const secretBytes = "SECRET_IMAGE_BYTES_MUST_NOT_APPEAR";
  const message = {
    id: "msg_output_image",
    type: "message",
    content: [{ type: "output_image_base64", b64_json: secretBytes }],
  };
  const nonStream: any = await (
    await responses.transformResponseOut(
      jsonResponse({
        id: "resp_output_image",
        object: "response",
        model: "m",
        status: "completed",
        output: [message],
      }),
    )
  ).json();
  const stream = await responses.transformResponseOut(
    sse([
      {
        type: "response.completed",
        response: {
          id: "resp_output_image",
          model: "m",
          status: "completed",
          output: [message],
        },
      },
    ]),
  );
  const streamText = parseSse(await stream.text())
    .map((chunk) => chunk.choices?.[0]?.delta?.content || "")
    .join("");
  assert.equal(nonStream.choices[0].message.content, "[generated image omitted]");
  assert.equal(streamText, "[generated image omitted]");
  assert.doesNotMatch(streamText, new RegExp(secretBytes));
});

test("Responses terminal output must match every streamed function identity", async () => {
  for (const terminalOutput of [
    [
      {
        id: "fc_other",
        call_id: "call_other",
        type: "function_call",
        name: "other",
        arguments: "{}",
      },
    ],
    [],
    [
      {
        id: "fc_original",
        call_id: "call_original",
        type: "function_call",
        name: "original",
        arguments: "{",
      },
    ],
  ]) {
    const responses = new OpenAIResponsesTransformer();
    responses.logger = logger;
    const anthropic = new AnthropicTransformer();
    anthropic.logger = logger;
    const chat = await responses.transformResponseOut(
      sse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_original",
            call_id: "call_original",
            type: "function_call",
            name: "original",
            arguments: "{}",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_function_identity",
            model: "m",
            status: "completed",
            output: terminalOutput,
          },
        },
      ]),
    );
    const converted = await anthropic.transformResponseIn!(chat, {
      req: { id: "function-identity", body: {} },
    } as any);
    const events = parseSse(await converted.text());
    assert.equal(
      events.some((event) => event.content_block?.type === "tool_use"),
      false,
    );
    assert.equal(events.some((event) => event.type === "error"), true);
    assert.equal(events.some((event) => event.type === "message_stop"), false);
  }
});

test("Responses SSE logical failures preserve status and retryability for stream:false", async () => {
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sse([
      {
        type: "response.failed",
        response: {
          id: "resp_rate_limited",
          model: "m",
          error: { code: "rate_limit_exceeded", message: "slow down" },
        },
      },
    ])) as typeof fetch;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const apiError = error as ApiError;
    reply.code(apiError.statusCode ?? 500).send({
      type: "error",
      error: { type: apiError.type ?? "api_error", message: error.message },
    });
  });
  await registerMessagesRoute(app);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-upstream-url": "https://upstream.example.com/v1/responses",
        "x-upstream-authorization": "Bearer placeholder",
        "x-upstream-format": "responses",
      },
      payload: {
        model: "claude-test",
        max_tokens: 32,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers["x-should-retry"], "true");
    assert.equal(response.json().error.type, "rate_limit_error");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
    else process.env.OCR_ACCESS_TOKENS = previousTokens;
  }
});
