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

const context = { req: { id: "reasoning-refusal-test" } } as any;

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

test("Responses reasoning_text delta is not duplicated by done or item fallback", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.created",
        response: { id: "resp-reasoning", model: "gpt-test" },
      },
      {
        type: "response.reasoning_text.delta",
        item_id: "rs-1",
        output_index: 0,
        content_index: 0,
        delta: "private reasoning",
      },
      {
        type: "response.reasoning_text.done",
        item_id: "rs-1",
        output_index: 0,
        content_index: 0,
        text: "private reasoning",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs-1",
          type: "reasoning",
          content: [
            { type: "reasoning_text", text: "private reasoning" },
          ],
          encrypted_content: "encrypted-state",
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        output_index: 1,
        content_index: 0,
        delta: "answer",
      },
      {
        type: "response.completed",
        response: {
          id: "resp-reasoning",
          model: "gpt-test",
          output: [{ type: "reasoning" }, { type: "message" }],
        },
      },
    ]),
  );

  assert.deepEqual(
    events
      .filter((event) => event.delta?.type === "thinking_delta")
      .map((event) => event.delta.thinking),
    ["private reasoning"],
  );
  assert.deepEqual(
    decodeReasoningSignature(
      events.find((event) => event.delta?.type === "signature_delta")?.delta
        .signature,
    ),
    { id: "rs-1", encrypted_content: "encrypted-state" },
  );
});

test("Responses reasoning_text done-only event is preserved once", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.created",
        response: { id: "resp-reasoning-done", model: "gpt-test" },
      },
      {
        type: "response.reasoning_text.delta",
        item_id: "rs-1",
        output_index: 0,
        content_index: 0,
        delta: "",
      },
      {
        type: "response.reasoning_text.done",
        item_id: "rs-1",
        output_index: 0,
        content_index: 0,
        text: "done-only reasoning",
      },
      {
        type: "response.completed",
        response: {
          id: "resp-reasoning-done",
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
    ["done-only reasoning"],
  );
});

test("Responses raw reasoning takes precedence over summary for the same item", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.reasoning_text.delta",
        item_id: "rs-multipart",
        output_index: 0,
        content_index: 0,
        delta: "A",
      },
      {
        type: "response.reasoning_text.done",
        item_id: "rs-multipart",
        output_index: 0,
        content_index: 1,
        text: "B",
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs-multipart",
        output_index: 0,
        summary_index: 0,
        delta: "C",
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs-multipart",
        output_index: 0,
        summary_index: 1,
        text: "D",
      },
      {
        type: "response.completed",
        response: {
          id: "resp-reasoning-multipart",
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
    ["A", "B"],
  );
});

test("Responses reasoning output item content is a stream fallback", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.created",
        response: { id: "resp-reasoning-item", model: "gpt-test" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs-1",
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "item fallback" }],
          encrypted_content: "encrypted-state",
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp-reasoning-item",
          model: "gpt-test",
          output: [{ type: "reasoning" }],
        },
      },
    ]),
  );

  assert.equal(
    events.find((event) => event.delta?.type === "thinking_delta")?.delta
      .thinking,
    "item fallback",
  );
  assert.deepEqual(
    decodeReasoningSignature(
      events.find((event) => event.delta?.type === "signature_delta")?.delta
        .signature,
    ),
    { id: "rs-1", encrypted_content: "encrypted-state" },
  );
});

test("non-stream Responses prefers reasoning_text content over summary", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(
      JSON.stringify({
        id: "resp-reasoning-json",
        object: "response",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            id: "rs-1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary fallback" }],
            content: [
              { type: "reasoning_text", text: "private reasoning" },
            ],
            encrypted_content: "encrypted-state",
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  const converted = await anthropic.transformResponseIn!(chat, context);
  const body: any = await converted.json();

  assert.equal(body.content[0].type, "thinking");
  assert.equal(body.content[0].thinking, "private reasoning");
  assert.deepEqual(decodeReasoningSignature(body.content[0].signature), {
    id: "rs-1",
    encrypted_content: "encrypted-state",
  });
});

test("Chat streaming refusal is preserved as assistant text", async () => {
  const events = await chatStreamToAnthropic(
    sse([
      {
        id: "chatcmpl-refusal",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", refusal: "I cannot help." },
            finish_reason: "content_filter",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      },
    ]),
  );

  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "I cannot help.",
  );
  // content_filter maps to Anthropic's semantically exact `refusal`.
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "refusal",
  );
});

test("Chat non-stream refusal is preserved as assistant text", async () => {
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const converted = await anthropic.transformResponseIn!(
    new Response(
      JSON.stringify({
        id: "chatcmpl-refusal",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: "I cannot help.",
            },
            finish_reason: "content_filter",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    context,
  );
  const body: any = await converted.json();

  assert.deepEqual(body.content, [{ type: "text", text: "I cannot help." }]);
  assert.equal(body.stop_reason, "refusal");
});

test("empty Responses deltas do not suppress complete done values", async () => {
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        content_index: 0,
        delta: "",
      },
      {
        type: "response.output_text.done",
        item_id: "msg-1",
        content_index: 0,
        text: "answer",
      },
      {
        type: "response.refusal.delta",
        item_id: "msg-1",
        content_index: 1,
        delta: "",
      },
      {
        type: "response.refusal.done",
        item_id: "msg-1",
        content_index: 1,
        refusal: "REFUSED",
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "call-item",
        delta: "",
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "call-item",
        arguments: '{"ok":true}',
      },
      {
        type: "response.completed",
        response: {
          id: "resp-empty-deltas",
          model: "gpt-test",
          output: [{ type: "message" }, { type: "function_call" }],
        },
      },
    ]),
  );

  assert.deepEqual(
    events
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text),
    ["answer", "REFUSED"],
  );
  assert.equal(
    events.find((event) => event.delta?.type === "input_json_delta")?.delta
      .partial_json,
    '{"ok":true}',
  );
});

test("multi-part message item fallback stays textual and does not duplicate", async () => {
  const messageItem = {
    id: "msg-multipart",
    type: "message",
    content: [
      { type: "output_text", text: "answer" },
      { type: "refusal", refusal: " refused" },
    ],
  };
  const events = await responsesStreamToAnthropic(
    sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: messageItem,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: messageItem,
      },
      {
        type: "response.completed",
        response: {
          id: "resp-message-multipart",
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
    ["answer refused"],
  );
});
