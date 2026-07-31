import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerMessagesRoute } from "../src/routes/messages.js";

const body = {
  model: "claude-test",
  max_tokens: 8,
  messages: [{ role: "user", content: "hello" }],
};

test("every upstream non-2xx is single-attempt and marked retryable", async () => {
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const app = Fastify({ logger: false });
  await registerMessagesRoute(app);

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let status = 500;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ error: { message: `upstream ${status}` } }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const statuses = [
      300, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 504, 529,
    ];
    for (const upstreamStatus of statuses) {
      status = upstreamStatus;
      const before = fetchCount;
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-upstream-url":
            "https://upstream.example.com/v1/chat/completions",
          "x-upstream-authorization": "Bearer upstream-secret",
        },
        payload: body,
      });
      assert.equal(response.statusCode, upstreamStatus);
      assert.equal(response.headers["x-should-retry"], "true");
      assert.equal(fetchCount, before + 1);
      assert.equal(response.json().type, "error");
    }

    status = 503;
    const embedded = await app.inject({
      method: "POST",
      url:
        "/https://upstream.example.com/v1/chat/completions/v1/messages",
      headers: { authorization: "Bearer upstream-secret" },
      payload: body,
    });
    assert.equal(embedded.statusCode, 503);
    assert.equal(embedded.headers["x-should-retry"], "true");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) {
      delete process.env.OCR_ACCESS_TOKENS;
    } else {
      process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  }
});

test("success and local validation errors are not marked retryable", async () => {
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const app = Fastify({ logger: false });
  await registerMessagesRoute(app);

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-ok",
        object: "chat.completion",
        created: 1,
        model: "upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const success = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-upstream-url":
          "https://upstream.example.com/v1/chat/completions",
        "x-upstream-authorization": "Bearer upstream-secret",
      },
      payload: body,
    });
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers["x-should-retry"], undefined);
    assert.equal(fetchCount, 1);

    const localError = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: body,
    });
    assert.equal(localError.statusCode, 400);
    assert.equal(localError.headers["x-should-retry"], undefined);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) {
      delete process.env.OCR_ACCESS_TOKENS;
    } else {
      process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  }
});
