import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { scrubResponsesReasoningArtifacts } from "../src/utils/strip.js";

const anthropic = new AnthropicTransformer();
const responses = new OpenAIResponsesTransformer();

async function toResponsesInput(messages: unknown[]) {
  const unified = await anthropic.transformRequestOut!({
    model: "claude-test",
    max_tokens: 32,
    messages,
  });
  scrubResponsesReasoningArtifacts(unified as any);
  const result: any = await responses.transformRequestIn!(unified);
  return result.input;
}

test("Responses emits a same-turn tool output before the user follow-up", async () => {
  const input = await toResponsesInput([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: { path: "report.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "tool output",
        },
        { type: "text", text: "continue with this result" },
      ],
    },
  ]);

  assert.deepEqual(input, [
    {
      type: "function_call",
      arguments: '{"path":"report.txt"}',
      name: "read",
      call_id: "call_1",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "tool output",
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "continue with this result" },
      ],
    },
  ]);
});

test("document-only tool result safely falls back to one JSON text block", async () => {
  const document = {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: "JVBERi0=",
    },
    title: "report",
  };
  const input = await toResponsesInput([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_doc", name: "read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_doc",
          content: [document],
        },
      ],
    },
  ]);

  assert.deepEqual(input[1], {
    type: "function_call_output",
    call_id: "call_doc",
    output: [{ type: "input_text", text: JSON.stringify(document) }],
  });
});

test("mixed text and document tool result preserves per-block fallback order", async () => {
  const document = {
    type: "document",
    source: { type: "url", url: "https://example.com/report.pdf" },
  };
  const input = await toResponsesInput([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_doc", name: "read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_doc",
          content: [
            { type: "text", text: "before" },
            document,
            { type: "text", text: "after" },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual(input[1], {
    type: "function_call_output",
    call_id: "call_doc",
    output: [
      { type: "input_text", text: "before" },
      { type: "input_text", text: JSON.stringify(document) },
      { type: "input_text", text: "after" },
    ],
  });
});
