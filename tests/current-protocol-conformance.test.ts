import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import {
  buildAnthropicErrorFromUpstream,
  mapUpstreamStatusToAnthropicErrorType,
} from "../src/utils/upstream.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};
const context = { req: { id: "current-protocol-test" } } as any;

function responsesPayload(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "resp_test",
    object: "response",
    model: "gpt-test",
    created_at: 1,
    status: "completed",
    output,
    ...extra,
  };
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

async function responsesJsonToChat(payload: unknown): Promise<any> {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseOut(
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    }),
  );
  return converted.json();
}

async function responsesStreamToChat(events: unknown[]): Promise<any[]> {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseOut(sse(events));
  return parseSse(await converted.text());
}

test("document/search_result and error tool results preserve formal content", async () => {
  const anthropic = new AnthropicTransformer();
  const longText = "document bytes ".repeat(600);
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    output_config: { format: null, effort: null },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            title: "inline",
            context: "trusted context",
            source: { type: "content", content: longText },
          },
          {
            type: "search_result",
            title: "result title",
            source: "https://example.com/source",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "tool_use", id: "call_2", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          is_error: true,
          content: [
            { type: "text", text: "failed" },
            {
              type: "document",
              title: "nested",
              source: {
                type: "content",
                content: [
                  { type: "text", text: "nested text" },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "AA==",
                    },
                  },
                ],
              },
            },
          ],
        }, {
          type: "tool_result",
          tool_use_id: "call_2",
          content: [{
            type: "search_result",
            title: "nested result",
            source: "urn:test",
            content: [{ type: "text", text: "nested search text" }],
          }],
        }],
      },
    ],
  });

  const top = unified.messages[0].content as any[];
  assert.deepEqual(top.slice(0, 2), [
    {
      type: "text",
      text:
        '[open-claude-router document metadata: {"title":"inline","context":"trusted context"}]',
    },
    { type: "text", text: longText },
  ]);
  assert.equal(top[1].text.length, longText.length);
  assert.deepEqual(top.slice(2), [
    {
      type: "text",
      text:
        '[open-claude-router search_result metadata: {"title":"result title","source":"https://example.com/source"}]',
    },
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);

  const result = unified.messages[2].content as any[];
  assert.equal(
    result[0].text,
    '[open-claude-router tool_result metadata: {"is_error":true}]',
  );
  assert.equal(result[1].text, "failed");
  assert.match(result[2].text, /document metadata/);
  assert.equal(result[3].text, "nested text");
  assert.deepEqual(result[4], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AA==" },
  });
  const searchResult = unified.messages[3].content as any[];
  assert.match(searchResult[0].text, /search_result metadata/);
  assert.equal(searchResult[1].text, "nested search text");
});

test("citations and provider-owned file ids fail locally with conflict priority", async () => {
  const anthropic = new AnthropicTransformer();
  const citedDocument = {
    type: "document",
    source: { type: "text", data: "source" },
    citations: { enabled: true },
  };
  await assert.rejects(
    anthropic.transformRequestOut!({
      model: "claude-test",
      messages: [{ role: "user", content: [citedDocument] }],
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
    }),
    (error: any) =>
      error.statusCode === 400 && /cannot be combined/.test(error.message),
  );
  const nullableCitations = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{
      role: "user",
      content: [{
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "source" },
        citations: null,
      }],
    }],
  });
  assert.equal(nullableCitations.messages[0].role, "user");

  for (const content of [
    [{ type: "text", text: "cited", citations: [{ type: "char_location" }] }],
    [{
      type: "document",
      source: {
        type: "content",
        content: [{
          type: "text",
          text: "cited document text",
          citations: [{ type: "content_block_location" }],
        }],
      },
    }],
    [{
      type: "search_result",
      title: "result",
      source: "urn:test",
      content: [{
        type: "text",
        text: "cited search text",
        citations: [{ type: "search_result_location" }],
      }],
    }],
  ]) {
    await assert.rejects(
      anthropic.transformRequestOut!({
        model: "claude-test",
        messages: [{ role: "user", content }],
      }),
      (error: any) =>
        error.statusCode === 400 && /citations/.test(error.message),
    );
  }
  await assert.rejects(
    anthropic.transformRequestOut!({
      model: "claude-test",
      messages: [{ role: "user", content: [citedDocument] }],
    }),
    (error: any) =>
      error.statusCode === 400 && /no OpenAI protocol equivalent/.test(error.message),
  );
  for (const content of [
    [{
      type: "search_result",
      title: "empty",
      source: "urn:test",
      content: [{ type: "text", text: "" }],
    }],
    [
      {
        type: "search_result",
        title: "result",
        source: "urn:test",
        content: [{ type: "text", text: "result" }],
      },
      { type: "text", text: "mixed" },
    ],
  ]) {
    await assert.rejects(
      anthropic.transformRequestOut!({
        model: "claude-test",
        messages: [
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "call_search",
              name: "search",
              input: {},
            }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call_search",
              content,
            }],
          },
        ],
      }),
      (error: any) => error.statusCode === 400,
    );
  }
  for (const block of [
    { type: "image", source: { type: "file", file_id: "file_a" } },
    { type: "document", source: { type: "file", file_id: "file_b" } },
  ]) {
    await assert.rejects(
      anthropic.transformRequestOut!({
        model: "claude-test",
        messages: [{ role: "user", content: [block] }],
      }),
      (error: any) =>
        error.statusCode === 400 && /provider-owned/.test(error.message),
    );
  }
});

test("opaque Anthropic container state is rejected while null is a no-op", async () => {
  const anthropic = new AnthropicTransformer();
  await assert.rejects(
    anthropic.transformRequestOut!({
      model: "claude-test",
      container: "container_provider_owned",
      messages: [{ role: "user", content: "hello" }],
    }),
    (error: any) =>
      error.statusCode === 400 && /container state/.test(error.message),
  );
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    container: null,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(unified.messages[0].content, "hello");
});

test("future source kinds degrade visibly while known malformed kinds fail", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "future_image_source", token: "opaque-image" },
        },
        {
          type: "document",
          source: { type: "future_document_source", token: "opaque-doc" },
        },
        {
          type: "document",
          source: {
            type: "content",
            content: [
              { type: "future_document_part", value: "opaque-part" },
              {
                type: "image",
                source: {
                  type: "future_nested_image_source",
                  token: "opaque-nested-image",
                },
              },
            ],
          },
        },
      ],
    }],
  });
  const content = unified.messages[0].content as any[];
  assert.match(content[0].text, /future_image_source/);
  assert.match(content[1].text, /future_document_source/);
  assert.match(content[2].text, /document metadata/);
  assert.match(content[3].text, /future_document_part/);
  assert.match(content[4].text, /future_nested_image_source/);
  assert.equal(content.includes(null), false);

  for (const block of [
    { type: "image", source: { type: "base64", data: "AA==" } },
    { type: "document", source: { type: "url", url: "" } },
  ]) {
    await assert.rejects(
      anthropic.transformRequestOut!({
        model: "claude-test",
        messages: [{ role: "user", content: [block] }],
      }),
      (error: any) => error.statusCode === 400,
    );
  }
});

test("tool_result is_error false/absent stay unchanged and true is explicit", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "a", input: {} },
          { type: "tool_use", id: "call_2", name: "b", input: {} },
          { type: "tool_use", id: "call_3", name: "c", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "plain" },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            is_error: false,
            content: "also plain",
          },
          {
            type: "tool_result",
            tool_use_id: "call_3",
            is_error: true,
            content: "failure",
          },
        ],
      },
    ],
  });
  assert.equal(unified.messages[1].content, "plain");
  assert.equal(unified.messages[2].content, "also plain");
  assert.deepEqual(unified.messages[3].content, [
    {
      type: "text",
      text: '[open-claude-router tool_result metadata: {"is_error":true}]',
    },
    { type: "text", text: "failure" },
  ]);
});

test("current Message and Usage nullable fields preserve reasoning token usage", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(JSON.stringify({
      id: "chatcmpl-current",
      model: "gpt-test",
      service_tier: "fast",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    }), { headers: { "content-type": "application/json" } }),
    context,
  );
  const message: any = await converted.json();
  assert.equal(message.container, null);
  assert.deepEqual(message.usage, {
    cache_creation: null,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    inference_geo: null,
    input_tokens: 15,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 5 },
    server_tool_use: null,
    service_tier: "priority",
  });
});

test("Responses usage carries reasoning tokens into Anthropic JSON and SSE", async () => {
  const response = responsesPayload(
    [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "ok" }] }],
    {
      service_tier: "default",
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  );
  const chat = await responsesJsonToChat(response);
  assert.deepEqual(chat.usage.completion_tokens_details, {
    reasoning_tokens: 2,
  });

  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(JSON.stringify(chat), {
      headers: { "content-type": "application/json" },
    }),
    context,
  );
  const anthropicMessage: any = await converted.json();
  assert.deepEqual(anthropicMessage.usage.output_tokens_details, {
    thinking_tokens: 2,
  });
  assert.equal(anthropicMessage.usage.service_tier, "standard");

  const stream = await responsesStreamToChat([
    {
      type: "response.created",
      response: {
        id: "resp_stream",
        model: "gpt-test",
        created_at: 1,
        service_tier: "default",
      },
    },
    { type: "response.completed", response },
  ]);
  assert.equal(stream[0]?.service_tier, "default");
  assert.deepEqual(stream.at(-1)?.usage?.completion_tokens_details, {
    reasoning_tokens: 2,
  });

  const streamAsChatSse = new Response(
    stream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
  const anthropicStream = await anthropic.transformResponseIn!(
    streamAsChatSse,
    context,
  );
  const anthropicEvents = parseSse(await anthropicStream.text());
  assert.equal(
    anthropicEvents.find((event) => event.type === "message_start")?.message
      ?.usage?.service_tier,
    "standard",
  );
});

test("Responses empty added snapshots do not suppress later deltas", async () => {
  const chunks = await responsesStreamToChat([
    {
      type: "response.created",
      response: {
        id: "resp_empty_added",
        model: "gpt-test",
        created_at: 1,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_empty_added",
        content: [
          { type: "output_text", text: "" },
          { type: "refusal", refusal: "" },
        ],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_empty_added",
      output_index: 0,
      content_index: 0,
      delta: "visible text",
    },
    {
      type: "response.refusal.delta",
      item_id: "msg_empty_added",
      output_index: 0,
      content_index: 1,
      delta: "visible refusal",
    },
    {
      type: "response.completed",
      response: responsesPayload([{
        type: "message",
        id: "msg_empty_added",
        content: [
          { type: "output_text", text: "visible text" },
          { type: "refusal", refusal: "visible refusal" },
        ],
      }]),
    },
  ]);
  const visible = chunks
    .flatMap((chunk) => [
      chunk.choices?.[0]?.delta?.content,
      chunk.choices?.[0]?.delta?.refusal,
    ])
    .filter((value): value is string => typeof value === "string")
    .join("|");
  assert.equal(visible, "visible text|visible refusal");
});

test("Chat stream emits current Message and MessageDeltaUsage schemas", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    sse([
      {
        id: "chatcmpl-stream-shape",
        model: "gpt-test",
        service_tier: "priority",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-stream-shape",
        model: "gpt-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    ]),
    context,
  );
  const events = parseSse(await converted.text());
  const start = events.find((event) => event.type === "message_start");
  assert.equal(start.message.container, null);
  assert.equal(start.message.usage.service_tier, "priority");
  assert.deepEqual(Object.keys(start.message.usage).sort(), [
    "cache_creation",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "inference_geo",
    "input_tokens",
    "output_tokens",
    "output_tokens_details",
    "server_tool_use",
    "service_tier",
  ]);
  const delta = events.find((event) => event.type === "message_delta");
  assert.equal(delta.delta.container, null);
  assert.deepEqual(delta.usage, {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 3,
    output_tokens: 2,
    output_tokens_details: { thinking_tokens: 1 },
    server_tool_use: null,
  });
});

test("Responses rejects opaque response state and permits only direct callers", async () => {
  const direct = await responsesJsonToChat(responsesPayload([{
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: "{}",
    caller: { type: "direct" },
  }]));
  assert.equal(direct.choices[0].message.tool_calls[0].id, "call_1");

  const unsupported = [
    { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
    { type: "function_call_output", id: "out_1", call_id: "call_1", output: "x" },
    {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "lookup",
      arguments: "{}",
      caller: { type: "future_caller" },
    },
  ];
  for (const item of unsupported) {
    await assert.rejects(
      () => responsesJsonToChat(responsesPayload([item])),
      (error: any) => error.statusCode === 502,
    );
    for (const events of [
      [{ type: "response.output_item.added", output_index: 0, item }],
      [{ type: "response.output_item.done", output_index: 0, item }],
      [{ type: "response.completed", response: responsesPayload([item]) }],
    ]) {
      const chunks = await responsesStreamToChat(events);
      assert.equal(chunks.at(-1)?.error?.status, 502);
      assert.doesNotMatch(
        JSON.stringify(chunks),
        /unsupported Responses output item/,
      );
    }
  }
});

test("Chat JSON and Responses SSE expose transcripts without audio bytes", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(JSON.stringify({
      id: "chatcmpl-audio",
      model: "gpt-audio",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "spoken text",
          audio: {
            transcript: "spoken text",
            data: "BASE64_AUDIO_MUST_NOT_LEAK",
          },
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { "content-type": "application/json" } }),
    context,
  );
  const message: any = await converted.json();
  assert.deepEqual(message.content, [
    { type: "text", text: "spoken text" },
    { type: "text", text: "[generated audio omitted]" },
  ]);
  assert.doesNotMatch(JSON.stringify(message), /BASE64_AUDIO/);

  const response = responsesPayload([]);
  const chunks = await responsesStreamToChat([
    { type: "response.created", response: { id: "resp_audio", model: "gpt-audio", created_at: 1 } },
    { type: "response.audio.transcript.delta", delta: "spoken " },
    { type: "response.audio.transcript.delta", delta: "stream" },
    { type: "response.audio.delta", delta: "BASE64_A" },
    { type: "response.audio.delta", delta: "BASE64_B" },
    { type: "response.audio.transcript.done", transcript: "spoken stream" },
    { type: "response.audio.done" },
    { type: "response.completed", response },
  ]);
  const visible = chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((value): value is string => typeof value === "string")
    .join("");
  assert.equal(visible, "spoken stream[generated audio omitted]");
  assert.doesNotMatch(JSON.stringify(chunks), /BASE64_[AB]/);
});

test("Chat citation fallback follows the annotated text in JSON and SSE", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const annotation = {
    type: "url_citation",
    url_citation: {
      start_index: 0,
      end_index: 6,
      title: "source",
      url: "https://example.com/source",
    },
  };
  const jsonResponse = await anthropic.transformResponseIn!(
    new Response(JSON.stringify({
      id: "chatcmpl-citation-json",
      model: "gpt-test",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          annotations: [annotation],
        },
        finish_reason: "stop",
      }],
    }), { headers: { "content-type": "application/json" } }),
    context,
  );
  const jsonMessage: any = await jsonResponse.json();
  assert.equal(jsonMessage.content[0].text, "answer");
  assert.match(jsonMessage.content[1].text, /openai_url_citations/);

  const streamResponse = await anthropic.transformResponseIn!(
    sse([
      {
        id: "chatcmpl-citation-stream",
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { content: "answer", annotations: [annotation] },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-citation-stream",
        model: "gpt-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
    context,
  );
  const streamTexts = parseSse(await streamResponse.text())
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text);
  assert.equal(streamTexts[0], "answer");
  assert.match(streamTexts[1], /openai_url_citations/);
});

test("current Anthropic HTTP error status mapping is exact", () => {
  assert.deepEqual(
    [402, 409, 413, 504].map((status) =>
      mapUpstreamStatusToAnthropicErrorType(status)
    ),
    ["billing_error", "conflict_error", "request_too_large", "timeout_error"],
  );
});

test("current Anthropic error envelopes preserve nullable request_id", async () => {
  const withRequestId = await buildAnthropicErrorFromUpstream(
    new Response(
      JSON.stringify({
        request_id: "req_upstream",
        error: { message: "failed" },
      }),
      { status: 409 },
    ),
  );
  assert.equal(withRequestId.body.request_id, "req_upstream");
  assert.equal(withRequestId.body.error.type, "conflict_error");

  const withoutRequestId = await buildAnthropicErrorFromUpstream(
    new Response("plain failure", { status: 504 }),
  );
  assert.equal(withoutRequestId.body.request_id, null);
  assert.equal(withoutRequestId.body.error.type, "timeout_error");

  const malformedMessage = await buildAnthropicErrorFromUpstream(
    new Response('{"error":{"message":{"code":"bad"}}}', { status: 502 }),
  );
  assert.equal(typeof malformedMessage.body.error.message, "string");
  assert.equal(
    malformedMessage.body.error.message,
    '{"error":{"message":{"code":"bad"}}}',
  );
});
