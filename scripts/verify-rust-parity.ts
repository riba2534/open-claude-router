import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { AnthropicTransformer } from "../src/transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../src/transformers/responses.js";
import { aggregateAnthropicSseToMessage } from "../src/utils/anthropic-sse.js";
import {
  convertThinkingToReasoningContent,
  normalizeMultimodalToolResultsForChatCompletions,
  scrubAnthropicOnlyFields,
  scrubChatCompletionsIncompatibleFields,
  scrubResponsesReasoningArtifacts,
} from "../src/utils/strip.js";
import { countAnthropicTokens } from "../src/utils/tokenizer.js";

const requests: Array<{ name: string; body: any }> = [
  {
    name: "basic multimodal system",
    body: {
      model: "claude-test",
      max_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["STOP"],
      stream: true,
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look", cache_control: { type: "ephemeral" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      }],
    },
  },
  {
    name: "parallel typed tool results",
    body: {
      model: "claude-test",
      max_tokens: 64,
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } },
          { type: "tool_use", id: "call_2", name: "read", input: { path: "b" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: [
            { type: "text", text: "first" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } },
          ] },
          { type: "tool_result", tool_use_id: "call_2", is_error: true, content: [
            { type: "document", title: "x.txt", source: { type: "text", data: "document" } },
          ] },
          { type: "text", text: "continue" },
        ] },
      ],
    },
  },
  {
    name: "signed interleaved thinking history",
    body: {
      model: "claude-test",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "one", signature: "native-one" },
          { type: "tool_use", id: "call_1", name: "read", input: {} },
          { type: "thinking", thinking: "two", signature: "native-two" },
          { type: "text", text: "answer" },
        ] },
      ],
    },
  },
  {
    name: "documents and future blocks",
    body: {
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user", content: [
        { type: "document", title: "raw.txt", context: "ctx", source: { type: "text", data: "hello" } },
        { type: "document", title: "remote", source: { type: "url", url: "https://example.com/doc.pdf" } },
        { type: "document", source: { type: "content", content: [
          { type: "text", text: "nested" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Ag==" } },
        ] } },
        { type: "future_block", value: 7 },
      ] }],
    },
  },
  {
    name: "strict tools output and effort",
    body: {
      model: "claude-test",
      max_tokens: 1024,
      output_config: {
        effort: "xhigh",
        format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
      },
      thinking: { type: "adaptive", display: "summarized" },
      tools: [{ name: "lookup", description: "lookup", strict: true, input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "answer" }],
    },
  },
  {
    name: "invalid enabled thinking budget",
    body: {
      model: "claude-test",
      max_tokens: 32,
      thinking: { type: "enabled", budget_tokens: 1000 },
      messages: [{ role: "user", content: "hello" }],
    },
  },
  {
    name: "provider owned image source",
    body: {
      model: "claude-test",
      max_tokens: 32,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "file", file_id: "file_1" } },
      ] }],
    },
  },
  {
    name: "unsigned thinking history",
    body: {
      model: "claude-test",
      max_tokens: 32,
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "cannot replay" },
      ] }],
    },
  },
  {
    name: "tool result in wrong role",
    body: {
      model: "claude-test",
      max_tokens: 32,
      messages: [{ role: "assistant", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "bad" },
      ] }],
    },
  },
  {
    name: "opaque container state",
    body: {
      model: "claude-test",
      max_tokens: 32,
      container: "container_1",
      messages: [{ role: "user", content: "hello" }],
    },
  },
  {
    name: "typed server tool",
    body: {
      model: "claude-test",
      max_tokens: 32,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "hello" }],
    },
  },
  {
    name: "top level text citations",
    body: {
      model: "claude-test",
      max_tokens: 32,
      messages: [{ role: "user", content: [
        { type: "text", text: "cited", citations: [{ type: "char_location", start_char_index: 0 }] },
      ] }],
    },
  },
  {
    name: "mid conversation system and tool projection",
    body: {
      model: "claude-test",
      tools: [
        { name: "always_on", input_schema: { type: "object" } },
        { name: "deferred_then_added", defer_loading: true, input_schema: { type: "object" } },
        { name: "removed", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "continue" },
        { role: "system", content: [
          { type: "text", text: "Use the newly available tool" },
          { type: "mid_conv_system", content: [
            { type: "text", text: "wrapped instruction" },
            { type: "tool_addition", tool: { type: "tool_reference", name: "deferred_then_added" } },
          ] },
          { type: "tool_removal", tool: { type: "tool_reference", name: "removed" } },
        ] },
      ],
    },
  },
  {
    name: "tool result activates deferred tool",
    body: {
      model: "claude-test",
      tools: [
        { name: "search", input_schema: { type: "object" } },
        { name: "weather", defer_loading: true, input_schema: { type: "object" } },
      ],
      tool_choice: { type: "tool", name: "weather" },
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_search", name: "search", input: {} }] },
        { role: "user", content: [{
          type: "tool_result", tool_use_id: "call_search",
          content: [{ type: "tool_reference", tool_name: "weather" }],
        }] },
      ],
    },
  },
  {
    name: "empty turns remain present",
    body: {
      model: "claude-test",
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: [] },
        { role: "user", content: [] },
      ],
    },
  },
  {
    name: "future system and assistant blocks",
    body: {
      model: "claude-test",
      system: [{ type: "future_instruction", payload: "keep" }],
      messages: [{ role: "assistant", content: [
        { type: "text", text: "visible" },
        { type: "future_assistant_block", value: "preserve" },
      ] }],
    },
  },
  {
    name: "invalid direct caller shape",
    body: {
      model: "claude-test",
      messages: [{ role: "assistant", content: [{
        type: "tool_use", id: "call_1", name: "run", input: {}, caller: "direct",
      }] }],
    },
  },
  {
    name: "invalid tool choice parallel flag",
    body: {
      model: "claude-test",
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: "true" },
      messages: [{ role: "user", content: "continue" }],
    },
  },
  {
    name: "invalid mid conversation system placement",
    body: {
      model: "claude-test",
      messages: [
        { role: "user", content: "one" },
        { role: "system", content: "update" },
        { role: "user", content: "must be assistant or end" },
      ],
    },
  },
  {
    name: "cited document structured output conflict",
    body: {
      model: "claude-test",
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      messages: [{ role: "user", content: [{
        type: "document", source: { type: "text", data: "source" }, citations: { enabled: true },
      }] }],
    },
  },
  {
    name: "provider owned document source",
    body: {
      model: "claude-test",
      messages: [{ role: "user", content: [{
        type: "document", source: { type: "file", file_id: "file_1" },
      }] }],
    },
  },
  {
    name: "invalid search result mixture",
    body: {
      model: "claude-test",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }] },
        { role: "user", content: [{
          type: "tool_result", tool_use_id: "call_1", content: [
            { type: "search_result", title: "result", source: "urn:test", content: [{ type: "text", text: "result" }] },
            { type: "text", text: "mixed" },
          ],
        }] },
      ],
    },
  },
  {
    name: "direct allowed caller tool",
    body: {
      model: "claude-test",
      tools: [{ name: "run", allowed_callers: ["direct"], input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "continue" }],
    },
  },
  {
    name: "code execution allowed caller is unsupported",
    body: {
      model: "claude-test",
      tools: [{ name: "run", allowed_callers: ["code_execution_20260120"], input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "continue" }],
    },
  },
  {
    name: "server tool result history is unsupported",
    body: {
      model: "claude-test",
      messages: [{ role: "assistant", content: [{
        type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [],
      }] }],
    },
  },
];

const responseCases: Array<{
  name: string;
  mode: "chat-response" | "responses-response";
  value: any;
  omit_thinking?: boolean;
}> = [
  {
    name: "Chat text usage",
    mode: "chat-response",
    value: {
      id: "chat_1", model: "chat-model", service_tier: "priority",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    },
  },
  {
    name: "Chat reasoning and tool",
    mode: "chat-response",
    value: {
      id: "chat_2", model: "chat-model",
      choices: [{ index: 0, message: {
        role: "assistant", content: null, reasoning_content: "reason",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  },
  {
    name: "Chat omitted reasoning",
    mode: "chat-response",
    omit_thinking: true,
    value: {
      id: "chat_3", model: "chat-model",
      choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "hidden" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  },
  {
    name: "Responses reasoning text and tool",
    mode: "responses-response",
    value: {
      id: "resp_1", object: "response", status: "completed", model: "responses-model", created_at: 1,
      output: [
        { type: "reasoning", id: "reason_1", content: [{ type: "reasoning_text", text: "raw" }], summary: [{ type: "summary_text", text: "summary" }], encrypted_content: "opaque" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{\"path\":\"a\"}", status: "completed" },
        { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "after" }] },
      ],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 2 } },
    },
  },
  {
    name: "Responses refusal",
    mode: "responses-response",
    value: {
      id: "resp_2", object: "response", status: "incomplete", model: "responses-model",
      incomplete_details: { reason: "content_filter" },
      output: [{ type: "message", id: "msg_2", status: "incomplete", role: "assistant", content: [{ type: "refusal", refusal: "cannot" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  },
  {
    name: "Responses omitted encrypted reasoning",
    mode: "responses-response",
    omit_thinking: true,
    value: {
      id: "resp_3", object: "response", status: "completed", model: "responses-model",
      output: [
        { type: "reasoning", id: "reason_3", summary: [{ type: "summary_text", text: "hidden" }], encrypted_content: "opaque-3" },
        { type: "message", id: "msg_3", status: "completed", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    },
  },
  {
    name: "Chat partial tool at length terminal",
    mode: "chat-response",
    value: {
      id: "chat_partial", model: "chat-model",
      choices: [{ index: 0, message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_partial", type: "function", function: { name: "read", arguments: "{\"path\":" } }],
      }, finish_reason: "length" }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    },
  },
  {
    name: "Chat refusal audio and citations",
    mode: "chat-response",
    value: {
      id: "chat_rich", model: "chat-model",
      choices: [{ index: 0, message: {
        role: "assistant", content: "visible", refusal: "cannot",
        audio: { transcript: "spoken", data: "base64-never-expose" },
        annotations: [{ type: "url_citation", url_citation: { url: "https://example.com", start_index: 0, end_index: 7 } }],
      }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  },
  {
    name: "Chat malformed complete tool input",
    mode: "chat-response",
    value: {
      id: "chat_bad_tool", model: "chat-model",
      choices: [{ index: 0, message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_bad", type: "function", function: { name: "read", arguments: "{" } }],
      }, finish_reason: "tool_calls" }],
    },
  },
  {
    name: "Responses incomplete function bytes",
    mode: "responses-response",
    value: {
      id: "resp_incomplete", object: "response", status: "incomplete", model: "responses-model",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", id: "fc_partial", call_id: "call_partial", name: "read", arguments: "{\"path\":", status: "incomplete" }],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    },
  },
  {
    name: "Responses raw reasoning wins over summary",
    mode: "responses-response",
    value: {
      id: "resp_raw", object: "response", status: "completed", model: "responses-model",
      output: [{
        type: "reasoning", id: "reason_raw",
        summary: [{ type: "summary_text", text: "summary fallback" }],
        content: [{ type: "reasoning_text", text: "raw reasoning" }],
      }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  },
  {
    name: "Responses signature only reasoning",
    mode: "responses-response",
    value: {
      id: "resp_signature", object: "response", status: "completed", model: "responses-model",
      output: [{ type: "reasoning", id: "reason_signature", summary: [], encrypted_content: "opaque" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
  {
    name: "Responses generated image and unknown item fallback",
    mode: "responses-response",
    value: {
      id: "resp_fallback", object: "response", status: "completed", model: "responses-model",
      output: [
        { type: "image_generation_call", id: "img_1", status: "completed", result: "base64-never-expose" },
        { type: "future_output", id: "future_1", payload: "bounded" },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
  {
    name: "Responses missing reasoning id",
    mode: "responses-response",
    value: {
      id: "resp_bad_reason", object: "response", status: "completed", model: "responses-model",
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] }],
    },
  },
  {
    name: "Responses nonterminal JSON status",
    mode: "responses-response",
    value: {
      id: "resp_running", object: "response", status: "in_progress", model: "responses-model", output: [],
    },
  },
  {
    name: "Responses hosted runtime state",
    mode: "responses-response",
    value: {
      id: "resp_hosted", object: "response", status: "completed", model: "responses-model",
      output: [{ type: "program", id: "program_1", code: "opaque" }],
    },
  },
  {
    name: "Responses adjacent text and refusal parts",
    mode: "responses-response",
    value: {
      id: "resp_parts", object: "response", status: "completed", model: "responses-model",
      output: [{ type: "message", id: "msg_parts", role: "assistant", status: "completed", content: [
        { type: "output_text", text: "ANSWER" },
        { type: "refusal", refusal: "NO" },
      ] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  },
];

const streamCases: Array<{
  name: string;
  mode: "chat-sse-response" | "responses-sse-response";
  value: any[];
  saw_done?: boolean;
}> = [
  {
    name: "Chat streamed text reasoning and usage",
    mode: "chat-sse-response",
    saw_done: true,
    value: [
      { id: "chat_stream_1", model: "chat-model", choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
      { id: "chat_stream_1", model: "chat-model", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
      { id: "chat_stream_1", model: "chat-model", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ],
  },
  {
    name: "Chat ignores empty parallel content and reasoning fields",
    mode: "chat-sse-response",
    saw_done: true,
    value: [
      { id: "chat_parallel_empty", model: "chat-model", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: null }] },
      { id: "chat_parallel_empty", model: "chat-model", choices: [{ index: 0, delta: { content: "", reasoning_content: "think" }, finish_reason: null }] },
      { id: "chat_parallel_empty", model: "chat-model", choices: [{ index: 0, delta: { content: "answer", reasoning_content: "" }, finish_reason: null }] },
      { id: "chat_parallel_empty", model: "chat-model", choices: [{ index: 0, delta: { content: "", reasoning_content: "" }, finish_reason: "stop" }] },
    ],
  },
  {
    name: "Chat streamed parallel tools",
    mode: "chat-sse-response",
    saw_done: true,
    value: [
      { id: "chat_stream_2", model: "chat-model", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"p\":" } },
        { index: 1, id: "call_2", type: "function", function: { name: "write", arguments: "{\"p\":" } },
      ] }, finish_reason: null }] },
      { id: "chat_stream_2", model: "chat-model", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, function: { arguments: "1}" } },
        { index: 1, function: { arguments: "2}" } },
      ] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } },
    ],
  },
  {
    name: "Responses terminal-only ordered output",
    mode: "responses-sse-response",
    saw_done: true,
    value: [{
      type: "response.completed",
      response: {
        id: "resp_stream_1", object: "response", status: "completed", model: "responses-model",
        output: [
          { type: "reasoning", id: "reason_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "opaque" },
          { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }],
  },
  {
    name: "Responses deltas with empty terminal output",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.created", response: { id: "resp_stream_2", object: "response", status: "in_progress", model: "responses-model", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2", status: "in_progress", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "part" },
      { type: "response.output_text.done", item_id: "msg_2", output_index: 0, content_index: 0, text: "partial" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_2", status: "completed", role: "assistant", content: [{ type: "output_text", text: "partial" }] } },
      { type: "response.completed", response: { id: "resp_stream_2", object: "response", status: "completed", model: "responses-model", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ],
  },
  {
    name: "Chat DONE completes text without finish reason",
    mode: "chat-sse-response",
    saw_done: true,
    value: [
      { id: "chat_done", model: "chat-model", choices: [{ index: 0, delta: { content: "complete" }, finish_reason: null }] },
    ],
  },
  {
    name: "Chat transport truncation is not success",
    mode: "chat-sse-response",
    saw_done: false,
    value: [
      { id: "chat_truncated", model: "chat-model", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
    ],
  },
  {
    name: "Chat DONE never promotes partial tool",
    mode: "chat-sse-response",
    saw_done: true,
    value: [
      { id: "chat_partial_tool", model: "chat-model", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "call_partial", type: "function", function: { name: "read", arguments: "{\"path\":" } }],
      }, finish_reason: null }] },
    ],
  },
  {
    name: "Responses raw reasoning delta outranks summary",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.created", response: { id: "resp_reason", model: "responses-model", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "reason_1", summary: [], content: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "reason_1", summary_index: 0, delta: "summary" },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "reason_1", content_index: 0, delta: "raw" },
      { type: "response.output_item.done", output_index: 0, item: {
        type: "reasoning", id: "reason_1", summary: [{ type: "summary_text", text: "summary" }],
        content: [{ type: "reasoning_text", text: "raw" }], encrypted_content: "opaque",
      } },
      { type: "response.completed", response: { id: "resp_reason", model: "responses-model", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } } },
    ],
  },
  {
    name: "Responses divergent text snapshot",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "alpha" },
      { type: "response.output_text.done", output_index: 0, item_id: "msg_1", content_index: 0, text: "different" },
      { type: "response.completed", response: { id: "resp_divergent", model: "responses-model", status: "completed", output: [] } },
    ],
  },
  {
    name: "Responses terminal event requires response object",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.created", response: { id: "resp_missing", model: "responses-model", status: "in_progress", output: [] } },
      { type: "response.completed" },
    ],
  },
  {
    name: "Responses streamed function identity matches terminal",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{}" },
      { type: "response.completed", response: {
        id: "resp_tool", model: "responses-model", status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}", status: "completed" }],
      } },
    ],
  },
  {
    name: "Responses terminal function identity mismatch",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{}" },
      { type: "response.completed", response: {
        id: "resp_bad_tool", model: "responses-model", status: "completed",
        output: [{ type: "function_call", id: "fc_2", call_id: "call_2", name: "write", arguments: "{}", status: "completed" }],
      } },
    ],
  },
  {
    name: "Responses populated item snapshot suppresses replayed deltas",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.created", response: { id: "resp_snapshot", model: "responses-model", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: {
        type: "message", id: "msg_snapshot", role: "assistant", status: "in_progress",
        content: [{ type: "output_text", text: "ANSWER" }, { type: "refusal", refusal: "NO" }],
      } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_snapshot", content_index: 0, delta: "ANSWER" },
      { type: "response.refusal.delta", output_index: 0, item_id: "msg_snapshot", content_index: 1, delta: "NO" },
      { type: "response.output_text.done", output_index: 0, item_id: "msg_snapshot", content_index: 0, text: "ANSWER" },
      { type: "response.refusal.done", output_index: 0, item_id: "msg_snapshot", content_index: 1, refusal: "NO" },
      { type: "response.completed", response: { id: "resp_snapshot", model: "responses-model", status: "completed", output: [] } },
    ],
  },
  {
    name: "Responses populated reasoning snapshot suppresses replayed deltas",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.created", response: { id: "resp_reason_snapshot", model: "responses-model", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: {
        type: "reasoning", id: "reason_snapshot",
        summary: [{ type: "summary_text", text: "SUMMARY" }],
        content: [{ type: "reasoning_text", text: "RAW" }], encrypted_content: "opaque",
      } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "reason_snapshot", summary_index: 0, delta: "SUMMARY" },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "reason_snapshot", content_index: 0, delta: "RAW" },
      { type: "response.reasoning_summary_text.done", output_index: 0, item_id: "reason_snapshot", summary_index: 0, text: "SUMMARY" },
      { type: "response.reasoning_text.done", output_index: 0, item_id: "reason_snapshot", content_index: 0, text: "RAW" },
      { type: "response.output_item.done", output_index: 0, item: {
        type: "reasoning", id: "reason_snapshot",
        summary: [{ type: "summary_text", text: "SUMMARY" }],
        content: [{ type: "reasoning_text", text: "RAW" }], encrypted_content: "opaque",
      } },
      { type: "response.completed", response: { id: "resp_reason_snapshot", model: "responses-model", status: "completed", output: [] } },
    ],
  },
  {
    name: "Responses populated function snapshot suppresses replayed deltas",
    mode: "responses-sse-response",
    saw_done: true,
    value: [
      { type: "response.output_item.added", output_index: 0, item: {
        type: "function_call", id: "fc_snapshot", call_id: "call_snapshot", name: "read", arguments: "{}", status: "completed",
      } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_snapshot", delta: "{}" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_snapshot", arguments: "{}" },
      { type: "response.completed", response: {
        id: "resp_function_snapshot", model: "responses-model", status: "completed",
        output: [{ type: "function_call", id: "fc_snapshot", call_id: "call_snapshot", name: "read", arguments: "{}", status: "completed" }],
      } },
    ],
  },
];

const tokenCases = [
  {
    name: "token count multilingual text",
    mode: "token-count",
    value: {
      system: "你是一个严谨的助手",
      messages: [
        { role: "user", content: "Hello, 世界 👋" },
        { role: "assistant", content: [{ type: "text", text: "当然可以。" }] },
      ],
    },
  },
  {
    name: "token count tools and image budget",
    mode: "token-count",
    value: {
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "result" }] },
      ] }],
      tools: [{ name: "lookup", description: "look up a value", input_schema: { type: "object", properties: { id: { type: "string" } } } }],
    },
  },
  {
    name: "token count structured tool input",
    mode: "token-count",
    value: {
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "write", input: { path: "a.txt", content: "line\nline" } }] }],
    },
  },
] as const;

const anthropic = new AnthropicTransformer();
const responses = new OpenAIResponsesTransformer();
const cases = requests.flatMap(({ name, body }) => [
  { name, mode: "unified", value: body },
  { name, mode: "chat", value: body },
  { name, mode: "responses", value: body },
]).concat(responseCases as any, streamCases as any, tokenCases as any);

const expected = [];
for (const fixture of cases) {
  try {
    if (fixture.mode === "token-count") {
      expected.push({ ok: true, value: countAnthropicTokens(fixture.value) });
      continue;
    }
    if (fixture.mode === "chat-response") {
      const converted = await anthropic.transformResponseIn!(
        new Response(JSON.stringify(fixture.value), { headers: { "content-type": "application/json" } }),
        { req: { id: "parity", body: { thinking: fixture.omit_thinking ? { display: "omitted" } : undefined } } } as any,
      );
      const value = await converted.json();
      expected.push(converted.ok
        ? { ok: true, value }
        : {
            ok: false,
            status: converted.status,
            type: value?.error?.type ?? "api_error",
            message: value?.error?.message ?? "upstream response failed",
          });
      continue;
    }
    if (fixture.mode === "responses-response") {
      const chat = await responses.transformResponseOut!(
        new Response(JSON.stringify(fixture.value), { headers: { "content-type": "application/json" } }),
        { thinkingDisplay: fixture.omit_thinking ? "omitted" : undefined },
      );
      const converted = await anthropic.transformResponseIn!(
        chat,
        { req: { id: "parity", body: { thinking: fixture.omit_thinking ? { display: "omitted" } : undefined } } } as any,
      );
      const value = await converted.json();
      expected.push(converted.ok
        ? { ok: true, value }
        : {
            ok: false,
            status: converted.status,
            type: value?.error?.type ?? "api_error",
            message: value?.error?.message ?? "upstream response failed",
          });
      continue;
    }
    if (fixture.mode === "chat-sse-response" || fixture.mode === "responses-sse-response") {
      const sseText = fixture.value.map((event: any) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        (fixture.saw_done ? "data: [DONE]\n\n" : "");
      let upstream = new Response(sseText, { headers: { "content-type": "text/event-stream" } });
      if (fixture.mode === "responses-sse-response") {
        upstream = await responses.transformResponseOut!(upstream, {});
      }
      const converted = await anthropic.transformResponseIn!(
        upstream,
        { req: { id: "parity", body: {} } } as any,
      );
      expected.push({ ok: true, value: await aggregateAnthropicSseToMessage(converted) });
      continue;
    }
    const unified: any = await anthropic.transformRequestOut!(structuredClone(fixture.value));
    if (fixture.mode === "unified") {
      expected.push({ ok: true, value: unified });
      continue;
    }
    scrubAnthropicOnlyFields(unified);
    if (fixture.mode === "chat") {
      const reasoningEnabled = unified.reasoning?.enabled === true;
      convertThinkingToReasoningContent(unified, reasoningEnabled);
      normalizeMultimodalToolResultsForChatCompletions(unified);
      scrubChatCompletionsIncompatibleFields(unified);
      if (fixture.value.stream === true) {
        unified.stream_options = { include_usage: true };
      }
      expected.push({ ok: true, value: unified });
    } else {
      scrubResponsesReasoningArtifacts(unified);
      expected.push({ ok: true, value: await responses.transformRequestIn!(unified) });
    }
  } catch (error: any) {
    expected.push({
      ok: false,
      status: error?.statusCode ?? 500,
      type: error?.type ?? "api_error",
      message: error?.message ?? String(error),
    });
  }
}

const actual = JSON.parse(execFileSync(
  "cargo",
  ["run", "--quiet", "--manifest-path", "rust/Cargo.toml", "--example", "transform_fixture"],
  {
    cwd: new URL("..", import.meta.url),
    input: JSON.stringify(cases.map(({ mode, value, omit_thinking, saw_done }) => ({ mode, value, omit_thinking, saw_done }))),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
));

for (let index = 0; index < cases.length; index += 1) {
  const fixture = cases[index];
  try {
    const normalizedActual = structuredClone(actual[index]);
    const normalizedExpected = JSON.parse(JSON.stringify(expected[index]));
    if (fixture.mode.endsWith("sse-response")) {
      if (normalizedActual.value?.id) normalizedActual.value.id = "<stream-id>";
      if (normalizedExpected.value?.id) normalizedExpected.value.id = "<stream-id>";
    }
    assert.deepEqual(normalizedActual, normalizedExpected);
    console.log(`  ok  ${fixture.mode.padEnd(9)} ${fixture.name}`);
  } catch (error) {
    console.error(`  FAIL ${fixture.mode.padEnd(9)} ${fixture.name}`);
    throw error;
  }
}

console.log(`\n${cases.length} Rust/TypeScript protocol conversion fixtures matched`);
