import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerMessagesRoute } from "../src/routes/messages.js";

const body = {
  model: "claude-test",
  max_tokens: 8,
  messages: [{ role: "user", content: "hello" }],
};

test("ordinary upstream non-2xx statuses are single-attempt and marked retryable", async () => {
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
    const statuses = new Map<number, string>([
      [300, "api_error"],
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [402, "billing_error"],
      [403, "permission_error"],
      [404, "not_found_error"],
      [408, "api_error"],
      [409, "conflict_error"],
      [413, "request_too_large"],
      [422, "api_error"],
      [429, "rate_limit_error"],
      [500, "api_error"],
      [502, "api_error"],
      [504, "timeout_error"],
      [529, "overloaded_error"],
    ]);
    for (const [upstreamStatus, expectedType] of statuses) {
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
      const error = response.json();
      assert.equal(error.type, "error");
      assert.equal(error.request_id, null);
      assert.equal(error.error.type, expectedType);
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
