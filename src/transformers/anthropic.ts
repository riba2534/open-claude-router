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
  const url =
    source?.type === "base64" && typeof source.data === "string"
      ? formatBase64(source.data, source.media_type)
      : typeof source?.url === "string"
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
  if (source?.type === "file" && typeof source.file_id === "string") {
    return bounded(`[document${title}: ${source.file_id}]`);
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
  } else if (
    source?.type === "file" &&
    typeof source.file_id === "string"
  ) {
    file.file_id = source.file_id;
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

// OpenAI usage -> Anthropic usage. cached_tokens is reported as a subset of
// prompt_tokens by OpenAI, but some compatible gateways report it as a
// separate counter — clamp so input_tokens can never go negative.
function convertUsage(usage: any): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens?: number;
} {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens || 0;
  return {
    input_tokens: Math.max(
      0,
      (usage?.prompt_tokens || 0) - cached - cacheWrite,
    ),
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: cached,
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
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
    }
  }

  const messages = request.messages;
  if (!Array.isArray(messages)) {
    invalidRequest("messages must be an array");
  }
  let hasCitationsEnabledDocument = false;
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      invalidRequest(
        'each message must be an object with role "user" or "assistant"',
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
        if (
          message.role === "assistant" &&
          part.type === "thinking" &&
          (typeof part.signature !== "string" || part.signature.length === 0)
        ) {
          invalidRequest(
            "assistant thinking blocks must include a non-empty signature",
          );
        }
        if (
          message.role === "user" &&
          part.type === "document" &&
          part.citations?.enabled === true
        ) {
          hasCitationsEnabledDocument = true;
        }
      }
    }
  }

  const tools = request.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    invalidRequest("tools must be an array");
  }
  for (const tool of tools ?? []) {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
      invalidRequest("each tool must be an object with a name");
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      invalidRequest("tool.strict must be a boolean when provided");
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
  if (outputFormat !== undefined) {
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
    if (hasCitationsEnabledDocument) {
      invalidRequest(
        "output_config.format cannot be combined with document citations",
      );
    }
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
  }
}

function convertToolResultContent(content: unknown): any {
  if (content == null) return "";
  if (typeof content === "string") return content;

  const blocks = Array.isArray(content) ? content : [content];
  if (blocks.length === 0) return "";

  return blocks.map((block: any) => {
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
      const file = convertAnthropicDocument(block);
      if (file) return file;
    }
    return { type: "text" as const, text: boundedJsonBlockText(block) };
  });
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
        const textParts: Array<{
          type: "text";
          text: string;
          cache_control?: any;
        }> = request.system.flatMap((item: any) => {
          if (item.type === "text" && typeof item.text === "string") {
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
          // System blocks are an actively evolving Anthropic union. Preserve
          // unknown future blocks as bounded text instead of silently deleting
          // instructions or forwarding an invalid Chat content-part shape.
          return [{
            type: "text" as const,
            text: boundedJsonBlockText(item),
          }];
        });
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
                  content: convertToolResultContent(tool.content),
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
                const file = convertAnthropicDocument(part);
                if (file) {
                  contentParts.push(file);
                  continue;
                }
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
              } else if (
                part?.type !== "thinking" &&
                part?.type !== "redacted_thinking"
              ) {
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
            // calls have dedicated mappings; redacted thinking is deliberately
            // omitted because exposing its opaque payload as visible text
            // would violate its confidentiality semantics.
            const fallbackParts = msg.content
              .filter(
                (part: any) =>
                  part?.type !== "text" &&
                  part?.type !== "tool_use" &&
                  part?.type !== "thinking" &&
                  part?.type !== "redacted_thinking",
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

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stop: request.stop_sequences,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertAnthropicToolsToUnified(request.tools)
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
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: data.error.type || data.error.code || "api_error",
              message:
                data.error.message ||
                JSON.stringify(data.error),
            },
          }),
          {
            status: response.status >= 400 ? response.status : 500,
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
            if (omitThinking) {
              throw createApiError(
                "upstream omitted replayable reasoning state",
                502,
                "upstream_protocol_error",
                "api_error",
              );
            }
            safeEnqueue(
              encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: currentContentBlockIndex,
                  delta: {
                    type: "signature_delta",
                    signature: `sig_${Date.now()}`,
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
                deferSemanticFrames = false;
                deferredFrames = [];
                deferredToolCalls.length = 0;
                safeEnqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      type: "error",
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
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        stop_details: null,
                      },
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                      },
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
                      content: [],
                      model: model,
                      stop_reason: null,
                      stop_sequence: null,
                      stop_details: null,
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                      },
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
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        stop_details: null,
                      },
                      usage: convertUsage(chunk.usage),
                    };
                  } else {
                    stopReasonMessageDelta.usage = convertUsage(chunk.usage);
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
                  if (omitThinking) {
                    throw createApiError(
                      "upstream omitted replayable reasoning state",
                      502,
                      "upstream_protocol_error",
                      "api_error",
                    );
                  }
                  // First content/tool_call after a reasoning_content run: the
                  // thinking block must be sealed with a signature_delta before
                  // content_block_stop. The upstream gave none, so synthesize one
                  // (matches the reference reasoning transformer's Date.now()
                  // signature). Routed through the signature branch below.
                  (choice.delta as any).thinking = {
                    signature: `sig_${Date.now()}`,
                  };
                  reasoningSignatureSent = true;
                  reasoningThinkingActive = false;
                }

                if (choice?.delta?.thinking && !isClosed && !hasFinished) {
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
                    }
                    if (currentBlockType === "thinking") {
                      const thinkingSignature = {
                        type: "content_block_delta",
                        index: currentContentBlockIndex,
                        delta: {
                          type: "signature_delta",
                          signature: choice.delta.thinking.signature,
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
                    }
                  } else if (choice.delta.thinking.content) {
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
                    }
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
                          thinking: choice.delta.thinking.content || "",
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
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                        stop_details: isRefusal
                          ? refusalStopDetails(refusalExplanation)
                          : null,
                      },
                      usage: chunk.usage
                        ? convertUsage(chunk.usage)
                        : (stopReasonMessageDelta?.usage ?? {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_input_tokens: 0,
                          }),
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
        if (urlCitationAnnotations.length) {
          content.push({
            type: "text",
            text: boundedJsonBlockText({
              type: "openai_url_citations",
              annotations: urlCitationAnnotations,
            }),
          });
        }

        const upstreamThinkingBlocks = message.thinking_blocks;
        const thinkingByToolCall = new Map<string, any[]>();
        if (
          Array.isArray(upstreamThinkingBlocks) &&
          upstreamThinkingBlocks.length
        ) {
          const preToolThinking: any[] = [];
          for (const block of upstreamThinkingBlocks) {
            if (omitThinking && !block?.signature) {
              throw createApiError(
                "upstream omitted replayable reasoning state",
                502,
                "upstream_protocol_error",
                "api_error",
              );
            }
            const anthropicBlock = {
              type: "thinking",
              thinking: omitThinking ? "" : (block?.content ?? ""),
              signature: block?.signature || `sig_${Date.now()}`,
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
            if (omitThinking && !upstreamThinking?.signature) {
              throw createApiError(
                "upstream omitted replayable reasoning state",
                502,
                "upstream_protocol_error",
                "api_error",
              );
            }
            content.unshift({
              type: "thinking",
              thinking: omitThinking ? "" : messageThinking,
              signature: upstreamThinking?.signature || `sig_${Date.now()}`,
            });
          }
        }

        if (typeof message.content === "string" && message.content) {
          content.push({ type: "text", text: message.content });
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            content.push({ type: "text", text: chatContentPartToText(part) });
          }
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
        model: openaiResponse.model,
        content,
        stop_reason: mapChatFinishReason(choice.finish_reason, isRefusal),
        stop_sequence: null,
        stop_details: isRefusal ? refusalStopDetails(refusalText) : null,
        usage: convertUsage(openaiResponse.usage),
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
