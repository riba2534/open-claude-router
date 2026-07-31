import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { normalizeMultimodalToolResultsForChatCompletions } from "../src/utils/strip.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

function transformer() {
  const value = new AnthropicTransformer();
  value.logger = logger;
  return value;
}

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
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

async function toAnthropicStream(response: Response): Promise<any[]> {
  const converted = await transformer().transformResponseIn!(response, {
    req: { id: "anthropic-fix-test" },
  } as any);
  return parseAnthropicSse(await converted.text());
}

test("invalid message roles/content and thinking budgets fail locally with 400", async () => {
  const invalidRequests = [
    { messages: [{ role: "system", content: "not allowed here" }] },
    { messages: [{ role: "user", content: null }] },
    { messages: [{ role: "user", content: 7 }] },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 0 },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024.5 },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", budget_tokens: 2048 },
    },
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      transformer().transformRequestOut!(request),
      (error: any) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.type, "invalid_request_error");
        return true;
      },
    );
  }

  const valid = await transformer().transformRequestOut!({
    model: "claude-test",
    // Interleaved thinking is the formal exception where the turn-wide
    // budget may exceed this per-response output cap.
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 16384 },
  });
  assert.deepEqual(valid.reasoning, { effort: "high", enabled: true });
});

test("future system blocks use a bounded, non-empty text fallback", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    system: [
      { type: "future_instruction", payload: "keep this" },
      { type: "large_future", payload: "x".repeat(10_000) },
    ],
  });
  const content = result.messages[0].content as any[];
  assert.equal(content.length, 2);
  assert.match(content[0].text, /future_instruction/);
  assert.match(content[0].text, /keep this/);
  assert.match(content[1].text, /unsupported large_future block omitted/);
  assert.ok(content[1].text.length < 200);
});

test("empty string and empty array content preserve their message turn", async () => {
  for (const message of [
    { role: "user", content: "" },
    { role: "user", content: [] },
    { role: "assistant", content: [] },
  ]) {
    const result = await transformer().transformRequestOut!({
      model: "claude-test",
      messages: [message],
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, message.role);
    assert.equal(result.messages[0].content, "");
  }
});

test("unknown assistant blocks degrade safely while redacted thinking stays opaque", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible" },
          { type: "future_assistant_block", value: "preserve-me" },
          { type: "redacted_thinking", data: "opaque-secret-state" },
        ],
      },
    ],
  });

  const content = String(result.messages[0].content);
  assert.match(content, /^visible\n/);
  assert.match(content, /future_assistant_block/);
  assert.match(content, /preserve-me/);
  assert.doesNotMatch(content, /opaque-secret-state/);
});

test("documents retain a typed unified file envelope and Chat degrades only URL files", async () => {
  const unified = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            title: "report.pdf",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "UERG",
            },
          },
          {
            type: "document",
            title: "remote.pdf",
            source: { type: "url", url: "https://example.com/report.pdf" },
          },
          {
            type: "document",
            source: { type: "file", file_id: "file_document_1" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "read result" },
              {
                type: "document",
                title: "tool.txt",
                source: { type: "text", media_type: "text/plain", data: "abc" },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual((unified.messages[0].content as any[])[0], {
    type: "file",
    file: {
      file_data: "data:application/pdf;base64,UERG",
      filename: "report.pdf",
    },
    fallback_text: '[document "report.pdf": application/pdf, 4 base64 chars]',
  });
  assert.deepEqual((unified.messages[0].content as any[])[1], {
    type: "file",
    file: {
      file_url: "https://example.com/report.pdf",
      filename: "remote.pdf",
    },
    fallback_text: '[document "remote.pdf": https://example.com/report.pdf]',
  });
  assert.deepEqual((unified.messages[0].content as any[])[2], {
    type: "file",
    file: { file_id: "file_document_1" },
    fallback_text: "[document: file_document_1]",
  });
  assert.equal((unified.messages[2].content as any[])[1].type, "file");

  const chat = structuredClone(unified) as any;
  normalizeMultimodalToolResultsForChatCompletions(chat);
  assert.deepEqual(chat.messages[0].content, [
    {
      type: "file",
      file: {
        file_data: "data:application/pdf;base64,UERG",
        filename: "report.pdf",
      },
    },
    {
      type: "text",
      text: '[document "remote.pdf": https://example.com/report.pdf]',
    },
    {
      type: "file",
      file: { file_id: "file_document_1" },
    },
  ]);
  assert.deepEqual(chat.messages.slice(2), [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "read result" }],
    },
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            file_data: "data:text/plain;base64,YWJj",
            filename: "tool.txt",
          },
        },
      ],
    },
  ]);
});

test("assistant replay does not pair thinking across an intervening text block", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "before text", signature: "sig_text" },
          { type: "text", text: "visible" },
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "thinking", thinking: "before tool", signature: "sig_tool" },
          { type: "tool_use", id: "call_2", name: "write", input: {} },
        ],
      },
    ],
  });
  assert.deepEqual(result.messages[0].thinking_blocks, [
    { content: "before text", signature: "sig_text" },
    { content: "before tool", signature: "sig_tool", tool_call_id: "call_2" },
  ]);
});

test("non-stream Chat refusal uses Anthropic refusal stop_details", async () => {
  const converted = await transformer().transformResponseIn!(
    new Response(
      JSON.stringify({
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, refusal: "Cannot help." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    { req: { id: "anthropic-fix-test" } } as any,
  );
  const body = await converted.json() as any;
  assert.equal(body.stop_reason, "refusal");
  assert.deepEqual(body.stop_details, {
    type: "refusal",
    category: null,
    explanation: "Cannot help.",
  });
  assert.deepEqual(body.content, [{ type: "text", text: "Cannot help." }]);
});

test("stream refusal with finish_reason stop retains formal stop_details", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          { index: 0, delta: { role: "assistant", refusal: "Cannot " }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          { index: 0, delta: { refusal: "help." }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
  );
  const delta = events.find((event) => event.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "refusal");
  assert.deepEqual(delta.delta.stop_details, {
    type: "refusal",
    category: null,
    explanation: "Cannot help.",
  });
});

test("a delayed signature after tool deltas seals the original thinking block", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", thinking: { content: "plan" } },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: { thinking: { signature: "real_signature" } },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  const blocks = events.filter((event) => event.type.startsWith("content_block_"));
  assert.deepEqual(
    blocks
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.content_block.type),
    ["thinking", "tool_use"],
  );
  const signatures = blocks
    .filter((event) => event.delta?.type === "signature_delta")
    .map((event) => event.delta.signature);
  assert.deepEqual(signatures, ["real_signature"]);
});

test("downstream stream cancellation cancels the held upstream reader", async () => {
  let upstreamCancelReason: unknown;
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const upstream = new ReadableStream<Uint8Array>({
    pull() {
      // Keep the transform blocked in reader.read() until its downstream is
      // cancelled. The upstream cancel hook is the observable contract.
    },
    cancel(reason) {
      upstreamCancelReason = reason;
      cancelled();
    },
  });
  const converted = await transformer().transformResponseIn!(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    { req: { id: "anthropic-fix-test" } } as any,
  );
  await converted.body!.cancel("client disconnected");
  await cancellation;
  assert.equal(upstreamCancelReason, "client disconnected");
});
