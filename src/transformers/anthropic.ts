import type { ChatCompletion } from "openai/resources";
import {
  AnthropicEffort,
  type FileContent,
  LLMProvider,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from "../types/llm.js";
import {
  Transformer,
  TransformerContext,
  TransformerOptions,
} from "../types/transformer.js";
import { v4 as uuidv4 } from "uuid";
import { getThinkLevel } from "./thinking.js";
import { createApiError } from "./errors.js";
import { formatBase64 } from "./image.js";
import { SseBlockDecoder } from "./sse.js";
import {
  encodeChatReasoningSignature,
  isRouterOwnedReasoningSignature,
} from "../utils/chat-reasoning.js";
import { mapOpenAIErrorToAnthropic } from "../utils/upstream.js";

const ANTHROPIC_EFFORTS = new Set<AnthropicEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function parseAnthropicEffort(value: unknown): AnthropicEffort | undefined {
  return typeof value === "string" &&
    ANTHROPIC_EFFORTS.has(value as AnthropicEffort)
    ? (value as AnthropicEffort)
    : undefined;
}

function convertAnthropicImage(part: any) {
  const source = part?.source;
  const embeddedDataUrl =
    source?.type === "base64" &&
    typeof source.data === "string" &&
    /^data:[^,]*;base64,/i.test(source.data);
  const url =
    source?.type === "base64" &&
      typeof source.data === "string" &&
      (embeddedDataUrl ||
        (typeof source.media_type === "string" && source.media_type.length > 0))
      ? formatBase64(source.data, source.media_type)
      : source?.type === "url" && typeof source.url === "string"
        ? source.url
        : undefined;
  if (!url) return null;
  return {
    type: "image_url" as const,
    image_url: { url },
  };
}

function documentFallbackText(part: any): string {
  const source = part?.source;
  const title =
    typeof part?.title === "string" && part.title
      ? ` ${JSON.stringify(part.title)}`
      : "";
  const bounded = (text: string) =>
    text.length <= MAX_JSON_FALLBACK_CHARS
      ? text
      : `[unsupported document block omitted: ${text.length} chars]`;
  if (source?.type === "url" && typeof source.url === "string") {
    return bounded(`[document${title}: ${source.url}]`);
  }
  if (source?.type === "base64" && typeof source.data === "string") {
    return bounded(
      `[document${title}: ${source.media_type || "application/octet-stream"}, ${source.data.length} base64 chars]`,
    );
  }
  if (source?.type === "text" && typeof source.data === "string") {
    const prefix = title ? `[document${title}]\n` : "";
    const text = `${prefix}${source.data}`;
    return bounded(text);
  }
  return boundedJsonBlockText(part);
}

function convertAnthropicDocument(part: any): FileContent | null {
  const source = part?.source;
  const filename =
    typeof part?.title === "string" && part.title
      ? part.title
      : source?.type === "text"
        ? "document.txt"
        : source?.type === "base64" || source?.type === "url"
          ? "document.pdf"
          : undefined;
  const file: FileContent["file"] = {
    ...(filename ? { filename } : {}),
  };

  if (source?.type === "base64" && typeof source.data === "string") {
    file.file_data = formatBase64(
      source.data,
      typeof source.media_type === "string"
        ? source.media_type
        : "application/pdf",
    );
  } else if (source?.type === "text" && typeof source.data === "string") {
    file.file_data = `data:text/plain;base64,${Buffer.from(
      source.data,
      "utf8",
    ).toString("base64")}`;
  } else if (source?.type === "url" && typeof source.url === "string") {
    file.file_url = source.url;
  } else {
    return null;
  }

  return {
    type: "file",
    file,
    fallback_text: documentFallbackText(part),
  };
}

const TOOL_RESULT_ERROR_MARKER =
  '[open-claude-router tool_result metadata: {"is_error":true}]';

function metadataTextPart(kind: "document" | "search_result", metadata: object) {
  return {
    type: "text" as const,
    text: `[open-claude-router ${kind} metadata: ${JSON.stringify(metadata)}]`,
  };
}

function documentMetadataPart(part: any, required = false) {
  const hasContext = part?.context !== undefined && part?.context !== null;
  if (!required && !hasContext) return null;
  return metadataTextPart("document", {
    title: typeof part?.title === "string" ? part.title : null,
    context: typeof part?.context === "string" ? part.context : null,
  });
}

function convertAnthropicDocumentBlocks(part: any): any[] {
  const source = part?.source;
  if (source?.type === "content") {
    const blocks: any[] = [documentMetadataPart(part, true)!];
    if (typeof source.content === "string") {
      blocks.push({ type: "text", text: source.content });
      return blocks;
    }
    for (const content of source.content as any[]) {
      if (content.type === "text") {
        blocks.push({ type: "text", text: content.text });
      } else if (content.type === "image") {
        const image = convertAnthropicImage(content);
        blocks.push(
          image ?? {
            type: "text",
            text: boundedJsonBlockText(content),
          },
        );
      } else {
        blocks.push({
          type: "text",
          text: boundedJsonBlockText(content),
        });
      }
    }
    return blocks;
  }

  const file = convertAnthropicDocument(part);
  if (!file) {
    return [{ type: "text", text: boundedJsonBlockText(part) }];
  }
  const metadata = documentMetadataPart(part);
  return metadata ? [metadata, file] : [file];
}

function convertAnthropicSearchResult(part: any): any[] {
  return [
    metadataTextPart("search_result", {
      title: part.title,
      source: part.source,
    }),
    ...part.content.map((content: any) => ({
      type: "text" as const,
      text: content.text,
    })),
  ];
}

function jsonFallback(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

// Ceiling for JSON-degraded unknown blocks. Documents and similar blocks can
// embed multi-megabyte base64 payloads; inlining those as user-visible text is
// as bad as dropping them, so oversized fallbacks become a short placeholder.
const MAX_JSON_FALLBACK_CHARS = 4096;

function boundedJsonBlockText(block: any): string {
  const text = jsonFallback(block);
  if (text.length <= MAX_JSON_FALLBACK_CHARS) return text;
  const blockType = typeof block?.type === "string" ? block.type : "content";
  return `[unsupported ${blockType} block omitted: ${text.length} chars]`;
}

function incompleteToolCallText(name: unknown, rawArguments: unknown): string {
  const label = typeof name === "string" && name ? name : "unknown";
  const raw =
    typeof rawArguments === "string"
      ? rawArguments
      : jsonFallback(rawArguments ?? "");
  const bounded =
    raw.length <= MAX_JSON_FALLBACK_CHARS
      ? raw
      : `${raw.slice(0, MAX_JSON_FALLBACK_CHARS)}…`;
  return `[incomplete tool_use ${label}: ${bounded}]`;
}

// Renders one OpenAI Chat content part as plain text. Shared by the streaming
// and non-streaming paths so array-typed message content degrades identically.
function chatContentPartToText(part: any): string {
  if (typeof part === "string") return part;
  if (part?.type === "text" && typeof part.text === "string") return part.text;
  if (part?.type === "image_url") return "[generated image omitted]";
  return boundedJsonBlockText(part);
}

// OpenAI usage -> current Anthropic Usage. cached_tokens is reported as a
// subset of prompt_tokens by OpenAI, but some compatible gateways report it as
// a separate counter — clamp so input_tokens can never go negative.
function convertServiceTier(serviceTier: unknown): "standard" | "priority" | null {
  return serviceTier === "default" || serviceTier === "standard"
    ? "standard"
    : serviceTier === "priority" || serviceTier === "fast"
      ? "priority"
      : null;
}

function convertUsage(usage: any, serviceTier?: unknown): Record<string, any> {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens || 0;
  const reasoningTokens =
    usage?.completion_tokens_details?.reasoning_tokens;
  return {
    cache_creation: null,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cached,
    inference_geo: null,
    input_tokens: Math.max(
      0,
      (usage?.prompt_tokens || 0) - cached - cacheWrite,
    ),
    output_tokens: usage?.completion_tokens || 0,
    output_tokens_details: typeof reasoningTokens === "number"
      ? { thinking_tokens: reasoningTokens }
      : null,
    server_tool_use: null,
    service_tier: convertServiceTier(serviceTier),
  };
}

// RawMessageDeltaEvent uses the smaller MessageDeltaUsage schema. Do not copy
// full-message-only keys such as cache_creation, inference_geo, or
// service_tier into delta events.
function convertDeltaUsage(usage: any): Record<string, any> {
  const full = convertUsage(usage);
  return {
    cache_creation_input_tokens: full.cache_creation_input_tokens,
    cache_read_input_tokens: full.cache_read_input_tokens,
    input_tokens: full.input_tokens,
    output_tokens: full.output_tokens,
    output_tokens_details: full.output_tokens_details,
    server_tool_use: full.server_tool_use,
  };
}

function emptyAnthropicUsage(
  outputTokens = 0,
  serviceTier?: unknown,
): Record<string, any> {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: outputTokens,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: convertServiceTier(serviceTier),
  };
}

function emptyAnthropicDeltaUsage(outputTokens = 0): Record<string, any> {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: outputTokens,
    output_tokens_details: null,
    server_tool_use: null,
  };
}

function parseUpstreamToolInput(rawArguments: unknown): Record<string, any> {
  let parsed: unknown;
  try {
    if (typeof rawArguments === "object" && rawArguments !== null) {
      parsed = rawArguments;
    } else if (typeof rawArguments === "string") {
      parsed = JSON.parse(rawArguments || "{}");
    } else if (rawArguments == null) {
      parsed = {};
    } else {
      throw new Error("arguments are not JSON");
    }
  } catch {
    throw createApiError(
      "upstream tool arguments must be a valid JSON object",
      502,
      "upstream_protocol_error",
      "api_error",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createApiError(
      "upstream tool arguments must decode to a JSON object",
      502,
      "upstream_protocol_error",
      "api_error",
    );
  }
  return parsed as Record<string, any>;
}

function mapChatFinishReason(
  finishReason: unknown,
  isRefusal: boolean,
): "end_turn" | "max_tokens" | "tool_use" | "refusal" {
  if (isRefusal) return "refusal";
  if (finishReason === "stop") return "end_turn";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_use";
  }
  throw createApiError(
    `unsupported upstream finish_reason: ${JSON.stringify(finishReason)}`,
    502,
    "upstream_protocol_error",
    "api_error",
  );
}

function refusalStopDetails(explanation?: string | null) {
  return {
    type: "refusal" as const,
    category: null,
    explanation: explanation || null,
  };
}

function omitsThinkingDisplay(context?: TransformerContext): boolean {
  return (context as any)?.req?.body?.thinking?.display === "omitted";
}

function invalidRequest(message: string): never {
  throw createApiError(message, 400, "invalid_body", "invalid_request_error");
}

function normalizeSystemBlocks(blocks: any[]): Array<{
  type: "text";
  text: string;
  cache_control?: any;
}> {
  return blocks.flatMap((item: any) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return item.text
        ? [{
            type: "text" as const,
            text: item.text,
            ...(item.cache_control
              ? { cache_control: item.cache_control }
              : {}),
          }]
        : [];
    }
    // Mid-conversation system blocks are an evolving Anthropic union. Preserve
    // unknown instructions as bounded text rather than silently deleting them.
    return [{
      type: "text" as const,
      text: boundedJsonBlockText(item),
    }];
  });
}

function isToolChangeBlock(block: any): boolean {
  return block?.type === "tool_addition" || block?.type === "tool_removal";
}

function expandMidConversationSystemBlocks(blocks: any[]): any[] {
  return blocks.flatMap((block) =>
    block?.type === "mid_conv_system" ? block.content : [block]
  );
}

function isAnthropicServerToolDefinition(tool: any): boolean {
  if (typeof tool?.type !== "string") return false;
  return tool.type === "mcp_toolset" || [
    "web_search",
    "web_fetch",
    "code_execution",
    "advisor",
    "tool_search_tool_regex",
    "tool_search_tool_bm25",
  ].some((prefix) => tool.type === prefix || tool.type.startsWith(`${prefix}_`));
}

function isAnthropicTypedClientToolDefinition(tool: any): boolean {
  if (typeof tool?.type !== "string") return false;
  return ["bash", "computer", "memory", "text_editor"].some(
    (prefix) => tool.type === prefix || tool.type.startsWith(`${prefix}_`),
  );
}

const ANTHROPIC_SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "advisor_tool_result",
  "mcp_tool_result",
]);

function isAnthropicServerHistoryBlock(block: any): boolean {
  return block?.type === "server_tool_use" ||
    block?.type === "mcp_tool_use" ||
    ANTHROPIC_SERVER_TOOL_RESULT_BLOCK_TYPES.has(block?.type);
}

const ANTHROPIC_OPAQUE_CONTROL_BLOCK_TYPES = new Set([
  "compaction",
  "fallback",
  "container_upload",
]);

const ANTHROPIC_TOOL_CALLERS = new Set([
  "direct",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
]);

/**
 * Anthropic's mid-conversation tool changes alter the tools offered to the
 * current generation from their position onward. Chat Completions and
 * Responses have only one top-level function list, so the faithful current-
 * turn projection is the final active subset. The history blocks themselves
 * are structural directives, not model-visible text.
 */
function resolveActiveAnthropicTools(
  tools: any[] | undefined,
  messages: any[],
): any[] | undefined {
  if (!tools?.length) {
    const hasDynamicToolDirective = messages.some((message) => {
      if (!Array.isArray(message?.content)) return false;
      if (
        message.role === "system" &&
        expandMidConversationSystemBlocks(message.content).some(
          isToolChangeBlock,
        )
      ) {
        return true;
      }
      if (
        message.role === "user" &&
        message.content.some(
          (block: any) =>
            block?.type === "tool_result" &&
            (Array.isArray(block.content)
              ? block.content
              : [block.content]
            ).some((item: any) => item?.type === "tool_reference"),
        )
      ) {
        return true;
      }
      return false;
    });
    if (hasDynamicToolDirective) {
      invalidRequest(
        "tool changes and tool references require declared tools",
      );
    }
    return undefined;
  }

  const declared = new Map<string, any>();
  const active = new Set<string>();
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || tool.name.length === 0) continue;
    declared.set(tool.name, tool);
    if (tool.defer_loading !== true) active.add(tool.name);
  }

  const activateReference = (name: unknown, source: string) => {
    if (typeof name !== "string" || name.length === 0) {
      invalidRequest(`${source} must include a non-empty tool_name`);
    }
    if (!declared.has(name)) {
      invalidRequest(
        `${source} references undeclared tool ${JSON.stringify(name)}`,
      );
    }
    active.add(name);
  };

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      continue;
    }

    if (message.role === "system") {
      for (const block of expandMidConversationSystemBlocks(message.content)) {
        if (!isToolChangeBlock(block)) continue;
        const reference = block.tool;
        if (
          reference?.type !== "tool_reference" ||
          typeof reference.name !== "string" ||
          reference.name.length === 0
        ) {
          invalidRequest(
            `${block.type} currently requires a named tool_reference; ` +
              "MCP tool-change references have no OpenAI function-tool equivalent",
          );
        }
        if (!declared.has(reference.name)) {
          invalidRequest(
            `${block.type} references undeclared tool ${JSON.stringify(reference.name)}`,
          );
        }
        if (block.type === "tool_addition") active.add(reference.name);
        else active.delete(reference.name);
      }
    } else if (message.role === "user") {
      for (const block of message.content) {
        if (block?.type !== "tool_result") continue;
        const resultBlocks = Array.isArray(block.content)
          ? block.content
          : block.content == null
            ? []
            : [block.content];
        for (const resultBlock of resultBlocks) {
          if (resultBlock?.type === "tool_reference") {
            activateReference(
              resultBlock.tool_name,
              "tool_result tool_reference",
            );
          }
        }
      }
    }
  }

  return tools.filter(
    (tool) => typeof tool?.name === "string" && active.has(tool.name),
  );
}

function assistantEndsWithServerToolResult(message: any): boolean {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }
  const last = message.content.at(-1);
  return ANTHROPIC_SERVER_TOOL_RESULT_BLOCK_TYPES.has(last?.type) &&
    typeof last?.tool_use_id === "string" &&
    last.tool_use_id.length > 0;
}

function validateMidConversationSystemPlacement(messages: any[]): void {
  for (let index = 0; index < messages.length;) {
    if (messages[index]?.role !== "system") {
      index += 1;
      continue;
    }
    const groupStart = index;
    while (index < messages.length && messages[index]?.role === "system") {
      index += 1;
    }
    const previous = messages[groupStart - 1];
    if (
      groupStart === 0 ||
      (previous?.role !== "user" &&
        !assistantEndsWithServerToolResult(previous))
    ) {
      invalidRequest(
        "mid-conversation system messages must follow a user turn or an assistant server-tool result",
      );
    }
    const next = messages[index];
    if (next !== undefined && next?.role !== "assistant") {
      invalidRequest(
        "mid-conversation system messages must be final or followed by an assistant turn",
      );
    }
  }
}

function validateAnthropicImageBlock(block: any, label: string): void {
  const source = block?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    invalidRequest(`${label}.source must be an object`);
  }
  if (source.type === "file") {
    invalidRequest(
      `${label}.source.type "file" is provider-owned and cannot be translated to an OpenAI file id`,
    );
  }
  if (source.type === "base64") {
    const selfDescribingDataUrl = typeof source.data === "string" &&
      /^data:[^,]*;base64,/i.test(source.data);
    if (
      typeof source.data !== "string" ||
      (!selfDescribingDataUrl &&
        (typeof source.media_type !== "string" ||
          source.media_type.length === 0))
    ) {
      invalidRequest(
        `${label} base64 sources require string data and a non-empty media_type`,
      );
    }
    return;
  }
  if (source.type === "url") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      invalidRequest(`${label} URL sources require a non-empty url`);
    }
    return;
  }
  if (typeof source.type !== "string" || source.type.length === 0) {
    invalidRequest(`${label}.source.type must be a non-empty string`);
  }
  // Future discriminators are opaque user content. Conversion preserves the
  // bounded envelope as visible text without guessing image semantics.
}

function validateOptionalDocumentMetadata(block: any, label: string): void {
  for (const key of ["title", "context"] as const) {
    if (
      block[key] !== undefined &&
      block[key] !== null &&
      typeof block[key] !== "string"
    ) {
      invalidRequest(`${label}.${key} must be a string or null when provided`);
    }
  }
  if (
    block.citations !== undefined &&
    block.citations !== null &&
    (!block.citations ||
      typeof block.citations !== "object" ||
      Array.isArray(block.citations) ||
      typeof block.citations.enabled !== "boolean")
  ) {
    invalidRequest(`${label}.citations must include a boolean enabled value`);
  }
}

function validateTextBlockCitations(block: any, label: string): void {
  if (block.citations === undefined || block.citations === null) return;
  if (!Array.isArray(block.citations)) {
    invalidRequest(`${label}.citations must be an array or null when provided`);
  }
  if (block.citations.length > 0) {
    invalidRequest(`${label}.citations have no OpenAI protocol equivalent`);
  }
}

function validateAnthropicDocumentBlock(block: any, label: string): boolean {
  validateOptionalDocumentMetadata(block, label);
  const source = block?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    invalidRequest(`${label}.source must be an object`);
  }
  if (source.type === "file") {
    invalidRequest(
      `${label}.source.type "file" is provider-owned and cannot be translated to an OpenAI file id`,
    );
  }
  if (source.type === "base64") {
    const selfDescribingDataUrl = typeof source.data === "string" &&
      /^data:[^,]*;base64,/i.test(source.data);
    if (
      typeof source.data !== "string" ||
      (!selfDescribingDataUrl &&
        (typeof source.media_type !== "string" ||
          source.media_type.length === 0))
    ) {
      invalidRequest(
        `${label} base64 sources require string data and a non-empty media_type`,
      );
    }
  } else if (source.type === "text") {
    if (typeof source.data !== "string") {
      invalidRequest(`${label} text sources require string data`);
    }
  } else if (source.type === "url") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      invalidRequest(`${label} URL sources require a non-empty url`);
    }
  } else if (source.type === "content") {
    if (typeof source.content !== "string" && !Array.isArray(source.content)) {
      invalidRequest(`${label} content sources require a string or block array`);
    }
    if (Array.isArray(source.content)) {
      for (const [index, inner] of source.content.entries()) {
        if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
          invalidRequest(`${label}.source.content[${index}] must be a block`);
        }
        if (inner.type === "text") {
          if (typeof inner.text !== "string") {
            invalidRequest(
              `${label}.source.content[${index}].text must be a string`,
            );
          }
          validateTextBlockCitations(
            inner,
            `${label}.source.content[${index}]`,
          );
        } else if (inner.type === "image") {
          validateAnthropicImageBlock(
            inner,
            `${label}.source.content[${index}]`,
          );
        } else if (
          typeof inner.type !== "string" ||
          inner.type.length === 0
        ) {
          invalidRequest(
            `${label}.source.content[${index}].type must be a non-empty string`,
          );
        }
      }
    }
  } else if (typeof source.type !== "string" || source.type.length === 0) {
    invalidRequest(`${label}.source.type must be a non-empty string`);
  }
  return block.citations?.enabled === true;
}

function validateAnthropicSearchResultBlock(block: any, label: string): boolean {
  if (
    typeof block.title !== "string" ||
    block.title.length === 0 ||
    typeof block.source !== "string" ||
    block.source.length === 0
  ) {
    invalidRequest(`${label} requires non-empty title and source strings`);
  }
  if (!Array.isArray(block.content) || block.content.length === 0) {
    invalidRequest(`${label}.content must be a non-empty array of text blocks`);
  }
  for (const [index, content] of block.content.entries()) {
    if (
      !content ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      content.type !== "text" ||
      typeof content.text !== "string" ||
      content.text.length === 0
    ) {
      invalidRequest(
        `${label}.content[${index}] must be a text block with non-empty text`,
      );
    }
    validateTextBlockCitations(content, `${label}.content[${index}]`);
  }
  if (
    block.citations !== undefined &&
    block.citations !== null &&
    (!block.citations ||
      typeof block.citations !== "object" ||
      Array.isArray(block.citations) ||
      typeof block.citations.enabled !== "boolean")
  ) {
    invalidRequest(`${label}.citations must include a boolean enabled value`);
  }
  return block.citations?.enabled === true;
}

function validateToolResultContent(
  content: unknown,
  label: string,
): boolean {
  if (content === undefined || content === null || typeof content === "string") {
    return false;
  }
  if (!Array.isArray(content)) {
    invalidRequest(`${label} must be a string or an array of content blocks`);
  }
  let hasCitations = false;
  let hasSearchResult = false;
  let hasOtherVisibleContent = false;
  for (const [index, block] of content.entries()) {
    const blockLabel = `${label}[${index}]`;
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      invalidRequest(`${blockLabel} must be a content block`);
    }
    if (block.type === "text") {
      hasOtherVisibleContent = true;
      if (typeof block.text !== "string") {
        invalidRequest(`${blockLabel}.text must be a string`);
      }
      validateTextBlockCitations(block, blockLabel);
    } else if (block.type === "image") {
      hasOtherVisibleContent = true;
      validateAnthropicImageBlock(block, blockLabel);
    } else if (block.type === "document") {
      hasOtherVisibleContent = true;
      hasCitations = validateAnthropicDocumentBlock(block, blockLabel) ||
        hasCitations;
    } else if (block.type === "search_result") {
      hasSearchResult = true;
      hasCitations = validateAnthropicSearchResultBlock(block, blockLabel) ||
        hasCitations;
    } else if (block.type === "tool_reference") {
      if (typeof block.tool_name !== "string" || block.tool_name.length === 0) {
        invalidRequest(`${blockLabel} requires a non-empty tool_name`);
      }
    }
  }
  if (hasSearchResult && hasOtherVisibleContent) {
    invalidRequest(
      `${label} cannot mix search_result blocks with other visible content blocks`,
    );
  }
  return hasCitations;
}

// Malformed client JSON must be a 400 invalid_request_error, not a 500 with a
// raw JavaScript TypeError leaking out of an unguarded dereference.
function validateAnthropicRequestShape(request: Record<string, any>): void {
  const system = request.system;
  if (
    system !== undefined &&
    typeof system !== "string" &&
    !Array.isArray(system)
  ) {
    invalidRequest("system must be a string or an array of content blocks");
  }
  if (Array.isArray(system)) {
    for (const block of system) {
      if (!block || typeof block !== "object") {
        invalidRequest("system content blocks must be objects");
      }
      if (block.type === "text") {
        if (typeof block.text !== "string") {
          invalidRequest("system text blocks require a string text field");
        }
        validateTextBlockCitations(block, "system text block");
      }
    }
  }

  if (request.container !== undefined && request.container !== null) {
    invalidRequest(
      "Anthropic container state has no replay-safe OpenAI equivalent",
    );
  }

  const messages = request.messages;
  if (!Array.isArray(messages)) {
    invalidRequest("messages must be an array");
  }
  let hasCitationsEnabledContent = false;
  for (const [messageIndex, message] of messages.entries()) {
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "system"
    ) {
      const receivedRole =
        message && typeof message === "object" ? message.role : undefined;
      invalidRequest(
        `messages[${messageIndex}] must be an object with role ` +
          `"user", "assistant", or "system"; received ` +
          `${JSON.stringify(receivedRole)}`,
      );
    }
    if (
      typeof message.content !== "string" &&
      !Array.isArray(message.content)
    ) {
      invalidRequest("message content must be a string or an array of blocks");
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") {
          invalidRequest("message content blocks must be objects");
        }
        if (part.type === "redacted_thinking") {
          invalidRequest(
            "redacted_thinking history has no replay-safe OpenAI equivalent",
          );
        }
        if (part.type === "text") {
          if (typeof part.text !== "string") {
            invalidRequest("text content blocks require a string text field");
          }
          validateTextBlockCitations(
            part,
            `messages[${messageIndex}].content text`,
          );
        }
        if (part.type === "image") {
          if (message.role !== "user") {
            invalidRequest("image blocks are only valid in user messages");
          }
          validateAnthropicImageBlock(
            part,
            `messages[${messageIndex}].content image`,
          );
        }
        if (part.type === "document") {
          if (message.role !== "user") {
            invalidRequest("document blocks are only valid in user messages");
          }
          hasCitationsEnabledContent = validateAnthropicDocumentBlock(
            part,
            `messages[${messageIndex}].content document`,
          ) || hasCitationsEnabledContent;
        }
        if (part.type === "search_result") {
          if (message.role !== "user") {
            invalidRequest("search_result blocks are only valid in user messages");
          }
          hasCitationsEnabledContent = validateAnthropicSearchResultBlock(
            part,
            `messages[${messageIndex}].content search_result`,
          ) || hasCitationsEnabledContent;
        }
        if (part.type === "mid_conv_system") {
          if (message.role !== "system") {
            invalidRequest(
              "mid_conv_system blocks are only valid in system messages",
            );
          }
          if (!Array.isArray(part.content)) {
            invalidRequest("mid_conv_system.content must be an array");
          }
          for (const inner of part.content) {
            if (
              !inner ||
              typeof inner !== "object" ||
              !["text", "tool_addition", "tool_removal"].includes(inner.type)
            ) {
              invalidRequest(
                "mid_conv_system.content supports only text and tool-change blocks",
              );
            }
          }
        }
        if (isToolChangeBlock(part) && message.role !== "system") {
          invalidRequest(
            "tool_addition and tool_removal blocks are only valid in system messages",
          );
        }
        if (part.type === "tool_use") {
          if (
            message.role !== "assistant" ||
            typeof part.id !== "string" ||
            part.id.length === 0 ||
            typeof part.name !== "string" ||
            part.name.length === 0 ||
            !part.input ||
            typeof part.input !== "object" ||
            Array.isArray(part.input)
          ) {
            invalidRequest(
              "assistant tool_use blocks require non-empty id/name and an object input",
            );
          }
          if (part.caller !== undefined) {
            if (
              !part.caller ||
              typeof part.caller !== "object" ||
              Array.isArray(part.caller) ||
              typeof part.caller.type !== "string"
            ) {
              invalidRequest(
                "assistant tool_use caller must be a caller object when provided",
              );
            }
            if (part.caller.type !== "direct") {
              if (String(part.caller.type).startsWith("code_execution_")) {
                invalidRequest(
                  "code-execution tool-use history has no OpenAI function-call equivalent",
                );
              }
              invalidRequest("assistant tool_use caller must be direct");
            }
          }
        }
        if (part.type === "tool_result") {
          if (
            message.role !== "user" ||
            typeof part.tool_use_id !== "string" ||
            part.tool_use_id.length === 0
          ) {
            invalidRequest(
              "user tool_result blocks require a non-empty tool_use_id",
            );
          }
          if (part.is_error !== undefined && typeof part.is_error !== "boolean") {
            invalidRequest("tool_result.is_error must be a boolean when provided");
          }
          hasCitationsEnabledContent = validateToolResultContent(
            part.content,
            `messages[${messageIndex}].tool_result.content`,
          ) || hasCitationsEnabledContent;
        }
        if (
          message.role === "assistant" &&
          part.type === "thinking" &&
          (typeof part.signature !== "string" || part.signature.length === 0)
        ) {
          invalidRequest(
            "assistant thinking blocks must include a non-empty signature",
          );
        }
        if (isAnthropicServerHistoryBlock(part)) {
          invalidRequest(
            "Anthropic server-tool history has no OpenAI function-tool equivalent",
          );
        }
        if (ANTHROPIC_OPAQUE_CONTROL_BLOCK_TYPES.has(part.type)) {
          invalidRequest(
            `Anthropic ${part.type} blocks have no replay-safe OpenAI equivalent`,
          );
        }
      }
    }
  }
  validateMidConversationSystemPlacement(messages);

  const tools = request.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    invalidRequest("tools must be an array");
  }
  for (const tool of tools ?? []) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      invalidRequest("each tool must be an object");
    }
    if (isAnthropicServerToolDefinition(tool)) {
      invalidRequest(
        "Anthropic server-side tools have no OpenAI function-tool equivalent",
      );
    }
    if (isAnthropicTypedClientToolDefinition(tool)) {
      invalidRequest(
        "Anthropic typed client tools require a version-specific OpenAI function schema",
      );
    }
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      invalidRequest("each client tool must have a non-empty name");
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      invalidRequest("tool.strict must be a boolean when provided");
    }
    if (
      tool.defer_loading !== undefined &&
      typeof tool.defer_loading !== "boolean"
    ) {
      invalidRequest("tool.defer_loading must be a boolean when provided");
    }
    if (tool.allowed_callers !== undefined) {
      if (
        !Array.isArray(tool.allowed_callers) ||
        tool.allowed_callers.length === 0 ||
        tool.allowed_callers.some(
          (caller: unknown) =>
            typeof caller !== "string" ||
            !ANTHROPIC_TOOL_CALLERS.has(caller),
        )
      ) {
        invalidRequest("tool.allowed_callers must contain known caller values");
      }
      if (tool.allowed_callers.some((caller: string) => caller !== "direct")) {
        invalidRequest(
          "code-execution tool callers have no OpenAI function-tool equivalent",
        );
      }
    }
  }
  if (
    (tools?.length ?? 0) > 0 &&
    tools.every((tool: any) => tool?.defer_loading === true)
  ) {
    invalidRequest("at least one tool must not use defer_loading");
  }

  const toolChoice = request.tool_choice;
  if (toolChoice !== undefined) {
    if (
      !toolChoice ||
      typeof toolChoice !== "object" ||
      Array.isArray(toolChoice)
    ) {
      invalidRequest("tool_choice must be an object");
    }
    if (!["auto", "any", "tool", "none"].includes(toolChoice.type)) {
      invalidRequest(
        'tool_choice.type must be "auto", "any", "tool", or "none"',
      );
    }
    if (
      toolChoice.disable_parallel_tool_use !== undefined &&
      typeof toolChoice.disable_parallel_tool_use !== "boolean"
    ) {
      invalidRequest(
        "tool_choice.disable_parallel_tool_use must be a boolean when provided",
      );
    }
    if (
      toolChoice.type === "tool" &&
      (typeof toolChoice.name !== "string" || toolChoice.name.length === 0)
    ) {
      invalidRequest("named tool_choice must include a non-empty name");
    }
    if (
      toolChoice.type === "none" &&
      toolChoice.disable_parallel_tool_use !== undefined
    ) {
      invalidRequest(
        "tool_choice none cannot include disable_parallel_tool_use",
      );
    }
  }

  const outputConfig = request.output_config;
  if (
    outputConfig !== undefined &&
    (!outputConfig ||
      typeof outputConfig !== "object" ||
      Array.isArray(outputConfig))
  ) {
    invalidRequest("output_config must be an object");
  }
  const outputFormat = outputConfig?.format;
  if (outputFormat !== undefined && outputFormat !== null) {
    if (
      !outputFormat ||
      typeof outputFormat !== "object" ||
      Array.isArray(outputFormat) ||
      outputFormat.type !== "json_schema" ||
      !outputFormat.schema ||
      typeof outputFormat.schema !== "object" ||
      Array.isArray(outputFormat.schema)
    ) {
      invalidRequest(
        'output_config.format must be a "json_schema" object with an object schema',
      );
    }
    if (hasCitationsEnabledContent) {
      invalidRequest(
        "output_config.format cannot be combined with document or search_result citations",
      );
    }
  }
  if (hasCitationsEnabledContent) {
    invalidRequest(
      "document and search_result citations have no OpenAI protocol equivalent",
    );
  }
  const effort = outputConfig?.effort;
  if (
    effort !== undefined &&
    effort !== null &&
    parseAnthropicEffort(effort) === undefined
  ) {
    invalidRequest(
      'output_config.effort must be "low", "medium", "high", "xhigh", "max", or null',
    );
  }

  const thinking = request.thinking;
  if (thinking !== undefined) {
    if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
      invalidRequest("thinking must be an object");
    }
    if (
      thinking.type !== "enabled" &&
      thinking.type !== "adaptive" &&
      thinking.type !== "disabled"
    ) {
      invalidRequest(
        'thinking.type must be "enabled", "adaptive", or "disabled"',
      );
    }
    if (
      thinking.display !== undefined &&
      thinking.display !== null &&
      thinking.display !== "summarized" &&
      thinking.display !== "omitted"
    ) {
      invalidRequest(
        'thinking.display must be "summarized", "omitted", or null',
      );
    }
    if (thinking.type === "disabled" && thinking.display !== undefined) {
      invalidRequest("thinking.display is not valid when thinking is disabled");
    }
    if (thinking.type === "enabled") {
      // Deliberately do not require budget_tokens < max_tokens here:
      // Anthropic permits the opposite for interleaved thinking with tools.
      // The Router must accept that valid client shape without guessing model
      // support from the model name or forwarding Anthropic beta headers.
      if (
        typeof thinking.budget_tokens !== "number" ||
        !Number.isFinite(thinking.budget_tokens) ||
        !Number.isInteger(thinking.budget_tokens) ||
        thinking.budget_tokens < 1024
      ) {
        invalidRequest(
          "thinking.budget_tokens must be a finite integer greater than or equal to 1024 when thinking is enabled",
        );
      }
    } else if (thinking.budget_tokens !== undefined) {
      invalidRequest(
        "thinking.budget_tokens is only valid when thinking.type is enabled",
      );
    }
    if (
      thinking.type === "enabled" &&
      (request.tool_choice?.type === "any" ||
        request.tool_choice?.type === "tool")
    ) {
      invalidRequest(
        "forced tool_choice is not compatible with manually enabled thinking",
      );
    }
  }
}

function convertToolResultContent(content: unknown, isError: boolean): any {
  const errorMarker = isError
    ? [{ type: "text" as const, text: TOOL_RESULT_ERROR_MARKER }]
    : [];
  if (content == null) return isError ? errorMarker : "";
  if (typeof content === "string") {
    return isError
      ? [...errorMarker, { type: "text" as const, text: content }]
      : content;
  }

  const blocks = Array.isArray(content) ? content : [content];
  if (blocks.length === 0) return isError ? errorMarker : "";

  const visibleBlocks = blocks.filter(
    (block: any) => block?.type !== "tool_reference",
  );
  if (visibleBlocks.length === 0) return isError ? errorMarker : "";

  const converted = visibleBlocks.flatMap((block: any) => {
    if (typeof block === "string") {
      return { type: "text" as const, text: block };
    }
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "text" as const, text: block.text };
    }
    if (block?.type === "image") {
      const image = convertAnthropicImage(block);
      if (image) return image;
    }
    if (block?.type === "document") {
      return convertAnthropicDocumentBlocks(block);
    }
    if (block?.type === "search_result") {
      return convertAnthropicSearchResult(block);
    }
    return { type: "text" as const, text: boundedJsonBlockText(block) };
  });
  return [...errorMarker, ...converted];
}

export class AnthropicTransformer implements Transformer {
  name = "Anthropic";
  endPoint = "/v1/messages";
  private useBearer: boolean;
  logger?: any;

  constructor(private readonly options?: TransformerOptions) {
    this.useBearer = this.options?.UseBearer ?? false;
  }

  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      headers["x-api-key"] = undefined;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers["authorization"] = undefined;
    }

    return {
      body: request,
      config: {
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    validateAnthropicRequestShape(request);
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = normalizeSystemBlocks(request.system);
        // Never emit a message whose content is an empty array — Chat
        // Completions rejects that shape outright.
        if (textParts.length) {
          messages.push({
            role: "system",
            content: textParts,
          });
        }
      }
    }

    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    requestMessages?.forEach((msg: any) => {
      if (msg.role === "system") {
        if (typeof msg.content === "string") {
          messages.push({ role: "system", content: msg.content });
        } else {
          const textParts = normalizeSystemBlocks(
            expandMidConversationSystemBlocks(msg.content).filter(
              (block: any) => !isToolChangeBlock(block),
            ),
          );
          // Pure tool-change messages have already been projected into the
          // final top-level tool set and must not become model-visible JSON.
          if (textParts.length) {
            messages.push({ role: "system", content: textParts });
          }
        }
        return;
      }

      if (msg.role === "user" || msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          if (msg.role === "user") {
            const toolParts = msg.content.filter(
              (c: any) => c.type === "tool_result" && c.tool_use_id
            );
            if (toolParts.length) {
              toolParts.forEach((tool: any) => {
                const toolMessage: UnifiedMessage = {
                  role: "tool",
                  content: convertToolResultContent(
                    tool.content,
                    tool.is_error === true,
                  ),
                  tool_call_id: tool.tool_use_id,
                };
                if (tool.cache_control) {
                  toolMessage.cache_control = tool.cache_control;
                }
                messages.push(toolMessage);
              });
            }

            // Walk every non-tool_result block so a turn made only of unknown
            // blocks degrades per-block (mirroring convertToolResultContent)
            // instead of silently deleting the whole turn, and so an
            // unconvertible image can never leave behind `content: []`.
            const contentParts: any[] = [];
            for (const part of msg.content) {
              if (part?.type === "tool_result" && part.tool_use_id) {
                continue; // emitted as a tool message above
              }
              if (part?.type === "text" && typeof part.text === "string") {
                if (part.text) {
                  // Rebuild the part instead of forwarding the original block:
                  // Anthropic-only siblings (citations, ...) must not leak into
                  // Chat content parts. cache_control survives until the
                  // pipeline-level scrub.
                  contentParts.push({
                    type: "text",
                    text: part.text,
                    ...(part.cache_control
                      ? { cache_control: part.cache_control }
                      : {}),
                  });
                }
                continue;
              }
              if (part?.type === "image" && part.source) {
                const image = convertAnthropicImage(part);
                if (image) {
                  contentParts.push(image);
                  continue;
                }
              }
              if (part?.type === "document") {
                contentParts.push(...convertAnthropicDocumentBlocks(part));
                continue;
              }
              if (part?.type === "search_result") {
                contentParts.push(...convertAnthropicSearchResult(part));
                continue;
              }
              contentParts.push({
                type: "text",
                text: boundedJsonBlockText(part),
              });
            }
            if (contentParts.length) {
              messages.push({
                role: "user",
                content: contentParts,
              });
            } else if (toolParts.length === 0) {
              // An empty/empty-text user turn is still a turn. Preserve its
              // role and ordering instead of silently deleting it; validation
              // of semantic emptiness belongs to the selected upstream.
              messages.push({ role: "user", content: "" });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const orderedBlocks: Array<Record<string, any>> = [];
            for (const part of msg.content) {
              if (part?.type === "text" && typeof part.text === "string") {
                orderedBlocks.push({ type: "text", text: part.text });
              } else if (
                part?.type === "tool_use" &&
                part.id &&
                part.name
              ) {
                orderedBlocks.push({
                  type: "tool_use",
                  id: part.id,
                  name: part.name,
                  input:
                    part.input &&
                    typeof part.input === "object" &&
                    !Array.isArray(part.input)
                      ? part.input
                      : {},
                });
              } else if (part?.type === "thinking" && part.signature) {
                orderedBlocks.push({
                  type: "thinking",
                  thinking: part.thinking ?? "",
                  signature: part.signature,
                });
              } else if (part?.type !== "thinking") {
                orderedBlocks.push({
                  type: "text",
                  text: boundedJsonBlockText(part),
                });
              }
            }
            assistantMessage.output_blocks = orderedBlocks;
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            // Preserve future/unsupported assistant blocks as bounded text
            // instead of silently erasing history. Signed thinking and tool
            // calls have dedicated mappings. redacted_thinking was rejected by
            // shape validation because it cannot be replayed safely.
            const fallbackParts = msg.content
              .filter(
                (part: any) =>
                  part?.type !== "text" &&
                  part?.type !== "tool_use" &&
                  part?.type !== "thinking",
              )
              .map((part: any) => boundedJsonBlockText(part));
            if (textParts.length || fallbackParts.length) {
              assistantMessage.content = [
                ...textParts.map((text: any) => text.text),
                ...fallbackParts,
              ].join("\n");
            }

            const toolCallParts = msg.content.filter(
              (c: any) => c.type === "tool_use" && c.id
            );
            if (toolCallParts.length) {
              assistantMessage.tool_calls = toolCallParts.map((tool: any) => {
                return {
                  id: tool.id,
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input || {}),
                  },
                };
              });
            }

            // Collect EVERY signed thinking block in order, remembering which
            // tool call each block immediately preceded. Keeping only the
            // first block would collapse interleaved Responses reasoning items
            // on replay (`thinking` stays single-valued for the Chat path).
            const thinkingBlocks: NonNullable<
              UnifiedMessage["thinking_blocks"]
            > = [];
            let pendingThinking: typeof thinkingBlocks = [];
            for (const part of msg.content) {
              if (part?.type === "thinking" && part.signature) {
                pendingThinking.push({
                  content: part.thinking,
                  signature: part.signature,
                });
              } else if (part?.type === "tool_use" && part.id) {
                for (const block of pendingThinking) {
                  block.tool_call_id = part.id;
                }
                thinkingBlocks.push(...pendingThinking);
                pendingThinking = [];
              } else if (pendingThinking.length) {
                // A visible/non-tool block breaks adjacency. In particular,
                // `[thinking, text, tool_use]` means the reasoning produced the
                // text, not the later tool call; pairing across the text would
                // replay it as `[text, reasoning, function_call]`.
                thinkingBlocks.push(...pendingThinking);
                pendingThinking = [];
              }
            }
            thinkingBlocks.push(...pendingThinking);
            if (thinkingBlocks.length) {
              assistantMessage.thinking = {
                content: thinkingBlocks[0].content ?? "",
                signature: thinkingBlocks[0].signature,
              };
              assistantMessage.thinking_blocks = thinkingBlocks;
            }

            messages.push(assistantMessage);
          }
          return;
        }
      }
    });

    const activeTools = resolveActiveAnthropicTools(
      request.tools,
      requestMessages,
    );
    const activeToolNames = new Set(
      (activeTools ?? []).flatMap((tool) =>
        typeof tool?.name === "string" ? [tool.name] : [],
      ),
    );
    if (
      request.tool_choice?.type === "tool" &&
      !activeToolNames.has(request.tool_choice.name)
    ) {
      invalidRequest(
        `tool_choice references inactive tool ${JSON.stringify(request.tool_choice.name)}`,
      );
    }
    if (request.tool_choice?.type === "any" && activeToolNames.size === 0) {
      invalidRequest("tool_choice any requires at least one active tool");
    }
    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop_sequences,
      stream: request.stream,
      tools: activeTools?.length
        ? this.convertAnthropicToolsToUnified(activeTools)
        : undefined,
      tool_choice: request.tool_choice,
    };
    if (request.output_config?.format?.type === "json_schema") {
      result.response_format = {
        type: "json_schema",
        json_schema: {
          name: "anthropic_output",
          schema: request.output_config.format.schema,
          strict: true,
        },
      };
    }
    const explicitEffort = parseAnthropicEffort(
      request.output_config?.effort,
    );
    if (explicitEffort) {
      result.reasoning_effort = explicitEffort;
    }
    if (
      request.thinking?.type === "enabled" ||
      request.thinking?.type === "adaptive"
    ) {
      // No explicit effort and no budget → omit effort entirely; the upstream
      // default must apply rather than an assumed tier.
      const effort =
        explicitEffort ?? getThinkLevel(request.thinking.budget_tokens);
      result.reasoning = {
        ...(effort ? { effort } : {}),
        enabled: true,
        ...(request.thinking.display
          ? { display: request.thinking.display }
          : {}),
      };
    }
    if (request.tool_choice) {
      if (typeof request.tool_choice.disable_parallel_tool_use === "boolean") {
        result.parallel_tool_calls =
          !request.tool_choice.disable_parallel_tool_use;
      }
      if (request.tool_choice.type === "tool") {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      } else if (request.tool_choice.type === "any") {
        // Anthropic "any" (model must call a tool) == OpenAI "required".
        // Passing the literal "any" through 400s on OpenAI-shaped upstreams.
        result.tool_choice = "required";
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }
    return result;
  }

  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");
    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      const convertedStream = await this.convertOpenAIStreamToAnthropic(
        response.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      const data = (await response.json()) as any;
      if (data?.error) {
        // Chat-shaped gateways often report failures as an `error` object inside
        // an HTTP 200. Derive the status and the Anthropic error vocabulary from
        // what the upstream actually said instead of collapsing everything to a
        // 500 that clients cannot act on.
        const { status, type } = mapOpenAIErrorToAnthropic(
          data.error,
          response.status,
        );
        return new Response(
          JSON.stringify({
            type: "error",
            request_id:
              typeof data.request_id === "string" ? data.request_id : null,
            error: {
              type,
              message:
                typeof data.error.message === "string" && data.error.message
                  ? data.error.message
                  : boundedJsonBlockText(data.error),
            },
          }),
          {
            status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const anthropicResponse = this.convertOpenAIResponseToAnthropic(
        data,
        context!
      );
      return new Response(JSON.stringify(anthropicResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private convertAnthropicToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        // A tool without input_schema must still produce a syntactically valid
        // OpenAI function declaration.
        parameters: tool.input_schema ?? { type: "object", properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    const omitThinking = omitsThinkingDisplay(context);
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let downstreamCancelled = false;
    const readable = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const messageId = `msg_${Date.now()}`;
        let stopReasonMessageDelta: null | Record<string, any> = null;
        let model = "unknown";
        let hasStarted = false;
        let hasTextContentStarted = false;
        let hasFinished = false;
        let streamFailed = false;
        let sawTerminal = false;
        let sawDone = false;
        let refusalExplanation = "";
        const toolCalls = new Map<number, any>();
        let legacyFunctionCallId: string | null = null;
        let totalChunks = 0;
        let contentChunks = 0;
        let toolCallChunks = 0;
        let isClosed = false;
        let deferSemanticFrames = false;
        type DeferredFrame = {
          data: Uint8Array;
          kind: "tool" | "other";
          incompleteReplacement?: Uint8Array[];
        };
        let deferredFrames: DeferredFrame[] = [];
        const deferredToolCalls: any[] = [];
        // Tracks reasoning_content-derived thinking that still needs a synthetic
        // signature_delta to seal the thinking block (see normalization below).
        let reasoningThinkingActive = false;
        let reasoningSignatureSent = false;
        let reasoningReplayText = "";
        let contentIndex = 0;
        let currentContentBlockIndex = -1; // Track the current content block index
        // Type of the currently open content block. Needed because interleaved
        // reasoning/content chunks (e.g. qwen vision) can otherwise route
        // signature/thinking deltas onto a text block, which Anthropic clients
        // reject ("Content block is not a thinking block").
        let currentBlockType: "text" | "thinking" | "tool" | null = null;

        // 原子性的content block index分配函数
        const assignContentBlockIndex = (): number => {
          const currentIndex = contentIndex;
          contentIndex++;
          return currentIndex;
        };

        const safeEnqueue = (
          data: Uint8Array,
          kind: DeferredFrame["kind"] = "other",
          incompleteReplacement?: Uint8Array[],
        ) => {
          if (downstreamCancelled) {
            isClosed = true;
            return;
          }
          if (deferSemanticFrames) {
            deferredFrames.push({ data, kind, incompleteReplacement });
            return;
          }
          if (!isClosed) {
            try {
              controller.enqueue(data);
              const dataStr = new TextDecoder().decode(data);
              this.logger?.debug({
                reqId: context.req.id,
                data: dataStr,
                type: "send data",
              });
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                this.logger?.debug({
                  reqId: context.req.id,
                  error: error instanceof Error ? error.message : String(error),
                  type: "send data error",
                });
                throw error;
              }
            }
          }
        };

        const releaseDeferredFrames = (incomplete: boolean) => {
          deferSemanticFrames = false;
          const frames = deferredFrames;
          deferredFrames = [];
          for (const frame of frames) {
            if (frame.kind === "tool" && incomplete) {
              for (const replacement of frame.incompleteReplacement ?? []) {
                safeEnqueue(replacement);
              }
              continue;
            }
            safeEnqueue(frame.data);
          }
          deferredToolCalls.length = 0;
        };

        const discardDeferredToolFrames = () => {
          deferSemanticFrames = false;
          deferredFrames = [];
          deferredToolCalls.length = 0;
          toolCalls.clear();
        };

        // Close the currently open content block, if any. An unsigned thinking
        // block is sealed with a synthetic signature_delta first — Anthropic
        // requires a signature before content_block_stop on thinking blocks.
        const closeCurrentBlock = () => {
          if (currentContentBlockIndex < 0) return;
          if (currentBlockType === "thinking" && !reasoningSignatureSent) {
            safeEnqueue(
              encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: currentContentBlockIndex,
                  delta: {
                    type: "signature_delta",
                    signature: encodeChatReasoningSignature(
                      reasoningReplayText,
                    ),
                  },
                })}\n\n`
              )
            );
            reasoningSignatureSent = true;
            reasoningThinkingActive = false;
          }
          safeEnqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: currentContentBlockIndex,
              })}\n\n`
            )
          );
          if (currentBlockType === "text") {
            hasTextContentStarted = false;
          }
          currentContentBlockIndex = -1;
          currentBlockType = null;
          reasoningReplayText = "";
        };

        // Anthropic content blocks cannot be interleaved. OpenAI can stream
        // deltas for several tool calls in parallel, so buffer by tool index
        // and emit complete, sequential Anthropic blocks at a safe boundary.
        const buildIncompleteToolFrames = (
          blockIndex: number,
          toolCall: any,
        ): Uint8Array[] => {
          const text = incompleteToolCallText(
            toolCall.name,
            toolCall.arguments,
          );
          return [
            encoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`,
            ),
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text },
              })}\n\n`,
            ),
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: blockIndex,
              })}\n\n`,
            ),
          ];
        };

        const flushToolCalls = (requireCompleteJson = true) => {
          if (toolCalls.size === 0) return;
          // Validate every buffered call before emitting any tool_use block.
          // Otherwise malformed JSON becomes an executable-looking Anthropic
          // tool turn and can trigger a tool despite the upstream protocol
          // response being invalid.
          if (!deferSemanticFrames) {
            for (const toolCall of toolCalls.values()) {
              if (!toolCall.id || !toolCall.name) {
                throw createApiError(
                  "upstream tool call is missing id or function name",
                  502,
                  "upstream_protocol_error",
                  "api_error",
                );
              }
              if (requireCompleteJson) {
                parseUpstreamToolInput(toolCall.arguments);
              }
            }
          }
          closeCurrentBlock();
          for (const [, toolCall] of [...toolCalls.entries()].sort(
            ([left], [right]) => left - right,
          )) {
            if (deferSemanticFrames) {
              deferredToolCalls.push({ ...toolCall });
            }
            const blockIndex = assignContentBlockIndex();
            safeEnqueue(
              encoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolCall.id,
                    name: toolCall.name,
                    input: {},
                    caller: { type: "direct" },
                  },
                })}\n\n`,
              ),
              "tool",
              buildIncompleteToolFrames(blockIndex, toolCall),
            );
            if (toolCall.arguments) {
              safeEnqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: toolCall.arguments,
                    },
                  })}\n\n`,
                ),
                "tool",
              );
            }
            safeEnqueue(
              encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: blockIndex,
                })}\n\n`,
              ),
              "tool",
            );
          }
          toolCalls.clear();
        };

        const safeClose = () => {
          if (downstreamCancelled) {
            isClosed = true;
            return;
          }
          if (!isClosed) {
            try {
              if (!hasStarted) {
                deferSemanticFrames = false;
                deferredFrames = [];
                deferredToolCalls.length = 0;
                safeEnqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      type: "error",
                      request_id: null,
                      error: {
                        type: "api_error",
                        message:
                          "upstream stream ended without response events",
                      },
                    })}\n\n`,
                  ),
                );
                controller.close();
                isClosed = true;
                return;
              }
              if (!sawTerminal) {
                const truncatedToolCall =
                  deferredToolCalls.length > 0 || toolCalls.size > 0;
                // EOF without either a finish_reason or [DONE] is a transport /
                // protocol cutoff, not evidence that the model hit max_tokens.
                // Preserve bytes already received (including a non-executable
                // diagnostic for a partial tool call), then end with an error.
                if (!sawDone) {
                  flushToolCalls(false);
                  closeCurrentBlock();
                  releaseDeferredFrames(truncatedToolCall);
                  safeEnqueue(
                    encoder.encode(
                      `event: error\ndata: ${JSON.stringify({
                        type: "error",
                        request_id: null,
                        error: {
                          type: "api_error",
                          message:
                            "upstream stream ended before a terminal event",
                        },
                      })}\n\n`,
                    ),
                  );
                  controller.close();
                  isClosed = true;
                  return;
                }
                // Several OpenAI-compatible gateways stream content and then
                // close with `[DONE]` without ever sending a finish_reason.
                // Dropping the whole answer here loses real work, so synthesize
                // a well-formed terminal instead — Anthropic's contract wants a
                // message_delta carrying stop_reason before message_stop, so
                // emitting message_stop alone is not an option either.
                //
                // Which terminal is decided by the upstream's own framing, not
                // by guesswork: `[DONE]` is the upstream declaring the stream
                // complete, so the turn ends normally; a body that just stopped
                // arriving was genuinely cut short and must not be advertised
                // as a successful completion.
                //
                // A tool call still buffered at this point never got a terminal
                // to validate it. It is treated exactly like a `length` cutoff:
                // the received bytes survive as text, but the turn must not
                // claim an executable tool_use.
                const truncated = truncatedToolCall;
                // Same order as the finish_reason path: move still-open calls
                // into the deferred sequence without demanding complete JSON,
                // then release them as degraded text.
                flushToolCalls(false);
                closeCurrentBlock();
                releaseDeferredFrames(truncatedToolCall);
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: {
                        container: null,
                        stop_reason: truncated ? "max_tokens" : "end_turn",
                        stop_sequence: null,
                        stop_details: null,
                      },
                      usage:
                        stopReasonMessageDelta?.usage ??
                        emptyAnthropicDeltaUsage(),
                    })}\n\n`,
                  ),
                );
                safeEnqueue(
                  encoder.encode(
                    `event: message_stop\ndata: ${JSON.stringify({
                      type: "message_stop",
                    })}\n\n`,
                  ),
                );
                controller.close();
                isClosed = true;
                return;
              }
              flushToolCalls();
              closeCurrentBlock();

              if (stopReasonMessageDelta) {
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify(
                      stopReasonMessageDelta
                    )}\n\n`
                  )
                );
                stopReasonMessageDelta = null;
              } else {
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: {
                        container: null,
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        stop_details: null,
                      },
                      usage: emptyAnthropicDeltaUsage(),
                    })}\n\n`
                  )
                );
              }
              const messageStop = {
                type: "message_stop",
              };
              safeEnqueue(
                encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify(
                    messageStop
                  )}\n\n`
                )
              );
              controller.close();
              isClosed = true;
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                throw error;
              }
            }
          }
        };

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
          reader = openaiStream.getReader();
          activeReader = reader;
          const sseDecoder = new SseBlockDecoder();

          while (true) {
            if (isClosed || downstreamCancelled) {
              break;
            }

            const { done, value } = await reader.read();
            const events = done
              ? sseDecoder.finish()
              : sseDecoder.push(value);

            for (const event of events) {
              if (isClosed || streamFailed) break;

              const data = event.data.trim();
              if (!omitThinking) {
                this.logger?.debug({
                  reqId: context.req.id,
                  type: "recieved data",
                  data,
                });
              }

              if (!data) {
                // An SSE event with an empty data field is legal (WHATWG) and
                // used as a keepalive by some proxies. It is not upstream
                // corruption — skip it instead of failing the stream.
                continue;
              }

              if (data === "[DONE]") {
                // `[DONE]` is a framing terminator, not proof of a successful
                // completion. Stop reading now; safeClose() still requires a
                // preceding finish_reason before it can emit message_stop.
                sawDone = true;
                break;
              }

              // Parse and convert in separate try blocks: a payload that is
              // not JSON is genuine upstream corruption (fatal, "malformed"),
              // while an exception thrown by the conversion below is a router
              // bug and must not be blamed on the upstream's framing.
              let chunk: any;
              try {
                chunk = JSON.parse(data);
              } catch (parseError: any) {
                this.logger?.error(
                  `parseError: ${parseError.name} message: ${parseError.message} data: ${omitThinking ? "[omitted by thinking.display]" : data}`,
                );
                discardDeferredToolFrames();
                safeEnqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      type: "error",
                      request_id: null,
                      error: {
                        type: "api_error",
                        message: "malformed upstream SSE event",
                      },
                    })}\n\n`,
                  ),
                );
                streamFailed = true;
                hasFinished = true;
                break;
              }

              try {
                totalChunks++;
                if (!omitThinking) {
                  this.logger?.debug({
                    reqId: context.req.id,
                    response: chunk,
                    tppe: "Original Response",
                  });
                }
                if (chunk.error) {
                  const errorMessage = {
                    type: "error",
                    request_id: null,
                    error: {
                      type:
                        chunk.error.type || chunk.error.code || "api_error",
                      message:
                        chunk.error.message || JSON.stringify(chunk.error),
                      ...(Number.isInteger(chunk.error.status) &&
                      chunk.error.status >= 400 &&
                      chunk.error.status <= 599
                        ? { status: chunk.error.status }
                        : {}),
                    },
                  };

                  // A protocol/semantic error is terminal and must never sit
                  // behind deferred tool frames (which are intentionally held
                  // until a successful finish_reason makes them executable).
                  discardDeferredToolFrames();
                  safeEnqueue(
                    encoder.encode(
                      `event: error\ndata: ${JSON.stringify(errorMessage)}\n\n`
                    )
                  );
                  streamFailed = true;
                  hasFinished = true;
                  break;
                }

                model = chunk.model || model;

                if (!hasStarted && !isClosed && !hasFinished) {
                  hasStarted = true;

                  const messageStart = {
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      container: null,
                      content: [],
                      model: model,
                      stop_reason: null,
                      stop_sequence: null,
                      stop_details: null,
                      usage: emptyAnthropicUsage(0, chunk.service_tier),
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: message_start\ndata: ${JSON.stringify(
                        messageStart
                      )}\n\n`
                    )
                  );
                }

                const choice = chunk.choices?.[0];
                if (chunk.usage) {
                  if (!stopReasonMessageDelta) {
                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        container: null,
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        stop_details: null,
                      },
                      usage: convertDeltaUsage(chunk.usage),
                    };
                  } else {
                    stopReasonMessageDelta.usage = convertDeltaUsage(chunk.usage);
                  }
                }
                if (!choice) {
                  continue;
                }
                if (hasFinished) {
                  // A terminal choice can be followed by a usage-only chunk.
                  // Keep parsing metadata, but never accept more semantic deltas.
                  continue;
                }
                // delta.content may legally be an array of content parts —
                // normalize to a string, and never let `||` short-circuit away
                // a refusal that arrives alongside content.
                const rawDeltaContent = choice?.delta?.content;
                const deltaContentText =
                  typeof rawDeltaContent === "string"
                    ? rawDeltaContent
                    : Array.isArray(rawDeltaContent)
                      ? rawDeltaContent.map(chatContentPartToText).join("")
                      : "";
                const deltaRefusalText =
                  typeof (choice?.delta as any)?.refusal === "string"
                    ? (choice.delta as any).refusal
                    : "";
                if (deltaRefusalText) {
                  refusalExplanation += deltaRefusalText;
                }
                const choiceText = deltaContentText + deltaRefusalText;

                // Legacy Chat upstreams stream tool calls as delta.function_call.
                // Normalize to the modern tool_calls shape so the call is not
                // silently discarded behind a successful-looking empty turn.
                if (
                  (choice?.delta as any)?.function_call &&
                  !choice?.delta?.tool_calls
                ) {
                  const legacyCall = (choice.delta as any).function_call;
                  legacyFunctionCallId ??= `call_${uuidv4()}`;
                  (choice.delta as any).tool_calls = [
                    {
                      index: 0,
                      id: legacyFunctionCallId,
                      function: {
                        ...(typeof legacyCall.name === "string"
                          ? { name: legacyCall.name }
                          : {}),
                        ...(typeof legacyCall.arguments === "string"
                          ? { arguments: legacyCall.arguments }
                          : {}),
                      },
                    },
                  ];
                }

                // DeepSeek/Kimi-style upstreams stream reasoning as a
                // `reasoning_content` string rather than Anthropic's `thinking`
                // object. Normalize it so the thinking-block handling below
                // renders it as Anthropic thinking deltas instead of dropping it.
                if (
                  (choice?.delta as any)?.reasoning_content &&
                  !(choice.delta as any).thinking
                ) {
                  (choice.delta as any).thinking = {
                    content: (choice.delta as any).reasoning_content,
                  };
                  reasoningThinkingActive = true;
                } else if (
                  reasoningThinkingActive &&
                  !reasoningSignatureSent &&
                  !(choice?.delta as any)?.thinking &&
                  (choiceText || choice?.delta?.tool_calls)
                ) {
                  // First content/tool_call after a reasoning_content run: the
                  // thinking block must be sealed with a signature_delta before
                  // content_block_stop. The upstream gave none, so synthesize a
                  // reversible Router envelope. Routed through the signature
                  // branch below.
                  (choice.delta as any).thinking = {
                    signature: encodeChatReasoningSignature(
                      reasoningReplayText,
                    ),
                  };
                  reasoningSignatureSent = true;
                  reasoningThinkingActive = false;
                }

                if (choice?.delta?.thinking && !isClosed && !hasFinished) {
                  // Some compatible Chat endpoints coalesce content and
                  // signature into the same thinking delta. Process content
                  // first so the signature seals those exact bytes instead of
                  // silently discarding them behind an otherwise valid stream.
                  if (choice.delta.thinking.content) {
                    if (currentBlockType !== "thinking") {
                      // Reasoning resumed after content/tool output (or first
                      // reasoning chunk): close whatever block is open and
                      // start a fresh thinking block.
                      flushToolCalls();
                      closeCurrentBlock();
                      const thinkingBlockIndex = assignContentBlockIndex();
                      const contentBlockStart = {
                        type: "content_block_start",
                        index: thinkingBlockIndex,
                        content_block: { type: "thinking", thinking: "" },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(
                            contentBlockStart
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = thinkingBlockIndex;
                      currentBlockType = "thinking";
                      reasoningSignatureSent = false;
                      reasoningReplayText = "";
                    }
                    reasoningReplayText += choice.delta.thinking.content;
                    // Anthropic `display:"omitted"` keeps the ordinary
                    // thinking block and its signature, but emits no visible
                    // thinking delta. Only an explicit client choice triggers
                    // this; the router never guesses a model-specific default.
                    if (!omitThinking) {
                      const thinkingChunk = {
                        type: "content_block_delta",
                        index: currentContentBlockIndex,
                        delta: {
                          type: "thinking_delta",
                          thinking: choice.delta.thinking.content,
                        },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_delta\ndata: ${JSON.stringify(
                            thinkingChunk
                          )}\n\n`
                        )
                      );
                    }
                  }

                  if (choice.delta.thinking.signature) {
                    if (currentBlockType !== "thinking") {
                      // A signature-only item is still a real reasoning block.
                      // Tool deltas are buffered, so leave them pending and emit
                      // this block before them; never attach a signature to an
                      // already-open text block.
                      closeCurrentBlock();
                      const thinkingBlockIndex = assignContentBlockIndex();
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify({
                            type: "content_block_start",
                            index: thinkingBlockIndex,
                            content_block: {
                              type: "thinking",
                              thinking: "",
                            },
                          })}\n\n`,
                        ),
                      );
                      currentContentBlockIndex = thinkingBlockIndex;
                      currentBlockType = "thinking";
                      reasoningSignatureSent = false;
                      reasoningReplayText = "";
                    }
                    if (currentBlockType === "thinking") {
                      const thinkingSignature = {
                        type: "content_block_delta",
                        index: currentContentBlockIndex,
                        delta: {
                          type: "signature_delta",
                          // A native Chat extension signature is not something
                          // the generic Chat request path can replay. When the
                          // client asked to omit visible thinking, wrap the
                          // hidden bytes in our own reversible envelope instead
                          // of returning a token that would replay as an empty
                          // reasoning_content field on the next tool turn.
                          signature: omitThinking &&
                              reasoningReplayText &&
                              !isRouterOwnedReasoningSignature(
                                choice.delta.thinking.signature,
                              )
                            ? encodeChatReasoningSignature(reasoningReplayText)
                            : choice.delta.thinking.signature,
                        },
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_delta\ndata: ${JSON.stringify(
                            thinkingSignature
                          )}\n\n`
                        )
                      );
                      reasoningSignatureSent = true;
                      reasoningThinkingActive = false;
                      const contentBlockStop = {
                        type: "content_block_stop",
                        index: currentContentBlockIndex,
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(
                            contentBlockStop
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = -1;
                      currentBlockType = null;
                      reasoningReplayText = "";
                    }
                  }
                }

                const responseOutputBlock = (choice?.delta as any)
                  ?.response_output_block;
                if (
                  responseOutputBlock &&
                  typeof responseOutputBlock === "object" &&
                  !Array.isArray(responseOutputBlock) &&
                  !isClosed &&
                  !hasFinished
                ) {
                  flushToolCalls();
                  closeCurrentBlock();
                  const blockIndex = assignContentBlockIndex();
                  safeEnqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: responseOutputBlock,
                      })}\n\n`,
                    ),
                  );
                  safeEnqueue(
                    encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: blockIndex,
                      })}\n\n`,
                    ),
                  );
                  currentContentBlockIndex = -1;
                  currentBlockType = null;
                }

                if (choiceText && !isClosed && !hasFinished) {
                  contentChunks++;
                  flushToolCalls();

                  // Close any previous non-text block (seals an unsigned
                  // thinking block with its synthetic signature first).
                  if (currentBlockType !== "text") {
                    closeCurrentBlock();
                  }

                  if (!hasTextContentStarted && !hasFinished) {
                    hasTextContentStarted = true;
                    const textBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: textBlockIndex,
                      content_block: {
                        type: "text",
                        text: "",
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = textBlockIndex;
                    currentBlockType = "text";
                  }

                  if (!isClosed && !hasFinished) {
                    const anthropicChunk = {
                      type: "content_block_delta",
                      index: currentContentBlockIndex, // Use current content block index
                      delta: {
                        type: "text_delta",
                        text: choiceText,
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(
                          anthropicChunk
                        )}\n\n`
                      )
                    );
                  }
                }

                // A plain Chat annotation does not carry the corresponding
                // server-tool call/action. Preserve the source payload as
                // bounded visible text rather than fabricating an empty query.
                const urlCitationAnnotations = Array.isArray(
                  choice?.delta?.annotations,
                )
                  ? choice.delta.annotations.filter(
                      (annotation: any) =>
                        annotation?.type === "url_citation" &&
                        typeof annotation?.url_citation?.url === "string" &&
                        annotation.url_citation.url.length > 0,
                    )
                  : [];
                if (
                  urlCitationAnnotations.length &&
                  !isClosed &&
                  !hasFinished
                ) {
                  // Close the open content block (seals unsigned thinking).
                  flushToolCalls();
                  closeCurrentBlock();

                  const blockIndex = assignContentBlockIndex();
                  const citationText = boundedJsonBlockText({
                    type: "openai_url_citations",
                    annotations: urlCitationAnnotations,
                  });
                  safeEnqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "text", text: "" },
                      })}\n\n`,
                    ),
                  );
                  safeEnqueue(
                    encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "text_delta", text: citationText },
                      })}\n\n`,
                    ),
                  );
                  safeEnqueue(
                    encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: blockIndex,
                      })}\n\n`,
                    ),
                  );
                  currentContentBlockIndex = -1;
                }

                if (choice?.delta?.tool_calls && !isClosed && !hasFinished) {
                  toolCallChunks++;
                  // The final finish_reason is the execution boundary. Once a
                  // call starts, defer that call and every following semantic
                  // frame so a later length/refusal can replace tool_use with
                  // a non-executable diagnostic without losing subsequent text.
                  deferSemanticFrames = true;

                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const toolCallIndex = toolCall.index ?? 0;
                    let currentToolCall = toolCalls.get(toolCallIndex);
                    if (!currentToolCall) {
                      // Do not close a thinking block merely because tool-call
                      // arguments started. Tool blocks are buffered until a safe
                      // boundary, allowing a delayed native signature chunk to
                      // seal the reasoning block without being dropped.
                      currentToolCall = {
                        id: toolCall.id || "",
                        name: toolCall.function?.name || "",
                        arguments: "",
                      };
                      toolCalls.set(toolCallIndex, currentToolCall);
                    }
                    if (toolCall.id) currentToolCall.id = toolCall.id;
                    if (toolCall.function?.name) {
                      currentToolCall.name = toolCall.function.name;
                    }
                    if (toolCall.function?.arguments) {
                      currentToolCall.arguments += toolCall.function.arguments;
                    }
                  }
                }

                if (choice?.finish_reason && !isClosed && !hasFinished) {
                  const isRefusal =
                    choice.finish_reason === "content_filter" ||
                    refusalExplanation.length > 0;
                  // Validate the terminal before flushing buffered tools. An
                  // unknown terminal must never make a partial tool call look
                  // executable.
                  const anthropicStopReason = mapChatFinishReason(
                    choice.finish_reason,
                    isRefusal,
                  );
                  sawTerminal = true;
                  hasFinished = true;
                  if (contentChunks === 0 && toolCallChunks === 0) {
                    this.logger?.error(
                      "Warning: No content in the stream response!"
                    );
                  }

                  const incompleteTerminal =
                    choice.finish_reason === "length" || isRefusal;
                  // Move any still-open call into the deferred sequence. Calls
                  // flushed earlier at a text/thinking boundary are already in
                  // that sequence and remain uncommitted to the client.
                  flushToolCalls(false);
                  closeCurrentBlock();
                  if (!incompleteTerminal) {
                    for (const toolCall of deferredToolCalls) {
                      if (!toolCall.id || !toolCall.name) {
                        throw createApiError(
                          "upstream tool call is missing id or function name",
                          502,
                          "upstream_protocol_error",
                          "api_error",
                        );
                      }
                      parseUpstreamToolInput(toolCall.arguments);
                    }
                  }
                  releaseDeferredFrames(incompleteTerminal);

                  if (!isClosed) {
                    // Preserve usage captured from earlier chunks — replacing
                    // it wholesale zeroed the client's token accounting
                    // whenever usage arrived before the finish chunk.
                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        container: null,
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                        stop_details: isRefusal
                          ? refusalStopDetails(refusalExplanation)
                          : null,
                      },
                      usage: chunk.usage
                        ? convertDeltaUsage(chunk.usage)
                        : (stopReasonMessageDelta?.usage ??
                          emptyAnthropicDeltaUsage()),
                    };
                  }

                  continue;
                }
              } catch (conversionError: any) {
                discardDeferredToolFrames();
                this.logger?.error(
                  `conversionError: ${conversionError.name} message: ${conversionError.message} stack: ${conversionError.stack} data: ${omitThinking ? "[omitted by thinking.display]" : data}`,
                );
                safeEnqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      type: "error",
                      request_id: null,
                      error: {
                        type: "api_error",
                        message: "upstream response conversion failed",
                      },
                    })}\n\n`,
                  ),
                );
                streamFailed = true;
                hasFinished = true;
                break;
              }
            }

            if (streamFailed || sawDone) {
              try {
                await reader.cancel();
              } catch (cancelError) {
                this.logger?.error(
                  { err: cancelError },
                  "upstream stream cancel failed",
                );
              }
              break;
            }
            if (done) break;
          }
          if (downstreamCancelled) {
            isClosed = true;
          } else if (streamFailed) {
            if (!isClosed) {
              controller.close();
              isClosed = true;
            }
          } else {
            safeClose();
          }
        } catch (error) {
          if (!isClosed && !downstreamCancelled) {
            try {
              controller.error(error);
            } catch (controllerError) {
              this.logger?.error({ err: controllerError }, "controller.error failed");
            }
          }
        } finally {
          if (reader) {
            if (activeReader === reader) activeReader = null;
            try {
              reader.releaseLock();
            } catch (releaseError) {
              this.logger?.error({ err: releaseError }, "reader.releaseLock failed");
            }
          }
        }
      },
      cancel: async (reason) => {
        downstreamCancelled = true;
        this.logger?.debug(
          {
            reqId: context.req.id,
          },
          `cancel stream: ${reason}`
        );
        const reader = activeReader;
        if (reader) {
          try {
            await reader.cancel(reason);
          } catch (cancelError) {
            this.logger?.error(
              { err: cancelError },
              "upstream stream cancel failed",
            );
          }
        }
      },
    });

    return readable;
  }

  private convertOpenAIResponseToAnthropic(
    openaiResponse: ChatCompletion,
    context: TransformerContext
  ): any {
    const omitThinking = omitsThinkingDisplay(context);
    if (!omitThinking) {
      this.logger?.debug(
        {
          reqId: context.req.id,
          response: openaiResponse,
        },
        `Original OpenAI response`
      );
    }
    try {
      const choice = openaiResponse.choices?.[0];
      if (!choice?.message) {
        throw createApiError(
          "upstream Chat response contains no choice message",
          502,
          "upstream_protocol_error",
          "api_error",
        );
      }
      const message = choice.message as any;
      const content: any[] = [];
      const refusalText =
        typeof message.refusal === "string" ? message.refusal : "";
      const isRefusal =
        choice.finish_reason === "content_filter" || refusalText.length > 0;
      const hasIncompleteTerminal =
        choice.finish_reason === "length" || isRefusal;
      const orderedBlocks = message.output_blocks;

      if (Array.isArray(orderedBlocks)) {
        // Responses output is an ordered heterogeneous item stream. The
        // Responses transformer records that order in this Router-internal
        // field because ordinary Chat content/tool_calls fields cannot express
        // reasoning -> tool -> text interleaving without reordering it.
        for (const block of orderedBlocks) {
          if (block?.type === "thinking") {
            content.push({
              type: "thinking",
              thinking: omitThinking ? "" : (block.thinking ?? ""),
              signature: block.signature,
            });
          } else if (block?.type === "text") {
            content.push({ type: "text", text: block.text ?? "" });
          } else if (block?.type === "tool_use") {
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: parseUpstreamToolInput(block.input),
              caller: { type: "direct" },
            });
          } else if (
            block?.type === "server_tool_use" ||
            block?.type === "web_search_tool_result"
          ) {
            content.push(block);
          } else {
            content.push({ type: "text", text: boundedJsonBlockText(block) });
          }
        }
      } else {
        // Same guard as the streaming path: only a non-empty url_citation has
        // an Anthropic web-search representation.
        const urlCitationAnnotations = (message.annotations ?? []).filter(
          (item: any) =>
            item?.type === "url_citation" &&
            typeof item?.url_citation?.url === "string" &&
            item.url_citation.url.length > 0,
        );
        const citationFallbackText = urlCitationAnnotations.length
          ? boundedJsonBlockText({
            type: "openai_url_citations",
            annotations: urlCitationAnnotations,
          })
          : null;

        const upstreamThinkingBlocks = message.thinking_blocks;
        const thinkingByToolCall = new Map<string, any[]>();
        if (
          Array.isArray(upstreamThinkingBlocks) &&
          upstreamThinkingBlocks.length
        ) {
          const preToolThinking: any[] = [];
          for (const block of upstreamThinkingBlocks) {
            const reasoningContent = typeof block?.content === "string"
              ? block.content
              : "";
            const anthropicBlock = {
              type: "thinking",
              thinking: omitThinking ? "" : reasoningContent,
              signature: omitThinking &&
                  reasoningContent &&
                  !isRouterOwnedReasoningSignature(block?.signature)
                ? encodeChatReasoningSignature(reasoningContent)
                : block?.signature ||
                  encodeChatReasoningSignature(reasoningContent),
            };
            if (block?.tool_call_id) {
              const group = thinkingByToolCall.get(block.tool_call_id) ?? [];
              group.push(anthropicBlock);
              thinkingByToolCall.set(block.tool_call_id, group);
            } else {
              preToolThinking.push(anthropicBlock);
            }
          }
          content.unshift(...preToolThinking);
        } else {
          const upstreamThinking = message.thinking;
          const messageThinking =
            upstreamThinking?.content ?? message.reasoning_content;
          if (
            typeof messageThinking === "string" &&
            (messageThinking.length > 0 || upstreamThinking?.signature)
          ) {
            content.unshift({
              type: "thinking",
              thinking: omitThinking ? "" : messageThinking,
              signature: omitThinking &&
                  messageThinking &&
                  !isRouterOwnedReasoningSignature(upstreamThinking?.signature)
                ? encodeChatReasoningSignature(messageThinking)
                : upstreamThinking?.signature ||
                  encodeChatReasoningSignature(messageThinking),
            });
          }
        }

        const messageContentTexts: string[] = [];
        if (typeof message.content === "string" && message.content) {
          messageContentTexts.push(message.content);
          content.push({ type: "text", text: message.content });
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            const text = chatContentPartToText(part);
            messageContentTexts.push(text);
            content.push({ type: "text", text });
          }
        }
        // Chat annotations describe the preceding message content. Keep the
        // same visible order as streaming endpoints: answer first, then the
        // bounded source metadata fallback.
        if (citationFallbackText) {
          content.push({ type: "text", text: citationFallbackText });
        }
        const audio = message.audio;
        const audioTranscript = typeof audio?.transcript === "string"
          ? audio.transcript
          : "";
        if (
          audioTranscript &&
          !messageContentTexts.includes(audioTranscript) &&
          messageContentTexts.join("") !== audioTranscript
        ) {
          content.push({ type: "text", text: audioTranscript });
        }
        if (typeof audio?.data === "string" && audio.data.length > 0) {
          content.push({ type: "text", text: "[generated audio omitted]" });
        }
        if (refusalText) {
          content.push({ type: "text", text: refusalText });
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          for (const toolCall of message.tool_calls) {
            if (!toolCall?.id || !toolCall?.function?.name) {
              throw createApiError(
                "upstream tool call is missing id or function name",
                502,
                "upstream_protocol_error",
                "api_error",
              );
            }
            const pairedThinking = thinkingByToolCall.get(toolCall.id);
            if (pairedThinking) {
              content.push(...pairedThinking);
              thinkingByToolCall.delete(toolCall.id);
            }
            if (hasIncompleteTerminal) {
              content.push({
                type: "text",
                text: incompleteToolCallText(
                  toolCall.function.name,
                  toolCall.function.arguments,
                ),
              });
            } else {
              content.push({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.function.name,
                input: parseUpstreamToolInput(toolCall.function.arguments),
                caller: { type: "direct" },
              });
            }
          }
        } else if (message.function_call?.name) {
          if (hasIncompleteTerminal) {
            content.push({
              type: "text",
              text: incompleteToolCallText(
                message.function_call.name,
                message.function_call.arguments,
              ),
            });
          } else {
            content.push({
              type: "tool_use",
              id: `call_${uuidv4()}`,
              name: message.function_call.name,
              input: parseUpstreamToolInput(message.function_call.arguments),
              caller: { type: "direct" },
            });
          }
        }
        for (const orphanThinking of thinkingByToolCall.values()) {
          content.push(...orphanThinking);
        }
      }

      const result = {
        id: openaiResponse.id,
        type: "message",
        role: "assistant",
        container: null,
        model: openaiResponse.model,
        content,
        stop_reason: mapChatFinishReason(choice.finish_reason, isRefusal),
        stop_sequence: null,
        stop_details: isRefusal ? refusalStopDetails(refusalText) : null,
        usage: convertUsage(
          openaiResponse.usage,
          (openaiResponse as any).service_tier,
        ),
      };
      this.logger?.debug(
        {
          reqId: context.req.id,
          result,
        },
        `Conversion complete, final Anthropic response`
      );
      return result;
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw createApiError(
        `Provider error: ${JSON.stringify(openaiResponse)}`,
        502,
        "upstream_protocol_error",
        "api_error",
      );
    }
  }
}
