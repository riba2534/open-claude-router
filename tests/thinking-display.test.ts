import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const omittedContext = {
  req: {
    id: "thinking-display-test",
    body: { thinking: { type: "adaptive", display: "omitted" } },
  },
} as any;

const ordinaryContext = {
  req: { id: "thinking-display-test", body: {} },
} as any;

function anthropicTransformer(): AnthropicTransformer {
  const transformer = new AnthropicTransformer();
  transformer.logger = logger;
  return transformer;
}

function responsesTransformer(): OpenAIResponsesTransformer {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  return transformer;
}

function chatJson(reasoning: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-thinking-display",
      object: "chat.completion",
      model: "reasoner",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: reasoning,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function responsesJson(reasoning: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp-thinking-display",
      object: "response",
      model: "reasoner",
      status: "completed",
      output: [
        {
          id: "rs-display",
          type: "reasoning",
          content: [{ type: "reasoning_text", text: reasoning }],
          encrypted_content: "encrypted-display-state",
        },
        {
          id: "msg-display",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

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
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)));
}

function decodeReasoningSignature(signature: string): any {
  const prefix = "ocr-responses-reasoning-v1:";
  assert.ok(signature.startsWith(prefix));
  return JSON.parse(
    Buffer.from(signature.slice(prefix.length), "base64url").toString("utf8"),
  );
}

test("thinking.display validates formal values and is invalid with disabled", async () => {
  const base = {
    model: "claude-test",
    max_tokens: 2048,
    messages: [{ role: "user", content: "hello" }],
  };
  const transformer = anthropicTransformer();

  await assert.rejects(
    transformer.transformRequestOut!({
      ...base,
      thinking: { type: "adaptive", display: "private" },
    } as any),
    /thinking\.display must be "summarized", "omitted", or null/,
  );
  await assert.rejects(
    transformer.transformRequestOut!({
      ...base,
      thinking: { type: "disabled", display: "omitted" },
    } as any),
    /thinking\.display is not valid when thinking is disabled/,
  );

  const nullable: any = await transformer.transformRequestOut!({
    ...base,
    thinking: { type: "adaptive", display: null },
  } as any);
  assert.equal(nullable.reasoning?.display, undefined);
});

test("Responses omitted display requests encrypted state without a detailed summary", async () => {
  const anthropic = anthropicTransformer();
  const responses = responsesTransformer();
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 2048,
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "adaptive", display: "omitted" },
  } as any);

  assert.equal(unified.reasoning?.display, "omitted");
  const outbound: any = await responses.transformRequestIn!(unified);
  assert.equal(outbound.reasoning, undefined);
  assert.deepEqual(outbound.include, ["reasoning.encrypted_content"]);

  const enabled: any = await responses.transformRequestIn!(
    await anthropic.transformRequestOut!({
      model: "claude-test",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 2048,
        display: "omitted",
      },
    } as any),
  );
  assert.equal(typeof enabled.reasoning?.effort, "string");
  assert.equal(enabled.reasoning?.summary, undefined);
  assert.deepEqual(enabled.include, ["reasoning.encrypted_content"]);

  const summarized: any = await responses.transformRequestIn!(
    await anthropic.transformRequestOut!({
      model: "claude-test",
      max_tokens: 2048,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive", display: "summarized" },
    } as any),
  );
  assert.deepEqual(summarized.reasoning, { summary: "detailed" });
});

test("Chat JSON rejects omitted reasoning without replayable state", async () => {
  await assert.rejects(
    anthropicTransformer().transformResponseIn!(
      chatJson("private chat reasoning"),
      omittedContext,
    ),
    (error: any) =>
      error?.statusCode === 502 && error?.code === "upstream_protocol_error",
  );

  const visibleResponse = await anthropicTransformer().transformResponseIn!(
    chatJson("visible chat reasoning"),
    ordinaryContext,
  );
  const visible: any = await visibleResponse.json();
  assert.equal(visible.content[0].thinking, "visible chat reasoning");
});

test("Responses JSON hides text but preserves its replayable signature", async () => {
  const chat = await responsesTransformer().transformResponseOut(
    responsesJson("private responses reasoning"),
  );
  const converted = await anthropicTransformer().transformResponseIn!(
    chat,
    omittedContext,
  );
  const body: any = await converted.json();
  const thinking = body.content.find((block: any) => block.type === "thinking");

  assert.equal(thinking.thinking, "");
  assert.deepEqual(decodeReasoningSignature(thinking.signature), {
    id: "rs-display",
    encrypted_content: "encrypted-display-state",
  });
  assert.equal(body.content.find((block: any) => block.type === "text").text, "answer");
});

test("Chat SSE rejects omitted reasoning without replayable state", async () => {
  const upstream = sse([
    {
      id: "chatcmpl-thinking-display",
      model: "reasoner",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "private stream reasoning" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-thinking-display",
      model: "reasoner",
      choices: [
        {
          index: 0,
          delta: { content: "answer" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-thinking-display",
      model: "reasoner",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
  const converted = await anthropicTransformer().transformResponseIn!(
    upstream,
    omittedContext,
  );
  const events = parseAnthropicSse(await converted.text());

  assert.equal(events.some((event) => event.delta?.type === "thinking_delta"), false);
  assert.equal(events.some((event) => event.delta?.type === "signature_delta"), false);
  assert.equal(events.some((event) => event.delta?.type === "text_delta"), false);
  assert.equal(events.some((event) => event.type === "error"), true);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("Responses SSE omitted display suppresses text and retains encrypted replay state", async () => {
  const responsesStream = sse([
    {
      type: "response.created",
      response: { id: "resp-thinking-display", model: "reasoner" },
    },
    {
      type: "response.reasoning_text.delta",
      item_id: "rs-display",
      output_index: 0,
      content_index: 0,
      delta: "private responses stream reasoning",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs-display",
        type: "reasoning",
        content: [
          { type: "reasoning_text", text: "private responses stream reasoning" },
        ],
        encrypted_content: "encrypted-display-state",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg-display",
      output_index: 1,
      content_index: 0,
      delta: "answer",
    },
    {
      type: "response.completed",
      response: {
        id: "resp-thinking-display",
        model: "reasoner",
        output: [{ type: "reasoning" }, { type: "message" }],
      },
    },
  ]);
  const chat = await responsesTransformer().transformResponseOut(responsesStream);
  const converted = await anthropicTransformer().transformResponseIn!(
    chat,
    omittedContext,
  );
  const events = parseAnthropicSse(await converted.text());

  assert.equal(events.some((event) => event.delta?.type === "thinking_delta"), false);
  const signature = events.find(
    (event) => event.delta?.type === "signature_delta",
  )?.delta.signature;
  assert.deepEqual(decodeReasoningSignature(signature), {
    id: "rs-display",
    encrypted_content: "encrypted-display-state",
  });
  assert.equal(events.find((event) => event.delta?.type === "text_delta")?.delta.text, "answer");
});
