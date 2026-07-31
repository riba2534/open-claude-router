import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import type {
  AnthropicEffort,
  UnifiedChatRequest,
} from "../src/types/llm.js";

const anthropic = new AnthropicTransformer();
const responses = new OpenAIResponsesTransformer();

const efforts: AnthropicEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const thinkingCases = [
  { name: "absent", thinking: undefined, requestsOutput: false },
  {
    name: "disabled",
    thinking: { type: "disabled" },
    requestsOutput: false,
  },
  {
    name: "enabled",
    thinking: { type: "enabled", budget_tokens: 16384 },
    requestsOutput: true,
  },
  {
    name: "adaptive",
    thinking: { type: "adaptive" },
    requestsOutput: true,
  },
] as const;

function anthropicRequest(
  effort: unknown,
  thinking?: Record<string, unknown>,
) {
  return {
    model: "test-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort },
    ...(thinking ? { thinking } : {}),
  };
}

async function toResponses(unified: UnifiedChatRequest): Promise<any> {
  return responses.transformRequestIn!(structuredClone(unified)) as Promise<any>;
}

test("maps every formal effort across all thinking modes", async () => {
  for (const effort of efforts) {
    for (const thinkingCase of thinkingCases) {
      const unified = await anthropic.transformRequestOut!(
        anthropicRequest(effort, thinkingCase.thinking),
      );

      assert.equal(
        unified.reasoning_effort,
        effort,
        `${effort}/${thinkingCase.name}: Chat reasoning_effort`,
      );
      assert.equal(
        unified.reasoning?.enabled,
        thinkingCase.requestsOutput ? true : undefined,
        `${effort}/${thinkingCase.name}: reasoning output flag`,
      );
      if (thinkingCase.requestsOutput) {
        assert.equal(
          unified.reasoning?.effort,
          effort,
          `${effort}/${thinkingCase.name}: explicit effort beats derived effort`,
        );
      }

      const result = await toResponses(unified);
      assert.equal(
        Object.prototype.hasOwnProperty.call(result, "reasoning_effort"),
        false,
        `${effort}/${thinkingCase.name}: Responses strips Chat field`,
      );
      assert.equal(
        result.reasoning?.effort,
        effort,
        `${effort}/${thinkingCase.name}: Responses reasoning.effort`,
      );
      assert.equal(
        result.reasoning?.summary,
        thinkingCase.requestsOutput ? "detailed" : undefined,
        `${effort}/${thinkingCase.name}: summary gating`,
      );
      assert.deepEqual(
        result.include,
        thinkingCase.requestsOutput
          ? ["reasoning.encrypted_content"]
          : undefined,
        `${effort}/${thinkingCase.name}: encrypted-content gating`,
      );
    }
  }
});

test("rejects non-Anthropic effort values", async () => {
  const invalidValues = [
    undefined,
    null,
    "",
    "none",
    "minimal",
    "LOW",
    " high ",
    0,
    true,
    {},
  ];

  for (const effort of invalidValues) {
    const unified = await anthropic.transformRequestOut!(
      anthropicRequest(effort),
    );
    assert.equal(unified.reasoning_effort, undefined, String(effort));

    const result = await toResponses(unified);
    assert.equal(result.reasoning, undefined, String(effort));
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "reasoning_effort"),
      false,
      String(effort),
    );
    assert.equal(result.include, undefined, String(effort));
  }
});

test("invalid explicit effort does not replace thinking budget derivation", async () => {
  const unified = await anthropic.transformRequestOut!(
    anthropicRequest("minimal", {
      type: "enabled",
      budget_tokens: 4096,
    }),
  );
  assert.equal(unified.reasoning_effort, undefined);
  assert.deepEqual(unified.reasoning, {
    effort: "medium",
    enabled: true,
  });

  const result = await toResponses(unified);
  assert.deepEqual(result.reasoning, {
    effort: "medium",
    summary: "detailed",
  });
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
});

test("Responses prefers and removes explicit Chat reasoning_effort", async () => {
  const result = await toResponses({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "xhigh",
    reasoning: {
      effort: "low",
      enabled: true,
    },
  });

  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "reasoning_effort"),
    false,
  );
  assert.deepEqual(result.reasoning, {
    effort: "xhigh",
    summary: "detailed",
  });
  assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
});
