import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { formatBase64 } from "../src/transformers/image.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import {
  normalizeMultimodalToolResultsForChatCompletions,
  scrubAnthropicOnlyFields,
  scrubResponsesReasoningArtifacts,
} from "../src/utils/strip.js";

const anthropic = new AnthropicTransformer();
const responses = new OpenAIResponsesTransformer();

test("top-level base64 and URL images use standard OpenAI image parts", async () => {
  const result = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "base64AA",
            },
          },
          { type: "text", text: "describe" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/image.png" },
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.messages[0].content, [
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,base64AA" },
    },
    { type: "text", text: "describe" },
    {
      type: "image_url",
      image_url: { url: "https://example.com/image.png" },
    },
  ]);
  assert.equal(
    Object.hasOwn((result.messages[0].content as any[])[0], "media_type"),
    false,
  );
  assert.equal(
    formatBase64("data:image/jpeg;base64,AA==", "image/png"),
    "data:image/jpeg;base64,AA==",
  );
});

test("tool_result preserves mixed text, images, unknown blocks, and empty content", async () => {
  const result = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 32,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "tool_use", id: "call_2", name: "read", input: {} },
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
              { type: "future_block", value: 7 },
            ],
          },
          { type: "tool_result", tool_use_id: "call_2" },
        ],
      },
    ],
  });

  assert.deepEqual(result.messages[1], {
    role: "tool",
    tool_call_id: "call_1",
    content: [
      { type: "text", text: "screenshot" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA==" },
      },
      { type: "text", text: '{"type":"future_block","value":7}' },
    ],
  });
  assert.equal(result.messages[2].content, "");
});

test("string tool_result remains a string", async () => {
  const result = await anthropic.transformRequestOut!({
    model: "claude-test",
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
            content: "plain result",
          },
        ],
      },
    ],
  });
  assert.equal(result.messages[1].content, "plain result");
});

test("Chat tool results keep legal text messages and expose images in a user sidecar", async () => {
  const body: Record<string, unknown> = {
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "one" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/b.png" } },
        ],
      },
      { role: "user", content: "continue" },
    ],
  };

  normalizeMultimodalToolResultsForChatCompletions(body);
  assert.deepEqual(body.messages, [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "one" }],
    },
    { role: "tool", tool_call_id: "call_2", content: "" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        { type: "image_url", image_url: { url: "https://example.com/b.png" } },
        { type: "text", text: "continue" },
      ],
    },
  ]);
});

test("Responses preserves structured function output and assistant text plus calls", async () => {
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 64,
    temperature: 0.4,
    top_p: 0.8,
    stop_sequences: ["END"],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { path: "a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "result" },
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
    ],
  });
  scrubResponsesReasoningArtifacts(unified as any);
  const result: any = await responses.transformRequestIn!(unified);

  assert.equal(result.max_output_tokens, 64);
  assert.equal(result.temperature, 0.4);
  assert.equal(result.top_p, 0.8);
  assert.equal(Object.hasOwn(result, "stop"), false);
  assert.equal(result.parallel_tool_calls, false);
  assert.deepEqual(result.input, [
    { role: "assistant", content: "I will inspect it." },
    {
      type: "function_call",
      arguments: '{"path":"a.png"}',
      name: "read",
      call_id: "call_1",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "result" },
        { type: "input_image", image_url: "https://example.com/a.png" },
      ],
    },
  ]);
});

test("Responses treats tool names generically and rejects native signatures", async () => {
  const request: any = {
    model: "gpt-test",
    messages: [
      {
        role: "assistant",
        content: "",
        thinking: {
          content: "private",
          signature: "ErNativeClaudeSignatureOpaque",
        },
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Edit", arguments: "{}" },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "ordinary user function",
          parameters: {
            type: "object",
            properties: {
              cache_control: { type: "string" },
              reasoning: { type: "string" },
              allowed_domains: { type: "array" },
            },
          },
        },
      },
    ],
  };
  scrubAnthropicOnlyFields(request);
  const result: any = await responses.transformRequestIn!(request);

  assert.equal(
    result.input.some((item: any) => item.type === "reasoning"),
    false,
  );
  assert.deepEqual(result.tools[0], {
    type: "function",
    name: "web_search",
    description: "ordinary user function",
    parameters: {
      type: "object",
      properties: {
        cache_control: { type: "string" },
        reasoning: { type: "string" },
        allowed_domains: { type: "array" },
      },
    },
  });
});

test("Responses replays only Router-wrapped reasoning with its required ID", async () => {
  const signature =
    "ocr-responses-reasoning-v1:" +
    Buffer.from(
      JSON.stringify({
        id: "rs_1",
        encrypted_content: "encrypted-state",
      }),
    ).toString("base64url");
  const result: any = await responses.transformRequestIn!({
    model: "gpt-test",
    messages: [
      {
        role: "assistant",
        content: "",
        thinking: { content: "", signature },
      },
    ],
  });
  assert.deepEqual(result.input[0], {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "encrypted-state",
    summary: [],
  });
});

test("disabled thinking emits no Responses reasoning request", async () => {
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "disabled" },
  });
  assert.equal(unified.reasoning, undefined);
});

test("enabled thinking requests replayable encrypted Responses reasoning", async () => {
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  const result: any = await responses.transformRequestIn!(unified);
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
});
