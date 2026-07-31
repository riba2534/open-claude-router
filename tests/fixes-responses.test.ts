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

const context = { req: { id: "fixes-responses-test" } } as any;

function responsePayload(output: unknown[], extra: Record<string, unknown> = {}) {
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

function decodeReasoningSignature(signature: string): any {
  const prefix = "ocr-responses-reasoning-v1:";
  assert.ok(signature.startsWith(prefix));
  return JSON.parse(
    Buffer.from(signature.slice(prefix.length), "base64url").toString("utf8"),
  );
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

async function responsesJsonToAnthropic(payload: unknown): Promise<any> {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    }),
  );
  return (await anthropic.transformResponseIn!(chat, context)).json();
}

async function responsesStreamToChat(events: unknown[]): Promise<any[]> {
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseOut(sse(events));
  return parseSse(await converted.text());
}

async function responsesStreamToAnthropic(events: unknown[]): Promise<any[]> {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const anthropic = new AnthropicTransformer();
  anthropic.logger = logger;
  const chat = await responses.transformResponseOut(sse(events));
  const converted = await anthropic.transformResponseIn!(chat, context);
  return parseSse(await converted.text());
}

test("Responses programmatic tool calls never masquerade as direct Anthropic tools", async () => {
  const program = {
    type: "program",
    id: "prog_1",
    call_id: "call_prog_1",
    code: "await tools.lookup({})",
    fingerprint: "opaque-program-state",
  };
  const programCall = {
    type: "function_call",
    id: "fc_program_1",
    call_id: "call_lookup_1",
    name: "lookup",
    arguments: "{}",
    caller: { type: "program", caller_id: "call_prog_1" },
  };
  const programOutput = {
    type: "program_output",
    id: "prog_out_1",
    call_id: "call_prog_1",
    result: "{}",
    status: "completed",
  };

  for (const item of [program, programCall, programOutput]) {
    await assert.rejects(
      () => responsesJsonToChat(responsePayload([item])),
      (error: any) =>
        error?.statusCode === 502 &&
        error?.code === "upstream_protocol_error" &&
        /replay-safe Anthropic/.test(error.message),
    );
  }

  for (const item of [program, programCall]) {
    const liveEvents = await responsesStreamToChat([{
      type: "response.output_item.added",
      output_index: 0,
      item,
    }]);
    assert.equal(liveEvents.some((event) => event.error?.status === 502), true);
    assert.equal(
      liveEvents.some((event) => event.choices?.[0]?.delta?.tool_calls),
      false,
    );
  }

  const terminalEvents = await responsesStreamToAnthropic([{
    type: "response.completed",
    response: responsePayload([program, programCall]),
  }]);
  assert.equal(terminalEvents.some((event) => event.type === "error"), true);
  assert.equal(
    terminalEvents.some((event) => event.content_block?.type === "tool_use"),
    false,
  );
  assert.equal(
    terminalEvents.some((event) => event.type === "message_stop"),
    false,
  );
});

test("Responses refusal parts remain a refusal terminal in JSON and streams", async () => {
  const output = [
    {
      id: "msg_refusal",
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I cannot help with that." }],
    },
  ];

  const json = await responsesJsonToAnthropic(responsePayload(output));
  assert.equal(json.content[0].text, "I cannot help with that.");
  assert.equal(json.stop_reason, "refusal");
  assert.equal(json.stop_details?.type, "refusal");

  const stream = await responsesStreamToAnthropic([
    {
      type: "response.refusal.delta",
      item_id: "msg_refusal",
      output_index: 0,
      content_index: 0,
      delta: "I cannot ",
    },
    {
      type: "response.refusal.done",
      item_id: "msg_refusal",
      output_index: 0,
      content_index: 0,
      refusal: "I cannot help with that.",
    },
    {
      type: "response.completed",
      response: responsePayload(output),
    },
  ]);
  assert.equal(
    stream
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join(""),
    "I cannot ",
  );
  const terminal = stream.find((event) => event.type === "message_delta");
  assert.equal(terminal?.delta.stop_reason, "refusal");
  assert.equal(terminal?.delta.stop_details?.type, "refusal");

  const doneOnly = await responsesStreamToAnthropic([
    {
      type: "response.refusal.done",
      item_id: "msg_done_refusal",
      output_index: 0,
      content_index: 0,
      refusal: "Done-only refusal.",
    },
    {
      type: "response.completed",
      response: responsePayload([]),
    },
  ]);
  assert.equal(
    doneOnly.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "Done-only refusal.",
  );
  assert.equal(
    doneOnly.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "refusal",
  );
});

test("reasoning separated from a tool by a visible message is not re-paired", async () => {
  const payload = responsePayload([
      {
        id: "rs_before_message",
        type: "reasoning",
        encrypted_content: "state-before-message",
        summary: [{ type: "summary_text", text: "think" }],
      },
      {
        id: "msg_visible",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
      {
        id: "fc_after_message",
        call_id: "call_after_message",
        type: "function_call",
        name: "lookup",
        arguments: "{}",
      },
    ]);
  const chat = await responsesJsonToChat(payload);

  assert.equal(chat.choices[0].message.thinking_blocks[0].tool_call_id, undefined);
  assert.equal(chat.choices[0].message.content, "visible");
  assert.equal(chat.choices[0].message.tool_calls[0].id, "call_after_message");

  const anthropic = await responsesJsonToAnthropic(payload);
  assert.deepEqual(
    anthropic.content.map((block: any) => block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(
    anthropic.content.find((block: any) => block.type === "tool_use")?.caller,
    { type: "direct" },
  );
});

test("reasoning without encrypted_content has a reversible replay envelope", async () => {
  const chat = await responsesJsonToChat(
    responsePayload([
      {
        id: "rs_visible_state",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary state" }],
        content: [{ type: "reasoning_text", text: "raw state" }],
      },
      {
        id: "msg_answer",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    ]),
  );
  const block = chat.choices[0].message.thinking_blocks[0];
  assert.deepEqual(decodeReasoningSignature(block.signature), {
    id: "rs_visible_state",
    summary: [{ type: "summary_text", text: "summary state" }],
    content: [{ type: "reasoning_text", text: "raw state" }],
  });

  const transformer = new OpenAIResponsesTransformer();
  const replayed: any = await transformer.transformRequestIn({
    model: "gpt-test",
    max_tokens: 64,
    messages: [
      chat.choices[0].message,
      { role: "user", content: "continue" },
    ],
  } as any);
  assert.deepEqual(replayed.input[0], {
    type: "reasoning",
    id: "rs_visible_state",
    summary: [{ type: "summary_text", text: "summary state" }],
    content: [{ type: "reasoning_text", text: "raw state" }],
  });
});

test("Responses EasyInputMessage arrays use input parts for assistant history", async () => {
  const transformer = new OpenAIResponsesTransformer();
  const request: any = await transformer.transformRequestIn({
    model: "gpt-test",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "prior answer" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/prior.png" },
          },
          {
            type: "file",
            file: { file_id: "file_prior", filename: "prior.pdf" },
            fallback_text: "[document: prior.pdf]",
          },
        ],
      },
    ],
  } as any);

  assert.deepEqual(request.input, [
    {
      role: "assistant",
      content: [
        { type: "input_text", text: "prior answer" },
        {
          type: "input_image",
          image_url: "https://example.com/prior.png",
        },
        { type: "input_file", file_id: "file_prior", filename: "prior.pdf" },
      ],
    },
  ]);
  assert.equal(JSON.stringify(request.input).includes("output_text"), false);
  assert.equal(JSON.stringify(request.input).includes("output_image"), false);
});

test("non-stream incomplete function calls preserve bytes but stop at max_tokens", async () => {
  const partialCall = {
    id: "fc_incomplete",
    call_id: "call_incomplete",
    type: "function_call",
    name: "dangerous_action",
    arguments: "{\"target\":",
  };
  const cases = [
    responsePayload([{ ...partialCall, status: "completed" }], {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }),
    responsePayload([{ ...partialCall, status: "incomplete" }]),
  ];

  for (const payload of cases) {
    const chat = await responsesJsonToChat(payload);
    assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, "{\"target\":");
    assert.equal(chat.choices[0].finish_reason, "length");

    const anthropic = await responsesJsonToAnthropic(payload);
    const tool = anthropic.content.find((block: any) => block.type === "tool_use");
    assert.equal(tool, undefined, "a partial call must not look executable");
    assert.match(anthropic.content[0].text, /dangerous_action/);
    assert.match(anthropic.content[0].text, /\{"target":/);
    assert.equal(anthropic.stop_reason, "max_tokens");
  }
});

test("stream incomplete function calls never produce a tool_use terminal", async () => {
  const partialCall = {
    id: "fc_stream_incomplete",
    call_id: "call_stream_incomplete",
    type: "function_call",
    name: "dangerous_action",
    arguments: "{\"target\":",
  };
  const terminals = [
    {
      type: "response.incomplete",
      response: responsePayload([{ ...partialCall, status: "completed" }], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    },
    {
      type: "response.completed",
      response: responsePayload([{ ...partialCall, status: "incomplete" }]),
    },
  ];

  for (const terminal of terminals) {
    const events = await responsesStreamToAnthropic([terminal]);
    const toolStart = events.find(
      (event) =>
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use",
    );
    assert.equal(toolStart, undefined);
    const diagnostic = events
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join("");
    assert.match(diagnostic, /dangerous_action/);
    assert.match(diagnostic, /\{"target":/);
    assert.equal(
      events.find((event) => event.type === "message_delta")?.delta.stop_reason,
      "max_tokens",
    );
  }
});

test("refusal still outranks an incomplete function call", async () => {
  const payload = responsePayload(
    [
      {
        id: "msg_filtered",
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Request refused." }],
      },
      {
        id: "fc_filtered",
        call_id: "call_filtered",
        type: "function_call",
        status: "incomplete",
        name: "must_not_execute",
        arguments: "{",
      },
    ],
    {
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    },
  );
  const chat = await responsesJsonToChat(payload);
  assert.equal(chat.choices[0].finish_reason, "content_filter");
  const anthropic = await responsesJsonToAnthropic(payload);
  assert.equal(anthropic.stop_reason, "refusal");
});

test("stream prefers reasoning_text over the same item's summary", async () => {
  const chunks = await responsesStreamToChat([
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_dual",
      output_index: 0,
      summary_index: 0,
      delta: "SUMMARY",
    },
    {
      type: "response.reasoning_text.delta",
      item_id: "rs_dual",
      output_index: 0,
      content_index: 0,
      delta: "RAW",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_dual",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "SUMMARY" }],
        content: [{ type: "reasoning_text", text: "RAW" }],
      },
    },
    {
      type: "response.completed",
      response: responsePayload([]),
    },
  ]);
  assert.deepEqual(
    chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.thinking?.content)
      .filter(Boolean),
    ["RAW"],
  );
});

test("function_call_output keeps formal multi-block text and file arrays", async () => {
  const transformer = new OpenAIResponsesTransformer();
  const request: any = await transformer.transformRequestIn({
    model: "gpt-test",
    max_tokens: 64,
    messages: [
      {
        role: "tool",
        tool_call_id: "call_blocks",
        content: [
          { type: "text", text: "first" },
          {
            type: "file",
            file: {
              file_data: "data:application/pdf;base64,JVBERi0=",
              filename: "report.pdf",
            },
            fallback_text: "[document: report.pdf]",
          },
          { type: "text", text: "last" },
        ],
      },
    ],
  } as any);

  assert.deepEqual(request.input, [
    {
      type: "function_call_output",
      call_id: "call_blocks",
      output: [
        { type: "input_text", text: "first" },
        {
          type: "input_file",
          file_data: "data:application/pdf;base64,JVBERi0=",
          filename: "report.pdf",
        },
        { type: "input_text", text: "last" },
      ],
    },
  ]);
});

test("formal image generation output is a bounded, deduplicated placeholder", async () => {
  const item = {
    id: "ig_1",
    type: "image_generation_call",
    status: "completed",
    result: "A".repeat(200_000),
  };
  const json = await responsesJsonToChat(responsePayload([item]));
  assert.equal(json.choices[0].message.content, "[generated image omitted]");
  assert.equal(JSON.stringify(json).includes(item.result), false);

  const chunks = await responsesStreamToChat([
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: responsePayload([item]) },
  ]);
  assert.deepEqual(
    chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter(Boolean),
    ["[generated image omitted]"],
  );
  assert.equal(JSON.stringify(chunks).includes(item.result), false);
});

test("terminal-only completed event recovers output in original order", async () => {
  const events = await responsesStreamToAnthropic([
    {
      type: "response.completed",
      response: responsePayload([
        { id: "rs_terminal", type: "reasoning", encrypted_content: "state" },
        {
          id: "msg_terminal",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
        {
          id: "fc_terminal",
          call_id: "call_terminal",
          type: "function_call",
          name: "lookup",
          arguments: "{\"id\":1}",
        },
      ]),
    },
  ]);

  assert.deepEqual(
    events
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.content_block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "tool_use",
  );
});

test("signature-only reasoning items keep distinct identities in streams", async () => {
  const events = await responsesStreamToAnthropic([
    {
      type: "response.completed",
      response: responsePayload([
        { id: "rs_one", type: "reasoning", encrypted_content: "one" },
        { id: "rs_two", type: "reasoning", encrypted_content: "two" },
      ]),
    },
  ]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.content_block.type),
    ["thinking", "thinking"],
  );
  const envelopes = events
    .map((event) => event.delta?.signature)
    .filter(Boolean)
    .map(decodeReasoningSignature);
  assert.deepEqual(envelopes, [
    { id: "rs_one", encrypted_content: "one" },
    { id: "rs_two", encrypted_content: "two" },
  ]);
});

test("downstream stream cancellation cancels the upstream Responses reader", async () => {
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start() {
      // Leave the read pending until the downstream consumer cancels.
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const transformer = new OpenAIResponsesTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseOut(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  await converted.body!.getReader().cancel("client disconnected");
  assert.equal(upstreamCancelled, true);
});
