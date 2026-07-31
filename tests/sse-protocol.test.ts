import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { SseBlockDecoder } from "../src/transformers/sse.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

const context = { req: { id: "sse-protocol-test" } } as any;

function parseAnthropicSse(text: string): any[] {
  return text
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line!.slice(6)));
}

function splitJsonAcrossDataLines(value: unknown, newline = "\n"): string {
  const json = JSON.stringify(value);
  const splitAt = json.indexOf(",") + 1;
  assert.ok(splitAt > 0, "fixture must contain a comma");
  return (
    `data:${json.slice(0, splitAt)}` +
    newline +
    `data: ${json.slice(splitAt)}` +
    newline +
    newline
  );
}

async function toAnthropicStream(response: Response): Promise<any[]> {
  const transformer = new AnthropicTransformer();
  transformer.logger = logger;
  const converted = await transformer.transformResponseIn!(response, context);
  return parseAnthropicSse(await converted.text());
}

test("SSE decoder follows block, field, newline, EOF, and UTF-8 semantics", () => {
  const wire = [
    ": comment\r\n",
    "event: custom\r\n",
    "id: event-42\r\n",
    "retry: 1500\r\n",
    'data:{"text":"你",\r\n',
    'data: "value":1}\r\n',
    "\r\n",
    "data: lone-cr\r\r",
    "data: lf\n\n",
    "data: eof",
  ].join("");
  const bytes = new TextEncoder().encode(wire);
  const decoder = new SseBlockDecoder();
  const events = [];

  for (let index = 0; index < bytes.length; index += 1) {
    events.push(...decoder.push(bytes.slice(index, index + 1)));
  }
  events.push(...decoder.finish());

  assert.deepEqual(events, [
    {
      data: '{"text":"你",\n"value":1}',
      event: "custom",
      id: "event-42",
      retry: 1500,
    },
    {
      data: "lone-cr",
      id: "event-42",
      retry: 1500,
    },
    {
      data: "lf",
      id: "event-42",
      retry: 1500,
    },
    {
      data: "eof",
      id: "event-42",
      retry: 1500,
    },
  ]);
});

test("Chat conversion accepts one JSON event split across data fields", async () => {
  const chunk = {
    id: "chatcmpl-multi-data",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  };
  const events = await toAnthropicStream(
    new Response(splitJsonAcrossDataLines(chunk, "\r\n"), {
      headers: { "content-type": "text/event-stream" },
    }),
  );

  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "hello",
  );
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("Responses conversion accepts one JSON event split across data fields", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const created = {
    type: "response.created",
    response: { id: "resp-multi-data", model: "gpt-test" },
  };
  const textDelta = {
    type: "response.output_text.delta",
    item_id: "msg-1",
    delta: "hello",
  };
  const completed = {
    type: "response.completed",
    response: {
      id: "resp-multi-data",
      model: "gpt-test",
      output: [{ type: "message" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  };
  const upstream = new Response(
    [
      `data: ${JSON.stringify(created)}\n\n`,
      splitJsonAcrossDataLines(textDelta),
      `data: ${JSON.stringify(completed)}\n\n`,
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

  const events = await toAnthropicStream(
    await responses.transformResponseOut(upstream),
  );
  assert.equal(
    events.find((event) => event.delta?.type === "text_delta")?.delta.text,
    "hello",
  );
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("malformed multi-data JSON cannot become a synthetic success", async () => {
  const events = await toAnthropicStream(
    new Response('data: {"id":\ndata: not-json}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("a malformed Chat event remains fatal even when a valid terminal follows", async () => {
  const delta = {
    id: "chatcmpl-malformed",
    model: "gpt-test",
    choices: [
      { index: 0, delta: { content: "partial" }, finish_reason: null },
    ],
  };
  const terminal = {
    id: "chatcmpl-malformed",
    model: "gpt-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  const events = await toAnthropicStream(
    new Response(
      [
        `data: ${JSON.stringify(delta)}\n\n`,
        "data: {not-json}\n\n",
        `data: ${JSON.stringify(terminal)}\n\n`,
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );

  assert.equal(events.some((event) => event.type === "error"), true);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("a malformed Responses event remains fatal even when completed follows", async () => {
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const events = await toAnthropicStream(
    await responses.transformResponseOut(
      new Response(
        [
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            item_id: "msg-1",
            content_index: 0,
            delta: "partial",
          })}\n\n`,
          "data: {not-json}\n\n",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp-malformed",
              model: "gpt-test",
              output: [{ type: "message" }],
            },
          })}\n\n`,
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  );

  assert.equal(events.some((event) => event.type === "error"), true);
  assert.equal(events.some((event) => event.type === "message_stop"), false);
});

test("[DONE] stops Chat stream reads without becoming a success terminal", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    },
    cancel() {
      canceled = true;
    },
  });
  const events = await toAnthropicStream(
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
  );

  assert.equal(canceled, true);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
});

test("[DONE] stops Responses stream reads and is forwarded only once", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("data: [DONE]\n\ndata: [DONE]\n\n"),
      );
    },
    cancel() {
      canceled = true;
    },
  });
  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const converted = await responses.transformResponseOut(
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const text = await converted.text();

  assert.equal(canceled, true);
  assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
});
