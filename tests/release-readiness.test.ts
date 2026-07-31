import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { registerMessagesRoute } from "../src/routes/messages.js";
import type { ApiError } from "../src/transformers/errors.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

function responsePayload(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "resp_release",
    object: "response",
    model: "gpt-test",
    created_at: 1,
    status: "completed",
    output,
    ...extra,
  };
}

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

async function responsesJsonToAnthropic(
  payload: unknown,
  thinkingDisplay?: "summarized" | "omitted",
): Promise<{ response: Response; body: any }> {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(jsonResponse(payload), {
    thinkingDisplay,
  });
  const response = await anthropic.transformResponseIn!(chat, {
    req: {
      id: "release-readiness",
      body: thinkingDisplay
        ? { thinking: { display: thinkingDisplay } }
        : {},
    },
  } as any);
  return { response, body: await response.clone().json() };
}

test("strict tools and Anthropic structured output survive both upstream formats", async () => {
  const anthropic = new AnthropicTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 32,
    messages: [{ role: "user", content: "return JSON" }],
    tools: [
      {
        name: "lookup",
        description: "lookup",
        strict: true,
        input_schema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
          additionalProperties: false,
        },
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  });

  assert.equal(unified.tools?.[0].function.strict, true);
  assert.deepEqual(unified.response_format, {
    type: "json_schema",
    json_schema: {
      name: "anthropic_output",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      strict: true,
    },
  });

  const responses = new OpenAIResponsesTransformer();
  const outbound: any = await responses.transformRequestIn!(
    structuredClone(unified),
  );
  assert.equal(outbound.tools[0].strict, true);
  assert.deepEqual(outbound.text.format, {
    type: "json_schema",
    name: "anthropic_output",
    schema: unified.response_format?.json_schema.schema,
    strict: true,
  });
  assert.equal(Object.hasOwn(outbound, "response_format"), false);
});

test("completed malformed tool arguments fail instead of becoming tool input text", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  await assert.rejects(
    anthropic.transformResponseIn!(
      jsonResponse({
        id: "chat_bad_tool",
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: { name: "dangerous", arguments: "{" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { req: { id: "bad-tool", body: {} } } as any,
    ),
    (error: ApiError) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "upstream_protocol_error");
      return true;
    },
  );

  const converted = await anthropic.transformResponseIn!(
    sse([
      {
        id: "chat_bad_tool_stream",
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad",
                  type: "function",
                  function: { name: "dangerous", arguments: "{" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat_bad_tool_stream",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
    { req: { id: "bad-tool-stream", body: {} } } as any,
  );
  const events = parseSse(await converted.text());
  assert.equal(events.some((event) => event.type === "error"), true);
  assert.equal(
    events.some((event) => event.content_block?.type === "tool_use"),
    false,
  );
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("unknown Chat finish reasons fail in JSON and streaming conversions", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const payload = {
    id: "chat_unknown_finish",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "partial" },
        finish_reason: "future_reason",
      },
    ],
  };
  await assert.rejects(
    anthropic.transformResponseIn!(jsonResponse(payload), {
      req: { id: "unknown-finish", body: {} },
    } as any),
    (error: ApiError) => error.statusCode === 502,
  );

  const streamed = await anthropic.transformResponseIn!(
    sse([
      {
        id: payload.id,
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: { content: "partial" },
            finish_reason: "future_reason",
          },
        ],
      },
    ]),
    { req: { id: "unknown-finish-stream", body: {} } } as any,
  );
  const events = parseSse(await streamed.text());
  assert.equal(events.some((event) => event.type === "error"), true);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("omitted Responses reasoning requires encrypted replay state", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  await assert.rejects(
    responses.transformResponseOut(
      jsonResponse(
        responsePayload([
          {
            id: "rs_plain",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "private summary" }],
          },
          {
            id: "msg",
            type: "message",
            content: [{ type: "output_text", text: "answer" }],
          },
        ]),
      ),
      { thinkingDisplay: "omitted" },
    ),
    (error: ApiError) => error.statusCode === 502,
  );

  const chat = await responses.transformResponseOut(
    jsonResponse(
      responsePayload([
        {
          id: "rs_encrypted",
          type: "reasoning",
          encrypted_content: "opaque-state",
          summary: [{ type: "summary_text", text: "private summary" }],
        },
      ]),
    ),
    { thinkingDisplay: "omitted" },
  );
  const body: any = await chat.json();
  const signature = body.choices[0].message.output_blocks[0].signature;
  const decoded = Buffer.from(
    signature.slice("ocr-responses-reasoning-v1:".length),
    "base64url",
  ).toString("utf8");
  assert.doesNotMatch(decoded, /private summary/);
  assert.match(decoded, /opaque-state/);
});

test("Responses output order, refusal, citations, unknown items, and cache writes are preserved", async () => {
  const { body } = await responsesJsonToAnthropic(
    responsePayload(
      [
        {
          id: "search_1",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "source query" },
        },
        {
          id: "fc_first",
          call_id: "call_first",
          type: "function_call",
          name: "lookup",
          arguments: '{"q":"x"}',
        },
        {
          id: "msg_second",
          type: "message",
          content: [
            { type: "output_text", text: "answer" },
            {
              type: "refusal",
              refusal: "cannot continue",
              annotations: [
                { type: "file_citation", file_id: "file_1" },
                {
                  type: "url_citation",
                  url: "https://example.com/source",
                  title: "source",
                },
              ],
            },
          ],
        },
        { id: "future_1", type: "future_output", payload: { value: 1 } },
      ],
      {
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: {
            cached_tokens: 20,
            cache_write_tokens: 30,
          },
        },
      },
    ),
  );

  assert.deepEqual(
    body.content.map((block: any) => block.type),
    [
      "text",
      "tool_use",
      "text",
      "text",
      "text",
      "text",
      "text",
    ],
  );
  assert.match(body.content[0].text, /search_1/);
  assert.match(body.content[0].text, /source query/);
  assert.equal(body.content[1].name, "lookup");
  assert.equal(body.content[2].text, "answer");
  assert.equal(body.content[3].text, "cannot continue");
  assert.match(body.content[4].text, /file_citation/);
  assert.match(body.content[5].text, /https:\/\/example.com\/source/);
  assert.match(body.content[6].text, /future_output/);
  assert.equal(body.stop_reason, "refusal");
  assert.equal(body.stop_details.explanation, "cannot continue");
  assert.deepEqual(body.usage, {
    input_tokens: 50,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
  });
});

test("Responses stream groups URL citations and preserves refusal/error semantics", async () => {
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
          id: "search_stream",
          type: "web_search_call",
          status: "in_progress",
          action: { type: "search", query: "stream sources" },
        },
      },
      {
        type: "response.output_text.annotation.added",
        item_id: "msg_citations",
        output_index: 1,
        content_index: 0,
        annotation_index: 0,
        annotation: { type: "file_citation", file_id: "file_1" },
      },
      {
        type: "response.output_text.annotation.added",
        item_id: "msg_citations",
        output_index: 1,
        content_index: 0,
        annotation_index: 1,
        annotation: {
          type: "url_citation",
          url: "https://example.com/a",
          title: "a",
        },
      },
      {
        type: "response.output_text.annotation.added",
        item_id: "msg_citations",
        output_index: 1,
        content_index: 0,
        annotation_index: 2,
        annotation: {
          type: "url_citation",
          url: "https://example.com/b",
          title: "b",
        },
      },
      {
        type: "response.refusal.done",
        item_id: "msg_refusal",
        refusal: "not allowed",
      },
      {
        type: "response.completed",
        response: responsePayload([
          {
            id: "search_stream",
            type: "web_search_call",
            status: "completed",
            action: { type: "search", query: "stream sources" },
          },
        ], {
          usage: {
            input_tokens: 25,
            output_tokens: 3,
            total_tokens: 28,
            input_tokens_details: {
              cached_tokens: 5,
              cache_write_tokens: 7,
            },
          },
        }),
      },
    ]),
  );
  const converted = await anthropic.transformResponseIn!(chat, {
    req: { id: "citations", body: {} },
  } as any);
  const events = parseSse(await converted.text());
  const serverStarts = events.filter(
    (event) =>
      event.type === "content_block_start" &&
      event.content_block?.type === "server_tool_use",
  );
  const resultStarts = events.filter(
    (event) =>
      event.type === "content_block_start" &&
      event.content_block?.type === "web_search_tool_result",
  );
  assert.equal(serverStarts.length, 0);
  assert.equal(resultStarts.length, 0);
  const fallbackText = events
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");
  assert.match(fallbackText, /search_stream/);
  assert.match(fallbackText, /stream sources/);
  assert.match(fallbackText, /https:\/\/example.com\/a/);
  assert.match(fallbackText, /https:\/\/example.com\/b/);
  const terminal = events.find((event) => event.type === "message_delta");
  assert.equal(terminal.delta.stop_reason, "refusal");
  assert.equal(terminal.delta.stop_details.explanation, "not allowed");
  assert.equal(terminal.usage.cache_creation_input_tokens, 7);

  const failedChat = await responses.transformResponseOut(
    sse([
      {
        type: "response.failed",
        response: {
          id: "resp_failed",
          model: "m",
          error: { code: "rate_limit_exceeded", message: "slow down" },
        },
      },
    ]),
  );
  const failed = await anthropic.transformResponseIn!(failedChat, {
    req: { id: "failed", body: {} },
  } as any);
  const failedEvents = parseSse(await failed.text());
  assert.equal(failedEvents[0].error.type, "rate_limit_error");
  assert.equal(failedEvents.some((event) => event.type === "message_stop"), false);
});

test("Responses logical failures map status and retain the retry contract", async () => {
  const responses = new OpenAIResponsesTransformer();
  const rateLimited = await responses.transformResponseOut(
    jsonResponse({
      object: "response",
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "slow down" },
    }),
  );
  assert.equal(rateLimited.status, 429);
  assert.equal((await rateLimited.json() as any).error.type, "rate_limit_error");

  const invalid = await responses.transformResponseOut(
    jsonResponse({
      object: "response",
      status: "failed",
      error: { code: "invalid_prompt", message: "bad prompt" },
    }),
  );
  assert.equal(invalid.status, 400);

  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const originalFetch = globalThis.fetch;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const apiError = error as ApiError;
    reply.code(apiError.statusCode ?? 500).send({
      type: "error",
      error: { type: apiError.type ?? "api_error", message: error.message },
    });
  });
  await registerMessagesRoute(app);
  globalThis.fetch = (async () =>
    jsonResponse({
      object: "response",
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "slow down" },
    })) as typeof fetch;
  try {
    const reply = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-upstream-url": "https://upstream.example.com/v1/responses",
        "x-upstream-authorization": "Bearer placeholder",
        "x-upstream-format": "responses",
      },
      payload: {
        model: "claude-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(reply.statusCode, 429);
    assert.equal(reply.headers["x-should-retry"], "true");
    assert.equal(reply.json().error.type, "rate_limit_error");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
    else process.env.OCR_ACCESS_TOKENS = previousTokens;
  }
});

test("release workflow rejects mismatched tags and verifies every multi-arch tag", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/docker-release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /Validate tag and package version/);
  assert.match(workflow, /package\.json version/);
  assert.doesNotMatch(workflow, /type=ref,event=tag/);
  assert.match(workflow, /while IFS= read -r image_tag/);
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /linux\/arm64/);
  assert.match(workflow, /attestation-manifest/);
});
