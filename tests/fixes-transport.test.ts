import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { registerMessagesRoute } from "../src/routes/messages.js";
import { SseBlockDecoder } from "../src/transformers/sse.js";
import type { ApiError } from "../src/transformers/errors.js";
import { buildUpstreamSignal } from "../src/utils/upstream.js";

const requestBody = {
  model: "claude-test",
  max_tokens: 8,
  messages: [{ role: "user", content: "hello" }],
};

const upstreamHeaders = (url: string) => ({
  "x-upstream-url": url,
  "x-upstream-authorization": "Bearer upstream-secret",
});

async function createRouter() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    const apiError = error as ApiError;
    reply.code(apiError.statusCode ?? 500).send({
      type: "error",
      request_id: null,
      error: {
        type: apiError.type ?? "api_error",
        message: error.message,
      },
    });
  });
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  try {
    await registerMessagesRoute(app);
  } finally {
    if (previousTokens === undefined) {
      delete process.env.OCR_ACCESS_TOKENS;
    } else {
      process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  }
  return app;
}

function brokenBody(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    },
  });
}

function parseAnthropicSse(text: string): any[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame.split(/\r?\n/).find((line) => line.startsWith("data: ")),
    )
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)));
}

async function listen(app: Awaited<ReturnType<typeof createRouter>>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`test deadline exceeded after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("real HTTP redirects remain one retryable upstream response", async () => {
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "/must-not-be-followed",
        "content-type": "text/plain",
      });
      res.end("upstream redirect");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "unexpected-follow",
        model: "unexpected",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "redirect followed" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const app = await createRouter();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: upstreamHeaders(
        `http://127.0.0.1:${address.port}/redirect`,
      ),
      payload: requestBody,
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers["x-should-retry"], "true");
    assert.deepEqual(requests, ["POST /redirect"]);
    assert.equal((response.json() as any).type, "error");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a broken non-2xx body keeps its status and retry header", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(brokenBody("error body broke"), {
      status: 503,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const app = await createRouter();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: upstreamHeaders("https://upstream.example.com/v1/messages"),
      payload: requestBody,
    });

    assert.equal(fetchCount, 1);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["x-should-retry"], "true");
    const error = response.json() as any;
    assert.equal(error.type, "error");
    assert.equal(error.error.type, "api_error");
    assert.match(error.error.message, /response body could not be read/);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("stream:false maps a transport reader failure to upstream 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(brokenBody("wire broke"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

  const app = await createRouter();
  try {
    for (const format of ["chat-completions", "responses"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          ...upstreamHeaders("https://upstream.example.com/v1/messages"),
          "x-upstream-format": format,
        },
        payload: { ...requestBody, stream: false },
      });

      assert.equal(response.statusCode, 502, format);
      assert.equal(response.headers["x-should-retry"], undefined, format);
      assert.deepEqual(
        response.json(),
        {
          type: "error",
          request_id: null,
          error: {
            type: "api_error",
            message: "upstream stream transport failed",
          },
        },
        format,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("stream:true maps a transport reader failure to Anthropic SSE error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(brokenBody("wire broke"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

  const app = await createRouter();
  try {
    for (const format of ["chat-completions", "responses"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          ...upstreamHeaders("https://upstream.example.com/v1/messages"),
          "x-upstream-format": format,
        },
        payload: { ...requestBody, stream: true },
      });

      assert.equal(response.statusCode, 200, format);
      assert.match(
        String(response.headers["content-type"]),
        /text\/event-stream/,
        format,
      );
      assert.match(response.body, /event: error/, format);
      const dataLine = response.body
        .split("\n")
        .find((line) => line.startsWith("data: "));
      assert.ok(dataLine, format);
      assert.deepEqual(
        JSON.parse(dataLine.slice(6)),
        {
          type: "error",
          request_id: null,
          error: {
            type: "api_error",
            message: "upstream stream transport failed",
          },
        },
        format,
      );
      assert.doesNotMatch(
        response.body,
        /FST_ERR_REP_INVALID_PAYLOAD_TYPE/,
        format,
      );
      assert.doesNotMatch(response.body, /message_stop/, format);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("many data lines cannot bypass the complete SSE event bound", () => {
  const decoder = new SseBlockDecoder();
  const wire = new TextEncoder().encode("data: x\n".repeat(65_537));

  assert.throws(
    () => decoder.push(wire),
    /SSE event exceeded .* characters or 65536 lines/,
  );
});

test("JSON content_filter becomes an in-progress start and terminal refusal SSE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-filtered",
        object: "chat.completion",
        model: "safe-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Filtered response.",
            },
            finish_reason: "content_filter",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const app = await createRouter();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: upstreamHeaders("https://upstream.example.com/v1/messages"),
      payload: { ...requestBody, stream: true },
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
    const events = parseAnthropicSse(response.body);
    const start = events.find((event) => event.type === "message_start");
    assert.equal(start?.message.stop_reason, null);
    assert.equal(start?.message.stop_details, null);
    const terminal = events.find((event) => event.type === "message_delta");
    assert.equal(terminal?.delta.stop_reason, "refusal");
    assert.deepEqual(terminal?.delta.stop_details, {
      type: "refusal",
      category: null,
      explanation: null,
    });
    assert.equal(events.at(-1)?.type, "message_stop");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("SSE refusal stop_details survive aggregation to stream:false JSON", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    {
      id: "chatcmpl-refusal",
      model: "safe-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", refusal: "Cannot help." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-refusal",
      model: "safe-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    },
  ];
  globalThis.fetch = (async () =>
    new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;

  const app = await createRouter();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: upstreamHeaders("https://upstream.example.com/v1/messages"),
      payload: { ...requestBody, stream: false },
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /application\/json/);
    const message = response.json() as any;
    assert.equal(message.stop_reason, "refusal");
    assert.deepEqual(message.stop_details, {
      type: "refusal",
      category: null,
      explanation: "Cannot help.",
    });
    assert.deepEqual(message.content, [
      { type: "text", text: "Cannot help." },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("a real downstream socket disconnect aborts the in-flight upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  let markAborted!: (reason: string) => void;
  const upstreamAborted = new Promise<string>((resolve) => {
    markAborted = resolve;
  });

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    markFetchStarted();
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        const reason = signal.reason;
        markAborted(reason instanceof Error ? reason.message : String(reason));
        reject(reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;

  const app = await createRouter();
  const port = await listen(app);
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    const payload = JSON.stringify(requestBody);
    client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/messages",
      headers: {
        ...upstreamHeaders("https://upstream.example.com/v1/messages"),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    // Destroying a request intentionally reports a socket error locally.
    client.on("error", () => {});
    client.end(payload);

    await withDeadline(fetchStarted);
    client.destroy();

    assert.equal(await withDeadline(upstreamAborted), "client disconnected");
  } finally {
    client?.destroy();
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("upstream timeout survives request-body completion and is cleaned on reply finish", async () => {
  const app = Fastify({ logger: false });
  let timeoutSignal: AbortSignal | undefined;
  let completedSignal: AbortSignal | undefined;

  app.post("/timeout", async (req, reply) => {
    timeoutSignal = buildUpstreamSignal(req, reply, 40);
    await new Promise<void>((resolve) =>
      timeoutSignal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    const reason = timeoutSignal.reason;
    return {
      reason: reason instanceof Error ? reason.message : String(reason),
    };
  });
  app.post("/complete", async (req, reply) => {
    completedSignal = buildUpstreamSignal(req, reply, 40);
    return { ok: true };
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    const timed = await withDeadline(
      originalFetchForLocalTest(
        `http://127.0.0.1:${address.port}/timeout`,
        { method: "POST", body: "body-complete" },
      ),
    );
    assert.equal(timed.status, 200);
    assert.deepEqual(await timed.json(), { reason: "upstream timeout" });
    assert.equal(timeoutSignal?.aborted, true);

    const completed = await withDeadline(
      originalFetchForLocalTest(
        `http://127.0.0.1:${address.port}/complete`,
        { method: "POST", body: "body-complete" },
      ),
    );
    assert.equal(completed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(completedSignal?.aborted, false);
  } finally {
    await app.close();
  }
});

// Keep a stable reference even though other transport tests temporarily mock
// globalThis.fetch.
const originalFetchForLocalTest = globalThis.fetch.bind(globalThis);
