import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerMessagesRoute } from "../src/routes/messages.js";
import {
  loadModelInteractionLogConfig,
  ModelInteractionLogger,
  type ModelInteractionLogConfig,
} from "../src/utils/model-interaction-log.js";

const baseConfig = (
  directory: string,
  overrides: Partial<ModelInteractionLogConfig> = {},
): ModelInteractionLogConfig => ({
  mode: "full",
  directory,
  retentionDays: 7,
  maxBodyBytes: 1024 * 1024,
  cleanupIntervalMs: 0,
  ...overrides,
});

async function withTempDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocr-model-log-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readEntries(directory: string): Promise<any[]> {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
  const entries: any[] = [];
  for (const file of files) {
    const text = await readFile(path.join(directory, file), "utf8");
    entries.push(
      ...text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  return entries;
}

test("model log configuration defaults to full bodies retained for seven days", () => {
  const config = loadModelInteractionLogConfig({}, "/srv/router");
  assert.deepEqual(config, {
    mode: "full",
    directory: "/srv/router/logs",
    retentionDays: 7,
    maxBodyBytes: 1024 * 1024,
  });

  assert.deepEqual(
    loadModelInteractionLogConfig(
      {
        OCR_MODEL_LOG_MODE: "metadata",
        OCR_MODEL_LOG_DIR: "audit",
        OCR_MODEL_LOG_RETENTION_DAYS: "30",
        OCR_MODEL_LOG_MAX_BODY_BYTES: "4194304",
      },
      "/srv/router",
    ),
    {
      mode: "metadata",
      directory: "/srv/router/audit",
      retentionDays: 30,
      maxBodyBytes: 4 * 1024 * 1024,
    },
  );

  assert.throws(
    () =>
      loadModelInteractionLogConfig({ OCR_MODEL_LOG_RETENTION_DAYS: "0" }),
    /integer >= 1/,
  );
  assert.throws(
    () => loadModelInteractionLogConfig({ OCR_MODEL_LOG_MODE: "verbose" }),
    /full, metadata, or off/,
  );
  assert.throws(
    () =>
      loadModelInteractionLogConfig({
        OCR_MODEL_LOG_RETENTION_DAYS: "7.5",
      }),
    /must be an integer/,
  );
});

test("full logs correlate exact JSON bodies without authorization or URL secrets", async () => {
  await withTempDirectory(async (directory) => {
    const logger = new ModelInteractionLogger(
      baseConfig(directory),
      undefined,
      () => new Date("2026-08-01T12:34:56.000Z"),
    );
    await logger.start();

    const requestBody = {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    };
    const exchange = logger.begin(
      {
        requestId: "req-log-json",
        upstreamUrl:
          "https://url-user:url-password@upstream.example.com/v1/chat/completions?api_key=query-secret#fragment-secret",
        format: "chat-completions",
        model: "gpt-test",
        stream: false,
      },
      requestBody,
    );
    const upstreamText = JSON.stringify({
      id: "chatcmpl-log",
      choices: [{ message: { role: "assistant", content: "world" } }],
    });
    const wrapped = logger.captureResponse(
      exchange,
      new Response(upstreamText, {
        status: 200,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer response-header-secret",
          "x-request-id": "upstream-request-id",
        },
      }),
    );

    assert.equal(await wrapped.text(), upstreamText);
    await logger.close();

    const entries = await readEntries(directory);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, "model_request");
    assert.equal(entries[1].event, "model_response");
    assert.equal(entries[0].request_id, entries[1].request_id);
    assert.equal(
      entries[0].upstream_url,
      "https://upstream.example.com/v1/chat/completions",
    );
    assert.deepEqual(entries[0].body, requestBody);
    assert.deepEqual(entries[1].body, JSON.parse(upstreamText));
    assert.deepEqual(entries[1].headers, {
      "content-type": "application/json",
      "x-request-id": "upstream-request-id",
    });
    assert.equal(entries[1].complete, true);

    const rawLog = JSON.stringify(entries);
    assert.doesNotMatch(rawLog, /url-password|query-secret|fragment-secret/);
    assert.doesNotMatch(rawLog, /response-header-secret/);
  });
});

test("stream capture preserves every upstream byte and truncates only the log copy", async () => {
  await withTempDirectory(async (directory) => {
    const logger = new ModelInteractionLogger(
      baseConfig(directory, { maxBodyBytes: 31 }),
      undefined,
      () => new Date("2026-08-01T13:00:00.000Z"),
    );
    await logger.start();
    const exchange = logger.begin(
      {
        requestId: "req-log-stream",
        upstreamUrl: "https://upstream.example.com/v1/responses",
        format: "responses",
        model: "gpt-test",
        stream: true,
      },
      { model: "gpt-test", stream: true, input: "hello" },
    );
    const rawSse = [
      'event: response.output_text.delta\ndata: {"delta":"你"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"好"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ].join("");
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of [rawSse.slice(0, 17), rawSse.slice(17, 53), rawSse.slice(53)]) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    const wrapped = logger.captureResponse(
      exchange,
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
    );

    assert.equal(await wrapped.text(), rawSse);
    await logger.close();
    const responseEntry = (await readEntries(directory)).find(
      (entry) => entry.event === "model_response",
    );
    assert.equal(responseEntry.body_bytes, Buffer.byteLength(rawSse));
    assert.equal(responseEntry.body_truncated, true);
    assert.equal(Buffer.byteLength(responseEntry.body_text), 31);
    assert.equal(responseEntry.complete, true);
  });
});

test("downstream cancellation reaches the upstream body and records an incomplete response", async () => {
  await withTempDirectory(async (directory) => {
    let upstreamCancelled = false;
    const logger = new ModelInteractionLogger(
      baseConfig(directory),
      undefined,
      () => new Date("2026-08-01T14:00:00.000Z"),
    );
    await logger.start();
    const exchange = logger.begin(
      {
        requestId: "req-log-cancel",
        upstreamUrl: "https://upstream.example.com/v1/chat/completions",
        format: "chat-completions",
        model: "gpt-test",
        stream: true,
      },
      { model: "gpt-test", stream: true },
    );
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const wrapped = logger.captureResponse(
      exchange,
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel("test complete");
    await logger.close();

    assert.equal(upstreamCancelled, true);
    const responseEntry = (await readEntries(directory)).find(
      (entry) => entry.event === "model_response",
    );
    assert.equal(responseEntry.complete, false);
    assert.equal(responseEntry.body_truncated, false);
    assert.equal(responseEntry.body_cancelled, true);
    assert.equal(responseEntry.read_error, undefined);
  });
});

test("retention keeps exactly seven UTC date files and ignores unrelated files", async () => {
  await withTempDirectory(async (directory) => {
    for (const name of [
      "model-interactions-2026-07-24.ndjson",
      "model-interactions-2026-07-25.ndjson",
      "model-interactions-2026-07-26.ndjson",
      "model-interactions-2026-07-31.ndjson",
      "model-interactions-2026-08-01.ndjson",
      "keep-me.txt",
    ]) {
      await writeFile(path.join(directory, name), "fixture\n");
    }
    const logger = new ModelInteractionLogger(
      baseConfig(directory),
      undefined,
      () => new Date("2026-08-01T23:59:59.000Z"),
    );
    await logger.start();
    await logger.close();

    assert.deepEqual((await readdir(directory)).sort(), [
      "keep-me.txt",
      "model-interactions-2026-07-26.ndjson",
      "model-interactions-2026-07-31.ndjson",
      "model-interactions-2026-08-01.ndjson",
    ]);
  });
});

test("request and response events rotate independently across UTC midnight", async () => {
  await withTempDirectory(async (directory) => {
    let now = new Date("2026-08-01T23:59:59.900Z");
    const logger = new ModelInteractionLogger(
      baseConfig(directory),
      undefined,
      () => now,
    );
    await logger.start();
    const exchange = logger.begin(
      {
        requestId: "req-log-midnight",
        upstreamUrl: "https://upstream.example.com/v1/chat/completions",
        format: "chat-completions",
        stream: false,
      },
      { model: "gpt-test" },
    );
    const wrapped = logger.captureResponse(
      exchange,
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      }),
    );
    now = new Date("2026-08-02T00:00:00.100Z");
    await wrapped.text();
    await logger.close();

    assert.deepEqual((await readdir(directory)).sort(), [
      "model-interactions-2026-08-01.ndjson",
      "model-interactions-2026-08-02.ndjson",
    ]);
    const entries = await readEntries(directory);
    assert.equal(entries[0].request_id, "req-log-midnight");
    assert.equal(entries[1].request_id, "req-log-midnight");
    assert.equal(entries[1].duration_ms, 200);
  });
});

test("metadata mode omits bodies and off mode creates no log directory", async () => {
  await withTempDirectory(async (parent) => {
    const metadataDirectory = path.join(parent, "metadata");
    const metadataLogger = new ModelInteractionLogger(
      baseConfig(metadataDirectory, { mode: "metadata" }),
      undefined,
      () => new Date("2026-08-01T15:00:00.000Z"),
    );
    await metadataLogger.start();
    const exchange = metadataLogger.begin(
      {
        requestId: "req-log-metadata",
        upstreamUrl: "https://upstream.example.com/v1/chat/completions",
        format: "chat-completions",
        model: "gpt-test",
        stream: false,
      },
      { messages: [{ role: "user", content: "private prompt" }] },
    );
    const wrapped = metadataLogger.captureResponse(
      exchange,
      new Response('{"private":"response"}', {
        headers: { "content-type": "application/json" },
      }),
    );
    await wrapped.text();
    await metadataLogger.close();
    const entries = await readEntries(metadataDirectory);
    assert.equal(entries.length, 2);
    assert.equal(entries.every((entry) => !("body" in entry)), true);
    assert.equal(entries.every((entry) => !("body_text" in entry)), true);

    const offDirectory = path.join(parent, "off");
    const offLogger = new ModelInteractionLogger(
      baseConfig(offDirectory, { mode: "off" }),
    );
    await offLogger.start();
    offLogger.begin(
      {
        requestId: "req-log-off",
        upstreamUrl: "https://upstream.example.com/v1/chat/completions",
        format: "chat-completions",
        stream: false,
      },
      { model: "gpt-test" },
    );
    await offLogger.close();
    await assert.rejects(readdir(offDirectory), /ENOENT/);
  });
});

test("route logs both Chat Completions and Responses protocol boundaries", async () => {
  await withTempDirectory(async (directory) => {
    const originalFetch = globalThis.fetch;
    const outboundBodies: any[] = [];
    globalThis.fetch = (async (input, init) => {
      outboundBodies.push(JSON.parse(String(init?.body)));
      const isResponses = String(input).endsWith("/responses");
      if (isResponses) {
        return new Response(
          JSON.stringify({
            id: "resp_log_test",
            object: "response",
            status: "completed",
            model: "gpt-test",
            output: [
              {
                type: "message",
                id: "msg_log_test",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "responses works",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_log_test",
          object: "chat.completion",
          created: 1,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "chat works" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const previousTokens = process.env.OCR_ACCESS_TOKENS;
    delete process.env.OCR_ACCESS_TOKENS;
    const modelLogger = new ModelInteractionLogger(
      baseConfig(directory),
    );
    const app = Fastify({ logger: false });
    try {
      await modelLogger.start();
      await registerMessagesRoute(app, {
        modelInteractionLogger: modelLogger,
      });
      const payload = {
        model: "claude-test",
        max_tokens: 32,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      };
      const commonHeaders = {
        "x-upstream-authorization": "Bearer must-not-be-logged",
        "x-upstream-model": "gpt-test",
      };

      const chat = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          ...commonHeaders,
          "x-upstream-url":
            "https://upstream.example.com/v1/chat/completions?secret=hidden",
        },
        payload,
      });
      const responses = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          ...commonHeaders,
          "x-upstream-url": "https://upstream.example.com/v1/responses",
          "x-upstream-format": "responses",
        },
        payload,
      });

      assert.equal(chat.statusCode, 200);
      assert.equal(responses.statusCode, 200);
      assert.equal(outboundBodies[0].messages[0].content, "hello");
      assert.equal(Array.isArray(outboundBodies[1].input), true);
      await modelLogger.flush();

      const entries = await readEntries(directory);
      const requests = entries.filter((entry) => entry.event === "model_request");
      const modelResponses = entries.filter(
        (entry) => entry.event === "model_response",
      );
      assert.deepEqual(
        requests.map((entry) => entry.format),
        ["chat-completions", "responses"],
      );
      assert.equal(requests[0].body.messages[0].content, "hello");
      assert.equal(Array.isArray(requests[1].body.input), true);
      assert.equal(modelResponses[0].body.object, "chat.completion");
      assert.equal(modelResponses[1].body.object, "response");
      assert.doesNotMatch(
        JSON.stringify(entries),
        /must-not-be-logged|secret=hidden/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
      await modelLogger.close();
      if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
      else process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  });
});

test("local header validation does not create a phantom model_request", async () => {
  await withTempDirectory(async (directory) => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;
    const previousTokens = process.env.OCR_ACCESS_TOKENS;
    delete process.env.OCR_ACCESS_TOKENS;
    const logger = new ModelInteractionLogger(baseConfig(directory));
    const app = Fastify({ logger: false });
    try {
      await logger.start();
      await registerMessagesRoute(app, { modelInteractionLogger: logger });
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-upstream-url":
            "https://upstream.example.com/v1/chat/completions",
          "x-upstream-authorization": "Bearer placeholder",
          "x-upstream-headers": JSON.stringify({
            authorization: "must-be-rejected",
          }),
        },
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(fetchCount, 0);
      await logger.flush();
      assert.deepEqual(await readEntries(directory), []);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
      await logger.close();
      if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
      else process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  });
});

test("an unwritable log target fails open without changing a successful route", async () => {
  await withTempDirectory(async (parent) => {
    const blockedPath = path.join(parent, "not-a-directory");
    await writeFile(blockedPath, "fixture");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_fail_open",
          object: "chat.completion",
          created: 1,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "still works" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const previousTokens = process.env.OCR_ACCESS_TOKENS;
    delete process.env.OCR_ACCESS_TOKENS;
    const logger = new ModelInteractionLogger(baseConfig(blockedPath));
    const app = Fastify({ logger: false });
    try {
      await logger.start();
      await registerMessagesRoute(app, { modelInteractionLogger: logger });
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-upstream-url":
            "https://upstream.example.com/v1/chat/completions",
          "x-upstream-authorization": "Bearer placeholder",
        },
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as any).content[0].text, "still works");
      await logger.flush();
      assert.equal(await readFile(blockedPath, "utf8"), "fixture");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
      await logger.close();
      if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
      else process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  });
});

test("logged upstream errors keep status, retry header, body, and one-attempt ownership", async () => {
  await withTempDirectory(async (directory) => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ error: { message: "upstream busy" } }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const previousTokens = process.env.OCR_ACCESS_TOKENS;
    delete process.env.OCR_ACCESS_TOKENS;
    const logger = new ModelInteractionLogger(baseConfig(directory));
    const app = Fastify({ logger: false });
    try {
      await logger.start();
      await registerMessagesRoute(app, { modelInteractionLogger: logger });
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-upstream-url":
            "https://upstream.example.com/v1/chat/completions",
          "x-upstream-authorization": "Bearer placeholder",
        },
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      assert.equal(response.statusCode, 429);
      assert.equal(response.headers["x-should-retry"], "true");
      assert.equal(fetchCount, 1);
      await logger.flush();
      const responseEntry = (await readEntries(directory)).find(
        (entry) => entry.event === "model_response",
      );
      assert.equal(responseEntry.status, 429);
      assert.equal(responseEntry.body.error.message, "upstream busy");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
      await logger.close();
      if (previousTokens === undefined) delete process.env.OCR_ACCESS_TOKENS;
      else process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  });
});
