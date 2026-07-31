import type { ChatCompletionMessageParam as OpenAIMessage } from "openai/resources/chat/completions";
import type { MessageParam as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { Transformer } from "./transformer.js";

export interface UrlCitation {
  url: string;
  title: string;
  content: string;
  start_index: number;
  end_index: number;
}
export interface Annotation {
  type: "url_citation";
  url_citation?: UrlCitation;
}

export interface TextContent {
  type: "text";
  text: string;
  cache_control?: {
    type?: string;
  };
}

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
}

/**
 * Lossless file/document envelope shared by the protocol transformers.
 *
 * `fallback_text` is deliberately outside the OpenAI `file` object. The
 * Chat-Completions normalizer removes it when `file_data`/`file_id` can be
 * sent formally, or replaces URL-only/unsupported files with that bounded
 * text. Responses consumes the same envelope as an `input_file` part.
 */
export interface FileContent {
  type: "file";
  file: {
    file_data?: string;
    file_id?: string;
    file_url?: string;
    filename?: string;
  };
  fallback_text: string;
}

export type MessageContent = TextContent | ImageContent | FileContent;

export interface UnifiedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null | MessageContent[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  cache_control?: {
    type?: string;
  };
  thinking?: {
    content: string;
    signature?: string;
  };
  /**
   * Every signed thinking block of the source assistant turn, in order.
   * `tool_call_id` names the tool call the block immediately preceded, so
   * Responses replay can restore interleaved reasoning items (`thinking` above
   * only carries the first block for Chat-Completions compatibility).
   */
  thinking_blocks?: Array<{
    content?: string;
    signature?: string;
    tool_call_id?: string;
  }>;
}

export interface UnifiedTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
      $schema?: string;
    };
  };
}

export type ThinkLevel = "none" | "low" | "medium" | "high";
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningEffort = ThinkLevel | "xhigh" | "max";
export type ThinkingDisplay = "summarized" | "omitted";

export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: UnifiedTool[];
  parallel_tool_calls?: boolean;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | string
    | { type: "function"; function: { name: string } };
  reasoning_effort?: AnthropicEffort;
  reasoning?: {
    effort?: ReasoningEffort;
    max_tokens?: number;
    enabled?: boolean;
    /**
     * Explicit Anthropic display preference. This is intentionally absent when
     * the client omitted `thinking.display`: model-specific defaults belong to
     * the selected upstream, not to the protocol router.
     */
    display?: ThinkingDisplay;
  };
}

export interface UnifiedChatResponse {
  id: string;
  model: string;
  content: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  annotations?: Annotation[];
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      thinking?: {
        content?: string;
        signature?: string;
      };
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      annotations?: Annotation[];
    };
    finish_reason?: string | null;
  }>;
}

export type AnthropicStreamEvent = MessageStreamEvent;
export type OpenAIStreamChunk = ChatCompletionChunk;

export interface OpenAIChatRequest {
  messages: OpenAIMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ChatCompletionTool[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
}

export interface AnthropicChatRequest {
  messages: AnthropicMessage[];
  model: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" } | { type: "tool"; name: string };
}

export interface LLMProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  transformer?: {
    [key: string]: {
      use?: Transformer[];
    };
  } & {
    use?: Transformer[];
  };
}
