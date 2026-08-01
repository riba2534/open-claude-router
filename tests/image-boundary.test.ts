import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerMessagesRoute } from "../src/routes/messages.js";

async function withRouter(
  handler: (body: any, url: string) => Response,
  run: (app: ReturnType<typeof Fastify>) => Promise<void>,
) {
  const previousTokens = process.env.OCR_ACCESS_TOKENS;
  delete process.env.OCR_ACCESS_TOKENS;
  const originalFetch = globalThis.fetch;
  const app = Fastify({ logger: false });
  await registerMessagesRoute(app);
  globalThis.fetch = (async (input, init) =>
    handler(JSON.parse(String(init?.body)), String(input))) as typeof fetch;
  try {
    await run(app);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousTokens === undefined) {
      delete process.env.OCR_ACCESS_TOKENS;
    } else {
      process.env.OCR_ACCESS_TOKENS = previousTokens;
    }
  }
}

const headers = {
  "x-upstream-url": "https://upstream.example.com/v1/chat/completions",
  "x-upstream-authorization": "Bearer upstream-secret",
};

const okChatResponse = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-ok",
      object: "chat.completion",
      created: 1,
      model: "vision-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("strict Chat endpoint accepts standard top-level image without media_type", async () => {
  let captured: any;
  await withRouter(
    (body) => {
      captured = body;
      const image = body.messages[0].content[0];
      if (
        image.type !== "image_url" ||
        Object.hasOwn(image, "media_type")
      ) {
        return new Response(
          JSON.stringify({
            error: {
              message: "unknown image content parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return okChatResponse();
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers,
        payload: {
          model: "claude-test",
          max_tokens: 8,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AA==",
                  },
                },
                { type: "text", text: "describe" },
              ],
            },
          ],
        },
      });
      assert.equal(response.statusCode, 200);
    },
  );
  assert.deepEqual(captured.messages[0].content[0], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AA==" },
  });
});

test("a text-only model can reject a correctly typed image: upstream owns that 400", async () => {
  await withRouter(
    (body) => {
      assert.equal(body.messages[0].content[0].type, "image_url");
      return new Response(
        JSON.stringify({
          error: {
            message: "selected text-only model does not support image input",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers,
        payload: {
          model: "text-only",
          max_tokens: 8,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: "https://example.com/a.png",
                  },
                },
              ],
            },
          ],
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["x-should-retry"], "true");
      assert.match(response.body, /text-only model/);
    },
  );
});

test("Chat tool image reaches a visual user sidecar instead of a JSON string", async () => {
  await withRouter(
    (body) => {
      const tool = body.messages.find((message: any) => message.role === "tool");
      const sidecar = body.messages.find(
        (message: any) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part: any) => part.type === "image_url"),
      );
      // The tool turn keeps the human-readable text verbatim — never a JSON
      // dump of the image blocks.
      assert.equal(tool.content, "screenshot");
      // Exactly one tool result contributed, so the image stands alone with no
      // provenance marker to disambiguate against.
      assert.deepEqual(sidecar.content, [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ]);
      return okChatResponse();
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers,
        payload: toolImageRequest(),
      });
      assert.equal(response.statusCode, 200);
    },
  );
});

test("Responses function output retains typed tool-result image", async () => {
  await withRouter(
    (body, url) => {
      assert.equal(url, "https://upstream.example.com/v1/chat/completions");
      const output = body.input.find(
        (item: any) => item.type === "function_call_output",
      );
      assert.deepEqual(output.output, [
        { type: "input_text", text: "screenshot" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,AA==",
        },
      ]);
      return new Response(
        JSON.stringify({
          id: "resp-ok",
          object: "response",
          created_at: 1,
          model: "vision-test",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...headers, "x-upstream-format": "responses" },
        payload: toolImageRequest(),
      });
      assert.equal(response.statusCode, 200);
    },
  );
});

function toolImageRequest() {
  return {
    model: "claude-test",
    max_tokens: 8,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "screenshot" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AA==",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
