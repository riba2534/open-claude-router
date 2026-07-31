import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { normalizeMultimodalToolResultsForChatCompletions } from "../src/utils/strip.js";

const logger = {
  debug() {},
  info() {},
  error() {},
  warn() {},
};

function transformer() {
  const value = new AnthropicTransformer();
  value.logger = logger;
  return value;
}

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function parseAnthropicSse(text: string): any[] {
  return text
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line!.slice(6)));
}

async function toAnthropicStream(response: Response): Promise<any[]> {
  const converted = await transformer().transformResponseIn!(response, {
    req: { id: "anthropic-fix-test" },
  } as any);
  return parseAnthropicSse(await converted.text());
}

test("invalid message roles/content and thinking budgets fail locally with 400", async () => {
  const invalidRequests = [
    { messages: [{ role: "developer", content: "not allowed here" }] },
    { messages: [{ role: "user", content: null }] },
    { messages: [{ role: "user", content: 7 }] },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 0 },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024.5 },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", budget_tokens: 2048 },
    },
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      transformer().transformRequestOut!(request),
      (error: any) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.type, "invalid_request_error");
        return true;
      },
    );
  }

  const valid = await transformer().transformRequestOut!({
    model: "claude-test",
    // Interleaved thinking is the formal exception where the turn-wide
    // budget may exceed this per-response output cap.
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 16384 },
  });
  assert.deepEqual(valid.reasoning, { effort: "high", enabled: true });
});

test("Claude Code system-role compatibility messages preserve order and blocks", async () => {
  const result = await transformer().transformRequestOut!({
    model: "openai/test-model",
    messages: [
      { role: "user", content: "create a title" },
      {
        role: "system",
        content: [
          { type: "text", text: "Return JSON only" },
          { type: "future_system_instruction", value: "preserve me" },
        ],
      },
    ],
  });

  assert.deepEqual(result.messages.map((message) => message.role), [
    "user",
    "system",
  ]);
  assert.deepEqual(result.messages[1].content, [
    { type: "text", text: "Return JSON only" },
    {
      type: "text",
      text: JSON.stringify({
        type: "future_system_instruction",
        value: "preserve me",
      }),
    },
  ]);
});

test("mid-conversation tool changes project the final active set for Chat and Responses", async () => {
  const unified = await transformer().transformRequestOut!({
    model: "openai/test-model",
    tools: [
      { name: "always_on", input_schema: { type: "object" } },
      {
        name: "deferred_then_added",
        defer_loading: true,
        input_schema: { type: "object" },
      },
      { name: "removed", input_schema: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "continue" },
      {
        role: "system",
        content: [
          { type: "text", text: "Use the newly available tool if needed" },
          {
            type: "mid_conv_system",
            content: [
              { type: "text", text: "This text came through the wrapper" },
              {
                type: "tool_addition",
                tool: {
                  type: "tool_reference",
                  name: "deferred_then_added",
                },
              },
            ],
          },
          {
            type: "tool_removal",
            tool: { type: "tool_reference", name: "removed" },
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    unified.tools?.map((tool) => tool.function.name),
    ["always_on", "deferred_then_added"],
  );
  assert.deepEqual(unified.messages, [
    { role: "user", content: "continue" },
    {
      role: "system",
      content: [
        { type: "text", text: "Use the newly available tool if needed" },
        { type: "text", text: "This text came through the wrapper" },
      ],
    },
  ]);

  const responses = new OpenAIResponsesTransformer();
  responses.logger = logger;
  const responseRequest = await responses.transformRequestIn!(
    structuredClone(unified),
  );
  assert.deepEqual(
    responseRequest.tools?.map((tool: any) => tool.name),
    ["always_on", "deferred_then_added"],
  );
  assert.deepEqual((responseRequest as any).input, [
    { role: "user", content: "continue" },
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text: "Use the newly available tool if needed",
        },
        {
          type: "input_text",
          text: "This text came through the wrapper",
        },
      ],
    },
  ]);
});

test("invalid or unsupported mid-conversation tool references fail explicitly", async () => {
  const invalidReferences = [
    { type: "tool_reference", name: "missing" },
    { type: "mcp_tool_reference", server_name: "server", name: "remote" },
  ];
  for (const tool of invalidReferences) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{ name: "declared", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "continue" },
          {
            role: "system",
            content: [{ type: "tool_addition", tool }],
          },
        ],
      }),
      (error: any) => error?.statusCode === 400,
    );
  }

  for (const content of [
    { type: "mid_conv_system", content: "not-an-array" },
    {
      type: "mid_conv_system",
      content: [{ type: "mid_conv_system", content: [] }],
    },
  ]) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        messages: [
          { role: "user", content: "continue" },
          { role: "system", content: [content] },
        ],
      }),
      (error: any) => error?.statusCode === 400,
    );
  }

  for (const role of ["user", "assistant"]) {
    for (const type of ["tool_addition", "tool_removal"]) {
      await assert.rejects(
        () => transformer().transformRequestOut!({
          model: "openai/test-model",
          tools: [{ name: "declared", input_schema: { type: "object" } }],
          messages: [{
            role,
            content: [{
              type,
              tool: { type: "tool_reference", name: "declared" },
            }],
          }],
        }),
        (error: any) => error?.statusCode === 400,
      );
    }
  }
});

test("tool_result references activate deferred tools and disappear from visible output", async () => {
  const unified = await transformer().transformRequestOut!({
    model: "openai/test-model",
    tools: [
      { name: "search", input_schema: { type: "object" } },
      {
        name: "weather",
        defer_loading: true,
        input_schema: { type: "object" },
      },
    ],
    tool_choice: { type: "tool", name: "weather" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_search", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_search",
            content: [
              { type: "tool_reference", tool_name: "weather" },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    unified.tools?.map((tool) => tool.function.name),
    ["search", "weather"],
  );
  assert.deepEqual(unified.messages[1], {
    role: "tool",
    tool_call_id: "call_search",
    content: "",
  });
  assert.deepEqual(unified.tool_choice, {
    type: "function",
    function: { name: "weather" },
  });

  await assert.rejects(
    () => transformer().transformRequestOut!({
      model: "openai/test-model",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: [
                { type: "tool_reference", tool_name: "missing" },
              ],
            },
          ],
        },
      ],
    }),
    (error: any) => error?.statusCode === 400,
  );
});

test("tool choice cannot require an inactive or empty tool set", async () => {
  const choices = [
    { type: "any" },
    { type: "tool", name: "removed" },
  ];
  for (const tool_choice of choices) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{ name: "removed", input_schema: { type: "object" } }],
        tool_choice,
        messages: [
          { role: "user", content: "continue" },
          {
            role: "system",
            content: [
              {
                type: "tool_removal",
                tool: { type: "tool_reference", name: "removed" },
              },
            ],
          },
        ],
      }),
      (error: any) => error?.statusCode === 400,
    );
  }
});

test("server-owned tools are rejected instead of becoming client functions", async () => {
  const serverToolTypes = [
    "tool_search_tool_regex",
    "tool_search_tool_bm25_20251119",
    "web_search_20260318",
    "web_fetch_20260318",
    "code_execution_20260521",
    "advisor_20260301",
    "mcp_toolset",
  ];
  for (const type of serverToolTypes) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{ type, name: `server_${type}` }],
        messages: [{ role: "user", content: "run a server tool" }],
      }),
      (error: any) =>
        error?.statusCode === 400 &&
        /server-side tools/.test(error.message),
    );
  }

  for (const type of [
    "server_tool_use",
    "tool_search_tool_result",
    "advisor_tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
  ]) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        messages: [{
          role: "assistant",
          content: [{
            type,
            id: "srvtoolu_history",
            tool_use_id: "srvtoolu_history",
            content: {},
          }],
        }],
      }),
      (error: any) =>
        error?.statusCode === 400 &&
        /server-tool history/.test(error.message),
    );
  }
});

test("typed Anthropic client tools are rejected instead of getting empty schemas", async () => {
  for (const type of [
    "bash_20250124",
    "computer_20251124",
    "memory_20250818",
    "text_editor_20250728",
  ]) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{ type, name: `client_${type}` }],
        messages: [{ role: "user", content: "use the client tool" }],
      }),
      (error: any) =>
        error?.statusCode === 400 &&
        /version-specific OpenAI function schema/.test(error.message),
    );
  }
});

test("opaque Anthropic control blocks never become model-visible JSON", async () => {
  const blocks = [
    {
      type: "compaction",
      content: "summary",
      encrypted_content: "opaque-do-not-expose",
    },
    {
      type: "fallback",
      from: { model: "model-a" },
      to: { model: "model-b" },
      trigger: { type: "refusal" },
    },
    { type: "container_upload", file_id: "file_provider_specific" },
  ];
  for (const block of blocks) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        messages: [{ role: "assistant", content: [block] }],
      }),
      (error: any) =>
        error?.statusCode === 400 && /replay-safe OpenAI/.test(error.message),
    );
  }
});

test("client tool names cannot be silently empty", async () => {
  await assert.rejects(
    () => transformer().transformRequestOut!({
      model: "openai/test-model",
      tools: [{ name: "", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "continue" }],
    }),
    (error: any) => error?.statusCode === 400 && /non-empty/.test(error.message),
  );

  const directOnly = await transformer().transformRequestOut!({
    model: "openai/test-model",
    tools: [{
      name: "direct_only",
      allowed_callers: ["direct"],
      input_schema: { type: "object" },
    }],
    messages: [{ role: "user", content: "continue" }],
  });
  assert.equal(directOnly.tools?.[0].function.name, "direct_only");

  for (const allowed_callers of [
    ["code_execution_20260521"],
    ["direct", "code_execution_20260120"],
    ["future_caller"],
    [],
    "direct",
  ]) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{
          name: "restricted",
          allowed_callers,
          input_schema: { type: "object" },
        }],
        messages: [{ role: "user", content: "continue" }],
      }),
      (error: any) => error?.statusCode === 400,
    );
  }
});

test("known tool history blocks validate role and required fields", async () => {
  const directHistory = await transformer().transformRequestOut!({
    model: "openai/test-model",
    messages: [{
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "call_direct",
        name: "run",
        input: {},
        caller: { type: "direct" },
      }],
    }],
  });
  assert.equal(directHistory.messages[0].tool_calls?.[0].function.name, "run");

  const invalidMessages = [
    [{ role: "assistant", content: [{
      type: "tool_use", id: "", name: "run", input: {},
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_use", id: "call", name: "", input: {},
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_use", id: "call", name: "run", input: "bad",
    }] }],
    [{ role: "user", content: [{
      type: "tool_use", id: "call", name: "run", input: {},
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_use",
      id: "call",
      name: "run",
      input: {},
      caller: { type: "code_execution_20260120", tool_id: "srvtoolu_1" },
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_use",
      id: "call",
      name: "run",
      input: {},
      caller: { type: "future_caller" },
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_use",
      id: "call",
      name: "run",
      input: {},
      caller: "direct",
    }] }],
    [{ role: "user", content: [{
      type: "tool_result", tool_use_id: "", content: "bad",
    }] }],
    [{ role: "assistant", content: [{
      type: "tool_result", tool_use_id: "call", content: "bad",
    }] }],
    [{ role: "user", content: [{
      type: "tool_result",
      tool_use_id: "call",
      content: "bad",
      is_error: "true",
    }] }],
  ];
  for (const messages of invalidMessages) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        messages,
      }),
      (error: any) => error?.statusCode === 400,
    );
  }
});

test("deferred tools and manual thinking constraints follow Anthropic request rules", async () => {
  await assert.rejects(
    () => transformer().transformRequestOut!({
      model: "openai/test-model",
      tools: [{
        name: "only_deferred",
        defer_loading: true,
        input_schema: { type: "object" },
      }],
      messages: [{ role: "user", content: "continue" }],
    }),
    (error: any) =>
      error?.statusCode === 400 && /at least one tool/.test(error.message),
  );

  await assert.rejects(
    () => transformer().transformRequestOut!({
      model: "openai/test-model",
      tools: [{
        name: "bad_deferred_flag",
        defer_loading: "true",
        input_schema: { type: "object" },
      }],
      messages: [{ role: "user", content: "continue" }],
    }),
    (error: any) =>
      error?.statusCode === 400 && /must be a boolean/.test(error.message),
  );

  for (const tool_choice of [
    { type: "any" },
    { type: "tool", name: "weather" },
  ]) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        thinking: { type: "enabled", budget_tokens: 1024 },
        tools: [{ name: "weather", input_schema: { type: "object" } }],
        tool_choice,
        messages: [{ role: "user", content: "continue" }],
      }),
      (error: any) =>
        error?.statusCode === 400 && /forced tool_choice/.test(error.message),
    );
  }

  const adaptive = await transformer().transformRequestOut!({
    model: "openai/test-model",
    thinking: { type: "adaptive" },
    tools: [
      {
        name: "deferred",
        defer_loading: true,
        input_schema: { type: "object" },
      },
      { name: "weather", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "continue" }],
  });
  assert.equal(adaptive.tool_choice, "required");
  assert.deepEqual(adaptive.tools?.map((tool) => tool.function.name), [
    "weather",
  ]);
});

test("tool_choice validates Anthropic shape before conversion", async () => {
  const invalidChoices = [
    "required",
    { type: "required" },
    { type: "tool", name: "" },
    { type: "auto", disable_parallel_tool_use: "true" },
    { type: "none", disable_parallel_tool_use: false },
  ];
  for (const tool_choice of invalidChoices) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        tools: [{ name: "weather", input_schema: { type: "object" } }],
        tool_choice,
        messages: [{ role: "user", content: "continue" }],
      }),
      (error: any) => error?.statusCode === 400,
    );
  }
});

test("mid-conversation system placement follows Anthropic ordering rules", async () => {
  const invalidMessageLists = [
    [{ role: "system", content: "not first" }],
    [
      { role: "assistant", content: "done" },
      { role: "system", content: "not after ordinary assistant" },
    ],
    [
      { role: "user", content: "one" },
      { role: "system", content: "update" },
      { role: "user", content: "must be assistant or end" },
    ],
    [
      {
        role: "assistant",
        content: [{
          type: "totally_fake_tool_result",
          tool_use_id: "srvtoolu_fake",
        }],
      },
      { role: "system", content: "a suffix is not a server result" },
    ],
  ];
  for (const messages of invalidMessageLists) {
    await assert.rejects(
      () => transformer().transformRequestOut!({
        model: "openai/test-model",
        messages,
      }),
      (error: any) => error?.statusCode === 400,
    );
  }

  const validMessageLists = [[
    { role: "user", content: "one" },
    { role: "system", content: "first update" },
    { role: "system", content: "second update" },
    { role: "assistant", content: "acknowledged" },
  ]];
  for (const messages of validMessageLists) {
    const result = await transformer().transformRequestOut!({
      model: "openai/test-model",
      messages,
    });
    assert.ok(result.messages.some((message) => message.role === "system"));
  }
});

test("future system blocks use a bounded, non-empty text fallback", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    system: [
      { type: "future_instruction", payload: "keep this" },
      { type: "large_future", payload: "x".repeat(10_000) },
    ],
  });
  const content = result.messages[0].content as any[];
  assert.equal(content.length, 2);
  assert.match(content[0].text, /future_instruction/);
  assert.match(content[0].text, /keep this/);
  assert.match(content[1].text, /unsupported large_future block omitted/);
  assert.ok(content[1].text.length < 200);
});

test("empty string and empty array content preserve their message turn", async () => {
  for (const message of [
    { role: "user", content: "" },
    { role: "user", content: [] },
    { role: "assistant", content: [] },
  ]) {
    const result = await transformer().transformRequestOut!({
      model: "claude-test",
      messages: [message],
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, message.role);
    assert.equal(result.messages[0].content, "");
  }
});

test("unknown assistant blocks degrade safely and redacted thinking is rejected", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible" },
          { type: "future_assistant_block", value: "preserve-me" },
        ],
      },
    ],
  });

  const content = String(result.messages[0].content);
  assert.match(content, /^visible\n/);
  assert.match(content, /future_assistant_block/);
  assert.match(content, /preserve-me/);
  await assert.rejects(
    transformer().transformRequestOut!({
      model: "claude-test",
      messages: [{
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque-secret-state" }],
      }],
    }),
    (error: any) =>
      error.statusCode === 400 && /redacted_thinking/.test(error.message),
  );
});

test("documents retain a typed unified file envelope and Chat degrades only URL files", async () => {
  const unified = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            title: "report.pdf",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "UERG",
            },
          },
          {
            type: "document",
            title: "remote.pdf",
            source: { type: "url", url: "https://example.com/report.pdf" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "read result" },
              {
                type: "document",
                title: "tool.txt",
                source: { type: "text", media_type: "text/plain", data: "abc" },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual((unified.messages[0].content as any[])[0], {
    type: "file",
    file: {
      file_data: "data:application/pdf;base64,UERG",
      filename: "report.pdf",
    },
    fallback_text: '[document "report.pdf": application/pdf, 4 base64 chars]',
  });
  assert.deepEqual((unified.messages[0].content as any[])[1], {
    type: "file",
    file: {
      file_url: "https://example.com/report.pdf",
      filename: "remote.pdf",
    },
    fallback_text: '[document "remote.pdf": https://example.com/report.pdf]',
  });
  assert.equal((unified.messages[2].content as any[])[1].type, "file");

  const chat = structuredClone(unified) as any;
  normalizeMultimodalToolResultsForChatCompletions(chat);
  assert.deepEqual(chat.messages[0].content, [
    {
      type: "file",
      file: {
        file_data: "data:application/pdf;base64,UERG",
        filename: "report.pdf",
      },
    },
    {
      type: "text",
      text: '[document "remote.pdf": https://example.com/report.pdf]',
    },
  ]);
  assert.deepEqual(chat.messages.slice(2), [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "read result" }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '[tool_result multimodal content {"tool_index":1,"tool_call_id_utf16be_base64url":"AGMAYQBsAGwAXwAx"}]',
        },
        {
          type: "file",
          file: {
            file_data: "data:text/plain;base64,YWJj",
            filename: "tool.txt",
          },
        },
      ],
    },
  ]);

  await assert.rejects(
    transformer().transformRequestOut!({
      model: "claude-test",
      messages: [{
        role: "user",
        content: [{
          type: "document",
          source: { type: "file", file_id: "file_document_1" },
        }],
      }],
    }),
    (error: any) =>
      error.statusCode === 400 && /provider-owned/.test(error.message),
  );
});

test("assistant replay does not pair thinking across an intervening text block", async () => {
  const result = await transformer().transformRequestOut!({
    model: "claude-test",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "before text", signature: "sig_text" },
          { type: "text", text: "visible" },
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "thinking", thinking: "before tool", signature: "sig_tool" },
          { type: "tool_use", id: "call_2", name: "write", input: {} },
        ],
      },
    ],
  });
  assert.deepEqual(result.messages[0].thinking_blocks, [
    { content: "before text", signature: "sig_text" },
    { content: "before tool", signature: "sig_tool", tool_call_id: "call_2" },
  ]);
});

test("non-stream Chat refusal uses Anthropic refusal stop_details", async () => {
  const converted = await transformer().transformResponseIn!(
    new Response(
      JSON.stringify({
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, refusal: "Cannot help." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    { req: { id: "anthropic-fix-test" } } as any,
  );
  const body = await converted.json() as any;
  assert.equal(body.stop_reason, "refusal");
  assert.deepEqual(body.stop_details, {
    type: "refusal",
    category: null,
    explanation: "Cannot help.",
  });
  assert.deepEqual(body.content, [{ type: "text", text: "Cannot help." }]);
});

test("stream refusal with finish_reason stop retains formal stop_details", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          { index: 0, delta: { role: "assistant", refusal: "Cannot " }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [
          { index: 0, delta: { refusal: "help." }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-refusal",
        model: "safe-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]),
  );
  const delta = events.find((event) => event.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "refusal");
  assert.deepEqual(delta.delta.stop_details, {
    type: "refusal",
    category: null,
    explanation: "Cannot help.",
  });
});

test("a delayed signature after tool deltas seals the original thinking block", async () => {
  const events = await toAnthropicStream(
    sse([
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", thinking: { content: "plan" } },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [
          {
            index: 0,
            delta: { thinking: { signature: "real_signature" } },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-tools",
        model: "reasoner",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]),
  );

  const blocks = events.filter((event) => event.type.startsWith("content_block_"));
  assert.deepEqual(
    blocks
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.content_block.type),
    ["thinking", "tool_use"],
  );
  const signatures = blocks
    .filter((event) => event.delta?.type === "signature_delta")
    .map((event) => event.delta.signature);
  assert.deepEqual(signatures, ["real_signature"]);
});

test("downstream stream cancellation cancels the held upstream reader", async () => {
  let upstreamCancelReason: unknown;
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const upstream = new ReadableStream<Uint8Array>({
    pull() {
      // Keep the transform blocked in reader.read() until its downstream is
      // cancelled. The upstream cancel hook is the observable contract.
    },
    cancel(reason) {
      upstreamCancelReason = reason;
      cancelled();
    },
  });
  const converted = await transformer().transformResponseIn!(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    { req: { id: "anthropic-fix-test" } } as any,
  );
  await converted.body!.cancel("client disconnected");
  await cancellation;
  assert.equal(upstreamCancelReason, "client disconnected");
});
