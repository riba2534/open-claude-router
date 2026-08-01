import { UnifiedChatRequest, MessageContent } from "../types/llm.js";
import { Transformer, TransformerContext } from "../types/transformer.js";
import { SseBlockDecoder } from "./sse.js";
import { createApiError } from "./errors.js";
import { mapOpenAIErrorToAnthropic } from "../utils/upstream.js";

const REASONING_SIGNATURE_PREFIX = "ocr-responses-reasoning-v1:";

interface RouterReasoningEnvelope {
  id: string;
  encrypted_content?: string;
  summary?: Array<{ type?: string; text?: string }>;
  content?: Array<{ type?: string; text?: string }>;
}

function encodeReasoningSignature(
  item: Pick<
    ResponsesAPIOutputItem,
    "id" | "encrypted_content" | "summary" | "content"
  >,
  includeVisibleFallback = true,
): string | undefined {
  if (!item.id) return undefined;
  const envelope: RouterReasoningEnvelope = { id: item.id };
  if (item.encrypted_content) {
    envelope.encrypted_content = item.encrypted_content;
  } else if (includeVisibleFallback) {
    // Keep the established encrypted envelope byte-compatible. Some
    // Responses-compatible endpoints omit encrypted_content, however, so in
    // that case retain the visible reasoning fields needed to replay the item
    // instead of emitting an id-only shell that the next request may reject.
    const summary = item.summary?.filter(
      (part) => typeof part?.text === "string",
    );
    if (summary?.length) envelope.summary = summary;
    const content = item.content
      ?.filter(
        (part) =>
          part?.type === "reasoning_text" && typeof part.text === "string",
      )
      .map((part) => ({ type: part.type, text: part.text }));
    if (content?.length) envelope.content = content;
  }
  return (
    REASONING_SIGNATURE_PREFIX +
    Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")
  );
}

/**
 * Rebuild a reasoning item for replay in a later request.
 *
 * The Responses schema requires `id`, `summary`, and `type` on a reasoning
 * item. `encrypted_content` supplements that identity for stateless replay; it
 * does not replace the required id. Some compatible gateways are more lenient,
 * but the Router emits the formal shape and preserves any rejection for the
 * client instead of deleting history and issuing a second upstream request.
 */
function replayedReasoningItem(
  replayable: RouterReasoningEnvelope,
): Record<string, any> {
  return {
    type: "reasoning",
    id: replayable.id,
    ...(replayable.encrypted_content
      ? { encrypted_content: replayable.encrypted_content }
      : {}),
    summary: replayable.summary ?? [],
    ...(replayable.content ? { content: replayable.content } : {}),
  };
}

function reasoningText(item: ResponsesAPIOutputItem): string {
  const contentText = (item.content || [])
    .filter((part) => part.type === "reasoning_text")
    .map((part) => part.text || "")
    .join("");
  if (contentText) return contentText;
  return (item.summary || []).map((part) => part.text || "").join("");
}

function decodeReasoningSignature(
  signature: string | undefined,
): RouterReasoningEnvelope | null {
  if (!signature?.startsWith(REASONING_SIGNATURE_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(
        signature.slice(REASONING_SIGNATURE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
    if (
      typeof decoded?.id === "string" &&
      decoded.id.length > 0 &&
      (decoded.encrypted_content === undefined ||
        typeof decoded.encrypted_content === "string") &&
      (decoded.summary === undefined || Array.isArray(decoded.summary)) &&
      (decoded.content === undefined || Array.isArray(decoded.content))
    ) {
      return decoded as RouterReasoningEnvelope;
    }
  } catch {
    // Unknown/native Anthropic signatures must never leak into Responses.
  }
  return null;
}

function mapResponsesErrorType(code: string | undefined): string {
  return mapOpenAIErrorToAnthropic({ code }, 200).type;
}

function mapResponsesErrorStatus(code: string | undefined): number {
  return mapOpenAIErrorToAnthropic({ code }, 200).status;
}

function parseResponsesToolArguments(raw: unknown): Record<string, any> {
  try {
    const parsed =
      typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tool arguments are not an object");
    }
    return parsed as Record<string, any>;
  } catch {
    throw createApiError(
      "upstream Responses function_call arguments must be a valid JSON object",
      502,
      "upstream_protocol_error",
      "api_error",
    );
  }
}

function unsupportedOutputPlaceholder(item: ResponsesAPIOutputItem): string {
  const type =
    typeof item?.type === "string" && item.type ? item.type : "unknown";
  return boundedResponsesFallback(`output item ${type}`, item);
}

function unsupportedResponsesItemReason(
  item: ResponsesAPIOutputItem,
): string | null {
  if (item?.type === "program" || item?.type === "program_output") {
    return "programmatic tool-calling state";
  }
  if (item?.type === "compaction") return "compaction state";
  if (item?.type === "function_call_output") {
    return "function-call output state";
  }
  if (
    item?.type === "function_call" &&
    item.caller != null &&
    item.caller.type !== "direct"
  ) {
    return `function caller ${JSON.stringify(item.caller.type)}`;
  }
  return null;
}

function isUnsupportedResponsesItem(item: ResponsesAPIOutputItem): boolean {
  return unsupportedResponsesItemReason(item) !== null;
}

function rejectUnsupportedResponsesItem(item: ResponsesAPIOutputItem): never {
  const reason = unsupportedResponsesItemReason(item) || item.type || "unknown";
  throw createApiError(
    `upstream Responses ${reason} has no ` +
      "replay-safe Anthropic Messages equivalent",
    502,
    "upstream_protocol_error",
    "api_error",
  );
}

const MAX_RESPONSES_FALLBACK_CHARS = 4096;

function boundedResponsesFallback(kind: string, value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value ?? "");
  } catch {
    serialized = String(value ?? "");
  }
  if (serialized.length > MAX_RESPONSES_FALLBACK_CHARS) {
    return `[unsupported Responses ${kind} omitted: ${serialized.length} chars]`;
  }
  return `[unsupported Responses ${kind}: ${serialized}]`;
}

function responsesStatusError(payload: any): {
  status: number;
  type: string;
  code?: string;
  message: string;
} | null {
  const status = payload?.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "incomplete"
  ) {
    return null;
  }
  const code = payload?.error?.code;
  if (status === "failed") {
    return {
      status: mapResponsesErrorStatus(code),
      type: mapResponsesErrorType(code),
      code,
      message: payload?.error?.message || "Responses request failed",
    };
  }
  if (status === "cancelled") {
    return {
      status: 409,
      type: "conflict_error",
      code: code || "response_cancelled",
      message: payload?.error?.message || "Responses request was cancelled",
    };
  }
  return {
    status: 502,
    type: "api_error",
    code: code || "invalid_response_status",
    message: `upstream Responses returned non-terminal status ${JSON.stringify(status)}`,
  };
}

interface ResponsesAPIOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type: string;
    text?: string;
    refusal?: string;
    image_url?: string;
    mime_type?: string;
    image_base64?: string;
    b64_json?: string;
    annotations?: Array<{
      type?: string;
      url?: string;
      title?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  reasoning?: string;
  summary?: Array<{ type?: string; text?: string }>;
  encrypted_content?: string;
  result?: string;
  status?: string;
  role?: string;
  caller?: {
    type?: string;
    caller_id?: string;
    [key: string]: unknown;
  } | null;
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
    pattern?: string;
    [key: string]: unknown;
  };
}

interface ResponsesAPIPayload {
  id: string;
  object: string;
  model: string;
  created_at: number;
  service_tier?: string;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  status?: string;
  incomplete_details?: {
    reason?: string;
  };
  error?: {
    code?: string;
    message?: string;
  } | null;
}

interface ResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  annotation_index?: number;
  summary_index?: number;
  delta?:
    | string
    | {
        url?: string;
        b64_json?: string;
        mime_type?: string;
      };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type: string;
      text?: string;
      refusal?: string;
      image_url?: string;
      mime_type?: string;
      image_base64?: string;
      b64_json?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        title?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    reasoning?: string; // 添加 reasoning 字段支持
    summary?: Array<{ type?: string; text?: string }>;
    encrypted_content?: string;
    result?: string;
    status?: string;
    caller?: ResponsesAPIOutputItem["caller"];
    action?: ResponsesAPIOutputItem["action"];
  };
  text?: string;
  refusal?: string;
  arguments?: string;
  response?: {
    id?: string;
    model?: string;
    created_at?: number;
    service_tier?: string;
    status?: string;
    incomplete_details?: {
      reason?: string;
    };
    output?: ResponsesAPIOutputItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
      };
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
    error?: {
      code?: string;
      message?: string;
    } | null;
  };
  code?: string | null;
  message?: string;
  param?: string | null;
  error?: {
    type?: string;
    code?: string;
    message?: string;
    status?: number;
  };
  reasoning_summary?: string; // 添加推理摘要支持
  annotation?: {
    type?: string;
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  };
  part?: { text?: string; signature?: string } | string;
}

export class OpenAIResponsesTransformer implements Transformer {
  name = "openai-responses";
  endPoint = "/v1/responses";
  logger?: any;

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    if (request.max_tokens != null) {
      (request as any).max_output_tokens = request.max_tokens;
    }
    delete request.max_tokens;
    // Responses has no direct stop-sequence request parameter.
    delete request.stop;

    const reasoningEffort =
      request.reasoning_effort ?? request.reasoning?.effort;
    const reasoningOutputRequested = request.reasoning?.enabled === true;
    const reasoningSummaryRequested =
      reasoningOutputRequested && request.reasoning?.display !== "omitted";
    if (reasoningEffort || reasoningSummaryRequested) {
      (request as any).reasoning = {
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(reasoningSummaryRequested ? { summary: "detailed" } : {}),
      };
    } else {
      delete request.reasoning;
    }
    if (reasoningOutputRequested) {
      (request as any).include = ["reasoning.encrypted_content"];
    }
    delete request.reasoning_effort;

    const input: any[] = [];

    request.messages.forEach((message) => {
      const convertedMessage: any = { ...message };

      if (Array.isArray(message.content)) {
        const convertedContent = message.content
          .map((content) => this.normalizeRequestContent(content))
          .filter(
            (content): content is Record<string, unknown> => content !== null
          );

        if (convertedContent.length > 0) {
          convertedMessage.content = convertedContent;
        } else {
          convertedMessage.content = "";
        }
      }

      if (
        message.role === "assistant" &&
        Array.isArray(message.output_blocks)
      ) {
        // Anthropic assistant content is an ordered block stream. Replaying
        // only the flattened Chat `content` + `tool_calls` fields moves text
        // ahead of reasoning/tool items. Consume the Router-internal ordered
        // representation when present so history remains lossless.
        const inputLengthBeforeBlocks = input.length;
        for (const block of message.output_blocks) {
          if (block?.type === "thinking") {
            const replayableReasoning = decodeReasoningSignature(
              block.signature,
            );
            if (!replayableReasoning) continue;
            input.push(replayedReasoningItem(replayableReasoning));
          } else if (block?.type === "tool_use") {
            input.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            });
          } else if (block?.type === "text") {
            input.push({
              role: "assistant",
              content: block.text ?? "",
            });
          }
        }
        if (input.length === inputLengthBeforeBlocks) {
          // Every block was dropped — e.g. a turn holding nothing but a thinking
          // block whose signature this upstream cannot replay, which happens on
          // any chat-alias -> responses-alias switch mid-session. Counting blocks
          // instead of emitted items would erase the assistant turn entirely and
          // leave two consecutive user turns in the history.
          input.push({ role: "assistant", content: "" });
        }
        return;
      }

      if (message.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          // Responses formally supports a typed content array here. Keep the
          // original block boundaries and bytes instead of inserting newlines
          // into text-only tool results. A source string remains a string.
          output: convertedMessage.content ?? "",
        });
        return;
      }

      // Replay every Router-wrapped reasoning item, re-interleaved: blocks
      // paired with a tool call are emitted immediately before that
      // function_call item (Responses validates reasoning/item adjacency);
      // unpaired blocks precede the assistant message itself.
      const reasoningByToolCall = new Map<string, any[]>();
      if (message.role === "assistant") {
        const thinkingBlocks =
          Array.isArray(message.thinking_blocks) &&
          message.thinking_blocks.length
            ? message.thinking_blocks
            : message.thinking
              ? [message.thinking]
              : [];
        for (const block of thinkingBlocks) {
          const replayableReasoning = decodeReasoningSignature(
            (block as any)?.signature,
          );
          if (!replayableReasoning) continue;
          const reasoningItem = replayedReasoningItem(replayableReasoning);
          const pairedToolCallId = (block as any)?.tool_call_id;
          if (pairedToolCallId) {
            const group = reasoningByToolCall.get(pairedToolCallId) ?? [];
            group.push(reasoningItem);
            reasoningByToolCall.set(pairedToolCallId, group);
          } else {
            input.push(reasoningItem);
          }
        }

        const hasContent =
          typeof convertedMessage.content === "string"
            ? convertedMessage.content.length > 0
            : Array.isArray(convertedMessage.content) &&
              convertedMessage.content.length > 0;
        if (hasContent || !Array.isArray(message.tool_calls)) {
          delete convertedMessage.tool_calls;
          delete convertedMessage.thinking;
          delete convertedMessage.thinking_blocks;
          delete convertedMessage.output_blocks;
          delete convertedMessage.cache_control;
          input.push(convertedMessage);
        }
      } else {
        delete convertedMessage.cache_control;
        input.push(convertedMessage);
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((tool) => {
          const pairedReasoning = reasoningByToolCall.get(tool.id);
          if (pairedReasoning) {
            input.push(...pairedReasoning);
            reasoningByToolCall.delete(tool.id);
          }
          input.push({
            type: "function_call",
            arguments: tool.function.arguments,
            name: tool.function.name,
            call_id: tool.id,
          });
        });
      }
    });

    (request as any).input = input;
    delete (request as any).messages;

    if (Array.isArray(request.tools)) {
      (request as any).tools = request.tools.map((tool) => ({
        type: tool.type,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict ?? false,
      }));
    }

    if (request.response_format?.type === "json_schema") {
      const schema = request.response_format.json_schema;
      (request as any).text = {
        format: {
          type: "json_schema",
          name: schema.name,
          schema: schema.schema,
          strict: schema.strict,
        },
      };
      delete request.response_format;
    }

    // tool_choice 格式转换：unified { type: "function", function: { name } }
    // → Responses { type: "function", name }（扁平结构，无 function 嵌套）
    if (request.tool_choice) {
      const tc = request.tool_choice as any;
      if (tc.type === "function" && tc.function?.name) {
        (request as any).tool_choice = {
          type: "function",
          name: tc.function.name,
        };
      }
      // "auto" / "none" / "required" 等简单值直接透传
    }

    return request;
  }

  async transformResponseOut(
    response: Response,
    context?: TransformerContext,
  ): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      const jsonResponse: any = await response.json();

      // 检查是否为responses API格式的JSON响应
      if (jsonResponse.object === "response") {
        const semanticError = responsesStatusError(jsonResponse);
        if (semanticError) {
          return new Response(
            JSON.stringify({
              error: {
                type: semanticError.type,
                code: semanticError.code,
                message: semanticError.message,
              },
            }),
            {
              status: semanticError.status,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (!Array.isArray(jsonResponse.output)) {
          throw createApiError(
            "upstream Responses payload is missing output",
            502,
            "upstream_protocol_error",
            "api_error",
          );
        }
        // 将responses格式转换为chat格式
        const chatResponse = this.convertResponseToChat(jsonResponse, context);
        return new Response(JSON.stringify(chatResponse), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // 不是responses API格式，保持原样
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (contentType.includes("text/event-stream")) {
      if (!response.body) {
        return response;
      }

      const encoder = new TextEncoder();
      let isStreamEnded = false;
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let downstreamCancelled = false;

      const transformer = this;
      const omitReasoning = context?.thinkingDisplay === "omitted";
      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();
          activeReader = reader;
          const sseDecoder = new SseBlockDecoder();

          // tool_call index 映射：按 item_id 路由到递增的 tool_calls 数组索引
          // 支持多工具并行调用场景
          const toolCallIndexMap = new Map<string, number>();
          let nextToolCallIndex = 0;
          let streamId = "chatcmpl-" + Date.now();
          let streamModel = "unknown";
          let streamCreated = Math.floor(Date.now() / 1000);
          type BufferedStreamPart = {
            text: string;
            finalized: boolean;
          };
          const textPartBuffers = new Map<string, BufferedStreamPart>();
          const refusalPartBuffers = new Map<string, BufferedStreamPart>();
          const argumentBuffers = new Map<string, string>();
          const reasoningSummaryParts = new Set<string>();
          const reasoningTextPartBuffers = new Map<
            string,
            BufferedStreamPart
          >();
          const reasoningTextItems = new Set<string>();
          const reasoningSignatureItems = new Set<string>();
          const functionItemsAdded = new Set<string>();
          const functionOutputIndexesAdded = new Set<number>();
          type FunctionIdentity = {
            itemId: string;
            callId: string;
            name: string;
            outputIndex?: number;
          };
          const functionIdentityByItem = new Map<string, FunctionIdentity>();
          const functionIdentityByOutput = new Map<number, FunctionIdentity>();
          const imageGenerationItems = new Set<string>();
          const unsupportedItems = new Set<string>();
          const encryptedReasoningItems = new Set<string>();
          const suppressedReasoningGroups: string[][] = [];
          let sawRefusal = false;
          let sawIncompleteFunctionCall = false;
          let emittedAudioOmission = false;
          let stopReading = false;
          let fatalStreamError = false;
          // Dedup keys must match between a delta that omits item_id and the
          // done/fallback event that carries it, so every event is keyed by
          // BOTH identities when available: mark all, match on any.
          const getEventItemKeys = (event: ResponsesStreamEvent): string[] => {
            const keys: string[] = [];
            const itemId = event.item_id || event.item?.id;
            if (itemId) keys.push(`item:${itemId}`);
            if (event.output_index !== undefined) {
              keys.push(`output:${event.output_index}`);
            }
            return keys.length ? keys : ["output:unknown"];
          };
          const getContentPartKeys = (
            event: ResponsesStreamEvent,
            contentIndex = event.content_index ?? 0,
          ): string[] =>
            getEventItemKeys(event).map(
              (key) => `${key}:content:${contentIndex}`,
            );
          const getSummaryPartKeys = (
            event: ResponsesStreamEvent,
            summaryIndex = event.summary_index ?? 0,
          ): string[] =>
            getEventItemKeys(event).map(
              (key) => `${key}:summary:${summaryIndex}`,
            );
          const getAnnotationKeys = (
            event: ResponsesStreamEvent,
            annotationIndex = event.annotation_index ?? 0,
          ): string[] =>
            getContentPartKeys(event).map(
              (key) => `${key}:annotation:${annotationIndex}`,
            );
          const seenAny = (marked: Set<string>, keys: string[]): boolean =>
            keys.some((key) => marked.has(key));
          const markAll = (marked: Set<string>, keys: string[]): void =>
            keys.forEach((key) => marked.add(key));
          const getBufferedStreamPart = (
            buffers: Map<string, BufferedStreamPart>,
            keys: string[],
          ): BufferedStreamPart => {
            const buffered = keys
              .map((key) => buffers.get(key))
              .find((part): part is BufferedStreamPart => !!part) || {
              text: "",
              finalized: false,
            };
            for (const key of keys) buffers.set(key, buffered);
            return buffered;
          };
          const appendStreamPartDelta = (
            buffers: Map<string, BufferedStreamPart>,
            event: ResponsesStreamEvent,
            delta: string,
          ): string => {
            if (!delta) return "";
            const buffered = getBufferedStreamPart(
              buffers,
              getContentPartKeys(event),
            );
            // Some compatible endpoints emit a populated item snapshot before
            // replaying its deltas. Preserve the existing snapshot-first
            // de-duplication behavior.
            if (buffered.finalized) return "";
            buffered.text += delta;
            return delta;
          };
          const reconcileStreamPartSnapshot = (
            buffers: Map<string, BufferedStreamPart>,
            event: ResponsesStreamEvent,
            snapshot: string,
            kind: string,
          ): string | null => {
            const buffered = getBufferedStreamPart(
              buffers,
              getContentPartKeys(event),
            );
            if (!snapshot.startsWith(buffered.text)) {
              emitFatalStreamError(
                `Responses ${kind} snapshot diverged from deltas`,
                new Error(`${kind} snapshot mismatch`),
                JSON.stringify(event),
                `upstream Responses ${kind} is inconsistent`,
              );
              return null;
            }
            const suffix = snapshot.slice(buffered.text.length);
            buffered.text = snapshot;
            buffered.finalized = true;
            return suffix;
          };
          const sameFunctionIdentity = (
            left: FunctionIdentity,
            right: FunctionIdentity,
          ): boolean =>
            left.itemId === right.itemId &&
            left.callId === right.callId &&
            left.name === right.name;
          const registerFunctionIdentity = (
            item: ResponsesAPIOutputItem,
            outputIndex: number | undefined,
          ): FunctionIdentity | null => {
            const itemId = item.id || item.call_id || "";
            const callId = item.call_id || item.id || "";
            if (!itemId || !callId || !item.name) return null;
            const identity = { itemId, callId, name: item.name, outputIndex };
            const existingItem = functionIdentityByItem.get(itemId);
            const existingOutput =
              outputIndex === undefined
                ? undefined
                : functionIdentityByOutput.get(outputIndex);
            if (
              (existingItem && !sameFunctionIdentity(existingItem, identity)) ||
              (existingOutput && !sameFunctionIdentity(existingOutput, identity))
            ) {
              emitFatalStreamError(
                "Responses function identity changed during stream",
                new Error("function identity mismatch"),
                JSON.stringify(item),
                "upstream Responses function identity changed during stream",
              );
              return null;
            }
            functionIdentityByItem.set(itemId, identity);
            if (outputIndex !== undefined) {
              functionIdentityByOutput.set(outputIndex, identity);
            }
            return identity;
          };
          const isBareFunctionSkeleton = (
            item: ResponsesAPIOutputItem,
          ): boolean =>
            item.type === "function_call" &&
            !item.id &&
            !item.call_id &&
            !item.name &&
            item.arguments === undefined &&
            item.status === undefined;
          const validateTerminalFunctions = (
            output: ResponsesAPIOutputItem[],
          ): boolean => {
            for (const [outputIndex, expected] of functionIdentityByOutput) {
              const item = output[outputIndex];
              if (!item || item.type !== "function_call") {
                emitFatalStreamError(
                  "Responses terminal output omitted a streamed function call",
                  new Error("missing terminal function_call"),
                  JSON.stringify(output),
                  "upstream Responses terminal output omitted a function call",
                );
                return false;
              }
              if (isBareFunctionSkeleton(item)) continue;
              const actualItemId = item.id || item.call_id || "";
              const actual = {
                itemId: actualItemId,
                callId: item.call_id || item.id || "",
                name: item.name || "",
                outputIndex,
              };
              if (!sameFunctionIdentity(expected, actual)) {
                emitFatalStreamError(
                  "Responses terminal function identity mismatch",
                  new Error("terminal function identity mismatch"),
                  JSON.stringify(item),
                  "upstream Responses terminal function identity mismatch",
                );
                return false;
              }
            }
            for (const expected of functionIdentityByItem.values()) {
              if (expected.outputIndex !== undefined) continue;
              const hasMatch = output.some((item) => {
                if (item.type !== "function_call" || isBareFunctionSkeleton(item)) {
                  return false;
                }
                const actual = {
                  itemId: item.id || item.call_id || "",
                  callId: item.call_id || item.id || "",
                  name: item.name || "",
                };
                return sameFunctionIdentity(expected, actual);
              });
              if (!hasMatch) {
                emitFatalStreamError(
                  "Responses terminal output omitted an unindexed function call",
                  new Error("missing unindexed terminal function_call"),
                  JSON.stringify(output),
                  "upstream Responses terminal output omitted a function call",
                );
                return false;
              }
            }
            return true;
          };
          type BufferedSummary = {
            itemKeys: string[];
            partKeys: string[];
            text: string;
          };
          const bufferedSummaryByKey = new Map<string, BufferedSummary>();
          const bufferedSummaries = new Set<BufferedSummary>();
          const bufferSummary = (
            event: ResponsesStreamEvent,
            text: string,
            replace: boolean,
          ): void => {
            if (!text) return;
            const partKeys = getSummaryPartKeys(event);
            let buffered = partKeys
              .map((key) => bufferedSummaryByKey.get(key))
              .find((entry): entry is BufferedSummary => !!entry);
            if (!buffered) {
              buffered = {
                itemKeys: getEventItemKeys(event),
                partKeys,
                text: "",
              };
              bufferedSummaries.add(buffered);
            }
            buffered.text = replace ? text : buffered.text + text;
            for (const key of partKeys) bufferedSummaryByKey.set(key, buffered);
          };
          const discardBufferedSummary = (buffered: BufferedSummary): void => {
            bufferedSummaries.delete(buffered);
            for (const key of buffered.partKeys) {
              if (bufferedSummaryByKey.get(key) === buffered) {
                bufferedSummaryByKey.delete(key);
              }
            }
          };
          const discardBufferedSummariesForItem = (itemKeys: string[]): void => {
            for (const buffered of [...bufferedSummaries]) {
              if (buffered.itemKeys.some((key) => itemKeys.includes(key))) {
                discardBufferedSummary(buffered);
              }
            }
          };
          const flushBufferedSummariesForItem = (
            event: ResponsesStreamEvent,
          ): void => {
            const itemKeys = getEventItemKeys(event);
            if (seenAny(reasoningTextItems, itemKeys)) {
              discardBufferedSummariesForItem(itemKeys);
              return;
            }
            for (const buffered of [...bufferedSummaries]) {
              if (!buffered.itemKeys.some((key) => itemKeys.includes(key))) {
                continue;
              }
              if (buffered.text) {
                markAll(reasoningSummaryParts, buffered.partKeys);
                emitChatDelta(event.item_id || event.item?.id, event.type, {
                  thinking: { content: buffered.text },
                });
              }
              discardBufferedSummary(buffered);
            }
          };
          const flushAllBufferedSummaries = (): void => {
            for (const buffered of [...bufferedSummaries]) {
              if (!seenAny(reasoningTextItems, buffered.itemKeys) && buffered.text) {
                markAll(reasoningSummaryParts, buffered.partKeys);
                emitChatDelta(undefined, "reasoning-summary-fallback", {
                  thinking: { content: buffered.text },
                });
              }
              discardBufferedSummary(buffered);
            }
          };
          const getToolCallIndex = (itemId: string): number => {
            if (!toolCallIndexMap.has(itemId)) {
              toolCallIndexMap.set(itemId, nextToolCallIndex++);
            }
            return toolCallIndexMap.get(itemId)!;
          };
          const emitChatDelta = (
            itemId: string | undefined,
            _eventType: string,
            delta: Record<string, unknown>,
          ) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: itemId || streamId,
                  object: "chat.completion.chunk",
                  created: streamCreated,
                  model: streamModel,
                  choices: [
                    {
                      // Chat `choices[].index` is the n-best choice index and
                      // the router always emits a single choice — never reuse
                      // it as a content-part counter.
                      index: 0,
                      delta,
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
          };
          const emitResponseItemFallback = (
            item: ResponsesAPIOutputItem,
            outputIndex: number | undefined,
            eventType: string,
          ): void => {
            if (isUnsupportedResponsesItem(item)) {
              const reason = unsupportedResponsesItemReason(item);
              emitFatalStreamError(
                "Responses output item is unsupported",
                new Error(`${reason} cannot be replayed`),
                JSON.stringify(item),
                `upstream Responses ${reason} has no ` +
                  "replay-safe Anthropic Messages equivalent",
              );
              return;
            }
            const itemId = item.id || item.call_id || "";
            const itemEvent: ResponsesStreamEvent = {
              type: eventType,
              item_id: item.id,
              output_index: outputIndex,
              item: item as ResponsesStreamEvent["item"],
            };

            if (item.type === "message") {
              (item.content || []).forEach((part, index) => {
                if (fatalStreamError) return;
                const partKeys = getContentPartKeys(itemEvent, index);
                if (part.type === "output_text") {
                  if (typeof part.text === "string") {
                    const suffix = reconcileStreamPartSnapshot(
                      textPartBuffers,
                      { ...itemEvent, content_index: index },
                      part.text,
                      "output text",
                    );
                    if (suffix) {
                      emitChatDelta(itemId, eventType, {
                        role: "assistant",
                        content: suffix,
                      });
                    }
                  }
                } else if (part.type === "refusal") {
                  sawRefusal = true;
                  if (typeof part.refusal === "string") {
                    const suffix = reconcileStreamPartSnapshot(
                      refusalPartBuffers,
                      { ...itemEvent, content_index: index },
                      part.refusal,
                      "refusal",
                    );
                    if (suffix) {
                      emitChatDelta(itemId, eventType, {
                        role: "assistant",
                        refusal: suffix,
                      });
                    }
                  }
                } else if (
                  part.type === "output_image" ||
                  part.type === "output_image_base64"
                ) {
                  const partKey = `${partKeys[0]}:generated-image`;
                  if (!unsupportedItems.has(partKey)) {
                    unsupportedItems.add(partKey);
                    emitChatDelta(itemId, eventType, {
                      role: "assistant",
                      content: "[generated image omitted]",
                    });
                  }
                } else {
                  const partKey = `${partKeys[0]}:unsupported`;
                  if (!unsupportedItems.has(partKey)) {
                    unsupportedItems.add(partKey);
                    emitChatDelta(itemId, eventType, {
                      role: "assistant",
                      content: boundedResponsesFallback(
                        `message content ${part.type || "unknown"}`,
                        part,
                      ),
                    });
                  }
                }
                // An annotation describes the preceding output_text bytes.
                // Keep fallback order identical to the live event sequence:
                // text/refusal first, then each citation at its own position.
                for (const [annotationIndex, annotation] of (
                  part.annotations || []
                ).entries()) {
                  const annotationKeys = getAnnotationKeys(
                    itemEvent,
                    annotationIndex,
                  );
                  if (!seenAny(unsupportedItems, annotationKeys)) {
                    markAll(unsupportedItems, annotationKeys);
                    emitChatDelta(itemId, eventType, {
                      role: "assistant",
                      content: boundedResponsesFallback(
                        "citation annotation",
                        annotation,
                      ),
                    });
                  }
                }
              });
              return;
            }

            if (item.type === "function_call") {
              const isBareCompatibilitySkeleton = isBareFunctionSkeleton(item);
              if (
                isBareCompatibilitySkeleton &&
                outputIndex !== undefined &&
                functionOutputIndexesAdded.has(outputIndex)
              ) {
                return;
              }
              if (!itemId || !item.name) {
                emitFatalStreamError(
                  "Responses function_call is missing identifiers",
                  new Error("missing call_id/id or name"),
                  JSON.stringify(item),
                  "upstream Responses function_call is missing call_id or name",
                );
                return;
              }
              if (!registerFunctionIdentity(item, outputIndex)) return;
              if (item.status === "incomplete") {
                sawIncompleteFunctionCall = true;
              }
              const bufferedArguments = argumentBuffers.get(itemId) || "";
              let completeArguments = bufferedArguments;
              let argumentSuffix = "";
              if (typeof item.arguments === "string") {
                const metadataArrivedAfterArguments =
                  eventType === "response.output_item.added" &&
                  bufferedArguments.startsWith(item.arguments);
                if (
                  bufferedArguments &&
                  !item.arguments.startsWith(bufferedArguments) &&
                  !metadataArrivedAfterArguments
                ) {
                  emitFatalStreamError(
                    "Responses function arguments snapshot diverged from deltas",
                    new Error("argument snapshot mismatch"),
                    JSON.stringify(item),
                    "upstream Responses function arguments are inconsistent",
                  );
                  return;
                }
                completeArguments =
                  metadataArrivedAfterArguments
                    ? bufferedArguments
                    : item.arguments;
                argumentSuffix = completeArguments.slice(bufferedArguments.length);
                argumentBuffers.set(itemId, completeArguments);
              }
              if (outputIndex !== undefined) {
                functionOutputIndexesAdded.add(outputIndex);
              }
              if (!functionItemsAdded.has(itemId)) {
                functionItemsAdded.add(itemId);
                emitChatDelta(itemId, eventType, {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: getToolCallIndex(itemId),
                      id: item.call_id || item.id,
                      function: {
                        name: item.name || "",
                        // Argument events can precede output_item.added on
                        // compatible endpoints. Keep those bytes buffered until
                        // identifiers arrive, then publish one coherent tool.
                        arguments: completeArguments,
                      },
                      type: "function",
                    },
                  ],
                });
              } else if (argumentSuffix) {
                emitChatDelta(itemId, eventType, {
                  tool_calls: [
                    {
                      index: getToolCallIndex(itemId),
                      function: { arguments: argumentSuffix },
                    },
                  ],
                });
              }
              return;
            }

            if (item.type === "reasoning") {
              if (!item.id) {
                emitFatalStreamError(
                  "Responses reasoning item is missing id",
                  new Error("missing reasoning id"),
                  JSON.stringify(item),
                  "upstream Responses reasoning item is missing id",
                );
                return;
              }
              const itemKeys = getEventItemKeys(itemEvent);
              const visibleReasoning = reasoningText(item);
              if (omitReasoning) {
                if (visibleReasoning && !item.encrypted_content) {
                  emitFatalStreamError(
                    "Responses omitted reasoning lacked encrypted state",
                    new Error("visible reasoning cannot be replayed when omitted"),
                    JSON.stringify(item),
                    "upstream omitted encrypted reasoning state",
                  );
                  return;
                }
                discardBufferedSummariesForItem(itemKeys);
                if (item.encrypted_content) {
                  markAll(encryptedReasoningItems, itemKeys);
                  const signature = encodeReasoningSignature(item, false);
                  if (signature && !seenAny(reasoningSignatureItems, itemKeys)) {
                    markAll(reasoningSignatureItems, itemKeys);
                    emitChatDelta(itemId, eventType, {
                      thinking: { signature },
                    });
                  }
                }
                return;
              }
              const reasoningParts = (item.content || [])
                .map((part, index) => ({ part, index }))
                .filter(({ part }) => part.type === "reasoning_text");
              if (reasoningParts.length > 0) {
                markAll(reasoningTextItems, itemKeys);
                discardBufferedSummariesForItem(itemKeys);
                for (const { part, index } of reasoningParts) {
                  if (typeof part.text === "string") {
                    const suffix = reconcileStreamPartSnapshot(
                      reasoningTextPartBuffers,
                      { ...itemEvent, content_index: index },
                      part.text,
                      "reasoning text",
                    );
                    if (!suffix) continue;
                    emitChatDelta(itemId, eventType, {
                      thinking: { content: suffix },
                    });
                  }
                }
              } else if (item.summary?.length) {
                item.summary.forEach((part, index) => {
                  const partKeys = getSummaryPartKeys(itemEvent, index);
                  if (
                    part.text &&
                    !seenAny(reasoningSummaryParts, partKeys)
                  ) {
                    markAll(reasoningSummaryParts, partKeys);
                    emitChatDelta(itemId, eventType, {
                      thinking: { content: part.text },
                    });
                  }
                });
                discardBufferedSummariesForItem(itemKeys);
              } else {
                flushBufferedSummariesForItem(itemEvent);
              }

              if (!seenAny(reasoningSignatureItems, itemKeys)) {
                const signature = encodeReasoningSignature({
                  ...item,
                  id: item.id || itemId,
                });
                if (signature) {
                  markAll(reasoningSignatureItems, itemKeys);
                  emitChatDelta(itemId, eventType, {
                    thinking: { signature },
                  });
                }
              }
              return;
            }

            if (item.type === "image_generation_call") {
              const itemKeys = getEventItemKeys(itemEvent);
              if (!seenAny(imageGenerationItems, itemKeys)) {
                markAll(imageGenerationItems, itemKeys);
                emitChatDelta(itemId, eventType, {
                  role: "assistant",
                  content: "[generated image omitted]",
                });
              }
              return;
            }

            if (item.type === "web_search_call") {
              const itemKeys = getEventItemKeys(itemEvent);
              const unsupportedKey = `${itemKeys[0]}:web_search_call`;
              if (unsupportedItems.has(unsupportedKey)) return;
              unsupportedItems.add(unsupportedKey);
              emitChatDelta(item.id, eventType, {
                role: "assistant",
                content: boundedResponsesFallback("web_search_call", item),
              });
              return;
            }

            const unsupportedKey = itemId || `output:${outputIndex ?? "unknown"}`;
            if (!unsupportedItems.has(unsupportedKey)) {
              unsupportedItems.add(unsupportedKey);
              emitChatDelta(itemId, eventType, {
                role: "assistant",
                content: unsupportedOutputPlaceholder(item),
              });
            }
          };
          const emitFatalStreamError = (
            message: string,
            error: unknown,
            data: string,
            publicMessage = "malformed upstream SSE event",
          ) => {
            if (fatalStreamError) return;
            transformer.logger?.error(
              {
                err: error,
                data: omitReasoning ? "[omitted by thinking.display]" : data,
              },
              message,
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: streamId,
                  object: "chat.completion.chunk",
                  created: streamCreated,
                  model: streamModel,
                  error: {
                    type: "api_error",
                    message: publicMessage,
                    status: 502,
                  },
                  choices: [],
                })}\n\n`,
              ),
            );
            fatalStreamError = true;
            isStreamEnded = true;
            stopReading = true;
          };
          const emitSemanticStreamError = (
            error: {
              status: number;
              type: string;
              code?: string;
              message: string;
            },
          ): void => {
            if (fatalStreamError) return;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: streamId,
                  object: "chat.completion.chunk",
                  created: streamCreated,
                  model: streamModel,
                  error: {
                    type: error.type,
                    code: error.code,
                    message: error.message,
                    status: error.status,
                  },
                  choices: [],
                })}\n\n`,
              ),
            );
            fatalStreamError = true;
            isStreamEnded = true;
            stopReading = true;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              const events = done
                ? sseDecoder.finish()
                : sseDecoder.push(value);

              for (const event of events) {
                const dataStr = event.data.trim();
                if (!dataStr) {
                  // Empty data fields are legal SSE keepalives, not corruption.
                  continue;
                }
                try {
                  if (dataStr === "[DONE]") {
                    isStreamEnded = true;
                    controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                    stopReading = true;
                    break;
                  }

                  try {
                    const data: ResponsesStreamEvent = JSON.parse(dataStr);

                      // 根据不同的事件类型转换为chat格式
                      if (data.type === "response.created") {
                        streamId = data.response?.id || streamId;
                        streamModel = data.response?.model || streamModel;
                        streamCreated =
                          data.response?.created_at || streamCreated;
                        const metadataChunk = {
                          id: streamId,
                          object: "chat.completion.chunk",
                          created: streamCreated,
                          model: streamModel,
                          service_tier: data.response?.service_tier,
                          choices: [],
                        };
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(metadataChunk)}\n\n`,
                          ),
                        );
                      } else if (
                        data.type === "response.audio.transcript.delta"
                      ) {
                        const transcriptDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (transcriptDelta) {
                          emitChatDelta(data.item_id, data.type, {
                            role: "assistant",
                            content: transcriptDelta,
                          });
                        }
                      } else if (data.type === "response.audio.delta") {
                        // Anthropic has no generated-audio content block. Never
                        // leak base64 into visible text; emit one deterministic
                        // marker for the entire response instead.
                        if (!emittedAudioOmission) {
                          emittedAudioOmission = true;
                          emitChatDelta(data.item_id, data.type, {
                            role: "assistant",
                            content: "[generated audio omitted]",
                          });
                        }
                      } else if (
                        data.type === "response.audio.transcript.done" ||
                        data.type === "response.audio.done"
                      ) {
                        // Delta events already carried all visible semantics.
                        // Done events are terminators, not snapshots to replay.
                        continue;
                      } else if (data.type === "response.output_text.delta") {
                        const textDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        const emittedDelta = appendStreamPartDelta(
                          textPartBuffers,
                          data,
                          textDelta,
                        );
                        if (!emittedDelta) {
                          continue;
                        }
                        // 将output_text.delta转换为chat格式
                        const chatChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: streamModel,
                          choices: [
                            {
                              index: 0,
                              delta: {
                                content: emittedDelta,
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(chatChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item &&
                        isUnsupportedResponsesItem(
                          data.item as ResponsesAPIOutputItem,
                        )
                      ) {
                        emitResponseItemFallback(
                          data.item as ResponsesAPIOutputItem,
                          data.output_index,
                          data.type,
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "function_call"
                      ) {
                        emitResponseItemFallback(
                          data.item as ResponsesAPIOutputItem,
                          data.output_index,
                          data.type,
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "message"
                      ) {
                        (data.item.content || []).forEach((part, index) => {
                          const partEvent = {
                            ...data,
                            item_id: data.item?.id || data.item_id,
                            content_index: index,
                          };
                          if (
                            part.type === "output_text" &&
                            typeof part.text === "string" &&
                            part.text.length > 0
                          ) {
                            const suffix = reconcileStreamPartSnapshot(
                              textPartBuffers,
                              partEvent,
                              part.text,
                              "output text",
                            );
                            if (suffix) {
                              emitChatDelta(data.item?.id, data.type, {
                                role: "assistant",
                                content: suffix,
                              });
                            }
                          } else if (part.type === "refusal") {
                            sawRefusal = true;
                            if (
                              typeof part.refusal === "string" &&
                              part.refusal.length > 0
                            ) {
                              const suffix = reconcileStreamPartSnapshot(
                                refusalPartBuffers,
                                partEvent,
                                part.refusal,
                                "refusal",
                              );
                              if (suffix) {
                                emitChatDelta(data.item?.id, data.type, {
                                  role: "assistant",
                                  refusal: suffix,
                                });
                              }
                            }
                          }
                        });
                      } else if (
                        data.type === "response.output_text.done" &&
                        typeof data.text === "string"
                      ) {
                        const suffix = reconcileStreamPartSnapshot(
                          textPartBuffers,
                          data,
                          data.text,
                          "output text",
                        );
                        if (suffix) {
                          emitChatDelta(data.item_id, data.type, {
                            content: suffix,
                          });
                        }
                      } else if (
                        data.type === "response.refusal.delta"
                      ) {
                        const refusalDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        sawRefusal = true;
                        const emittedDelta = appendStreamPartDelta(
                          refusalPartBuffers,
                          data,
                          refusalDelta,
                        );
                        if (emittedDelta) {
                          emitChatDelta(data.item_id, data.type, {
                            refusal: emittedDelta,
                          });
                        }
                      } else if (
                        data.type === "response.refusal.done"
                      ) {
                        sawRefusal = true;
                        if (typeof data.refusal === "string") {
                          const suffix = reconcileStreamPartSnapshot(
                            refusalPartBuffers,
                            data,
                            data.refusal,
                            "refusal",
                          );
                          if (suffix) {
                            emitChatDelta(data.item_id, data.type, {
                              refusal: suffix,
                            });
                          }
                        }
                      } else if (
                        data.type === "response.output_text.annotation.added"
                      ) {
                        const annotationKeys = getAnnotationKeys(data);
                        if (!seenAny(unsupportedItems, annotationKeys)) {
                          markAll(unsupportedItems, annotationKeys);
                          emitChatDelta(data.item_id, data.type, {
                            role: "assistant",
                            content: boundedResponsesFallback(
                              "citation annotation",
                              data.annotation,
                            ),
                          });
                        }
                      } else if (
                        data.type === "response.function_call_arguments.delta"
                      ) {
                        const argumentDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (!argumentDelta) continue;
                        if (!data.item_id) {
                          emitFatalStreamError(
                            "Responses function argument delta is missing item_id",
                            new Error("missing function item_id"),
                            dataStr,
                            "upstream Responses function arguments are missing item_id",
                          );
                          break;
                        }
                        argumentBuffers.set(
                          data.item_id,
                          (argumentBuffers.get(data.item_id) || "") +
                            argumentDelta,
                        );
                        // Never publish argument-only tool chunks. Until the
                        // output item supplies call_id/name, these bytes are not
                        // an executable call and must remain buffered.
                        if (functionItemsAdded.has(data.item_id)) {
                          emitChatDelta(data.item_id, data.type, {
                            tool_calls: [
                              {
                                index: getToolCallIndex(data.item_id),
                                function: { arguments: argumentDelta },
                              },
                            ],
                          });
                        }
                      } else if (
                        data.type === "response.function_call_arguments.done" &&
                        typeof data.arguments === "string"
                      ) {
                        const itemId = data.item_id || "";
                        if (!itemId) {
                          emitFatalStreamError(
                            "Responses function arguments snapshot is missing item_id",
                            new Error("missing function item_id"),
                            dataStr,
                            "upstream Responses function arguments are missing item_id",
                          );
                          break;
                        }
                        const existing = argumentBuffers.get(itemId) || "";
                        if (!data.arguments.startsWith(existing)) {
                          emitFatalStreamError(
                            "Responses function arguments snapshot diverged from deltas",
                            new Error("argument snapshot mismatch"),
                            dataStr,
                            "upstream Responses function arguments are inconsistent",
                          );
                        } else {
                          const suffix = data.arguments.slice(existing.length);
                          if (suffix) {
                            argumentBuffers.set(itemId, data.arguments);
                            if (functionItemsAdded.has(itemId)) {
                              emitChatDelta(data.item_id, data.type, {
                                tool_calls: [
                                  {
                                    index: getToolCallIndex(itemId),
                                    function: { arguments: suffix },
                                  },
                                ],
                              });
                            }
                          }
                        }
                      } else if (
                        data.type === "response.completed" ||
                        data.type === "response.incomplete"
                      ) {
                        if (!data.response || typeof data.response !== "object") {
                          emitFatalStreamError(
                            "Responses terminal event is missing response",
                            new Error("missing terminal response"),
                            dataStr,
                            "upstream Responses terminal event is missing response",
                          );
                          break;
                        }
                        const terminalSemanticError = responsesStatusError(
                          data.response,
                        );
                        if (terminalSemanticError) {
                          emitSemanticStreamError(terminalSemanticError);
                          break;
                        }
                        const expectedStatus =
                          data.type === "response.completed"
                            ? "completed"
                            : "incomplete";
                        if (
                          data.response.status !== undefined &&
                          data.response.status !== expectedStatus
                        ) {
                          emitFatalStreamError(
                            "Responses terminal event/status mismatch",
                            new Error(
                              `${data.type} carried status ${data.response.status}`,
                            ),
                            dataStr,
                            "upstream Responses terminal event/status mismatch",
                          );
                          break;
                        }
                        if (data.response.error) {
                          const code = data.response.error.code;
                          emitSemanticStreamError({
                            status: mapResponsesErrorStatus(code),
                            type: mapResponsesErrorType(code),
                            code,
                            message:
                              data.response.error.message ||
                              "Responses request failed",
                          });
                          break;
                        }
                        // The terminal event contains a complete Response. Use it
                        // as a deduplicated fallback for compatible endpoints
                        // that omit some/all output_item and delta events.
                        const terminalOutput = data.response?.output || [];
                        if (!validateTerminalFunctions(terminalOutput)) break;
                        for (const [index, item] of terminalOutput.entries()) {
                          emitResponseItemFallback(item, index, data.type);
                          if (fatalStreamError) break;
                        }
                        if (fatalStreamError) break;
                        if (
                          omitReasoning &&
                          suppressedReasoningGroups.some(
                            (keys) => !seenAny(encryptedReasoningItems, keys),
                          )
                        ) {
                          emitFatalStreamError(
                            "Responses omitted reasoning lacked encrypted state",
                            new Error("missing encrypted reasoning state"),
                            JSON.stringify(data.response),
                            "upstream omitted encrypted reasoning state",
                          );
                          break;
                        }
                        flushAllBufferedSummaries();
                        const terminalHasRefusal =
                          sawRefusal ||
                          data.response?.output?.some(
                            (item) =>
                              item.type === "message" &&
                              item.content?.some(
                                (part) => part.type === "refusal",
                              ),
                          );
                        const terminalIsIncomplete =
                          data.type === "response.incomplete" ||
                          data.response?.status === "incomplete" ||
                          sawIncompleteFunctionCall ||
                          data.response?.output?.some(
                            (item) =>
                              item.type === "function_call" &&
                              item.status === "incomplete",
                          );
                        const terminalIsRefusal =
                          terminalHasRefusal ||
                          (terminalIsIncomplete &&
                            data.response?.incomplete_details?.reason ===
                              "content_filter");
                        // Partial call bytes remain in the emitted tool-call
                        // block for fidelity, but an incomplete response/item
                        // must never advertise an executable tool terminal.
                        const finishReason = terminalIsRefusal
                          ? "content_filter"
                          : terminalIsIncomplete
                            ? "length"
                            : data.response?.output?.some(
                                (item) => item.type === "function_call",
                              )
                            ? "tool_calls"
                            : "stop";
                        const cachedTokens =
                          data.response?.usage?.input_tokens_details
                            ?.cached_tokens || 0;
                        const cacheWriteTokens =
                          data.response?.usage?.input_tokens_details
                            ?.cache_write_tokens || 0;

                        const endChunk = {
                          id: data.response?.id || streamId,
                          object: "chat.completion.chunk",
                          created: streamCreated,
                          model: data.response?.model || streamModel,
                          service_tier: data.response?.service_tier,
                          choices: [
                            {
                              index: 0,
                              delta: {},
                              finish_reason: finishReason,
                            },
                          ],
                          usage: data.response?.usage
                            ? {
                                prompt_tokens:
                                  (data.response.usage.input_tokens || 0),
                                completion_tokens:
                                  data.response.usage.output_tokens || 0,
                                total_tokens:
                                  data.response.usage.total_tokens || 0,
                                prompt_tokens_details: {
                                  cached_tokens: cachedTokens,
                                  cache_write_tokens: cacheWriteTokens,
                                },
                                ...(typeof data.response.usage
                                  .output_tokens_details?.reasoning_tokens ===
                                "number"
                                  ? {
                                      completion_tokens_details: {
                                        reasoning_tokens:
                                          data.response.usage
                                            .output_tokens_details
                                            .reasoning_tokens,
                                      },
                                    }
                                  : {}),
                              }
                            : undefined,
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(endChunk)}\n\n`
                          )
                        );
                        isStreamEnded = true;
                        stopReading = true;
                      } else if (
                        data.type === "error" ||
                        data.type === "response.failed" ||
                        data.type === "response.cancelled"
                      ) {
                        const rawError =
                          data.type === "error"
                            ? {
                                code: data.code || data.error?.code,
                                message:
                                  data.message || data.error?.message,
                              }
                            : data.response?.error || data.error || {};
                        const errorCode = rawError.code;
                        emitSemanticStreamError({
                          status:
                            data.type === "response.cancelled"
                              ? 409
                              : mapResponsesErrorStatus(
                                  errorCode || undefined,
                                ),
                          type: data.type === "response.cancelled"
                            ? "conflict_error"
                            : mapResponsesErrorType(
                                errorCode || undefined,
                              ),
                          code: errorCode || undefined,
                          message:
                            rawError.message || "Responses stream failed",
                        });
                      } else if (
                        data.type === "response.reasoning_summary_text.delta"
                      ) {
                        const summaryDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (summaryDelta) {
                          if (omitReasoning) {
                            suppressedReasoningGroups.push(
                              getEventItemKeys(data),
                            );
                            continue;
                          }
                          // Buffer summaries until the reasoning item closes.
                          // If reasoning_text also exists, non-streaming prefers
                          // it and streaming must not concatenate both channels.
                          bufferSummary(data, summaryDelta, false);
                        }
                      } else if (
                        data.type === "response.reasoning_summary_text.done" &&
                        data.text
                      ) {
                        if (omitReasoning) {
                          suppressedReasoningGroups.push(getEventItemKeys(data));
                        } else {
                          bufferSummary(data, data.text, true);
                        }
                      } else if (
                        data.type === "response.reasoning_text.delta"
                      ) {
                        const reasoningDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (reasoningDelta) {
                          const emittedDelta = appendStreamPartDelta(
                            reasoningTextPartBuffers,
                            data,
                            reasoningDelta,
                          );
                          if (omitReasoning) {
                            suppressedReasoningGroups.push(
                              getEventItemKeys(data),
                            );
                            continue;
                          }
                          markAll(reasoningTextItems, getEventItemKeys(data));
                          discardBufferedSummariesForItem(
                            getEventItemKeys(data),
                          );
                          if (emittedDelta) {
                            emitChatDelta(data.item_id, data.type, {
                              thinking: { content: emittedDelta },
                            });
                          }
                        }
                      } else if (
                        data.type === "response.reasoning_text.done" &&
                        typeof data.text === "string"
                      ) {
                        const suffix = reconcileStreamPartSnapshot(
                          reasoningTextPartBuffers,
                          data,
                          data.text,
                          "reasoning text",
                        );
                        if (suffix === null) break;
                        if (omitReasoning) {
                          suppressedReasoningGroups.push(getEventItemKeys(data));
                          continue;
                        }
                        markAll(reasoningTextItems, getEventItemKeys(data));
                        discardBufferedSummariesForItem(getEventItemKeys(data));
                        if (suffix) {
                          emitChatDelta(data.item_id, data.type, {
                            thinking: { content: suffix },
                          });
                        }
                      } else if (
                        data.type === "response.output_item.done" &&
                        data.item
                      ) {
                        emitResponseItemFallback(
                          {
                            ...(data.item as ResponsesAPIOutputItem),
                            id: data.item.id || data.item_id,
                          },
                          data.output_index,
                          data.type,
                        );
                      }
                    if (stopReading) break;
                  } catch (error) {
                    emitFatalStreamError(
                      "Error parsing or transforming SSE event data",
                      error,
                      dataStr,
                    );
                    break;
                  }
                } catch (error) {
                  emitFatalStreamError(
                    "Error processing SSE event",
                    error,
                    dataStr,
                  );
                  break;
                }
              }

              if (stopReading) {
                try {
                  await reader.cancel();
                } catch (cancelError) {
                  transformer.logger?.error(
                    { err: cancelError },
                    "Responses upstream stream cancel failed",
                  );
                }
                break;
              }
              if (done) break;
            }

            // 确保流结束时发送结束标记
            if (!isStreamEnded && !downstreamCancelled) {
              const doneChunk = `data: [DONE]\n\n`;
              controller.enqueue(encoder.encode(doneChunk));
            }
          } catch (error) {
            if (downstreamCancelled) return;
            transformer.logger?.error({ err: error }, "Stream error");
            controller.error(error);
          } finally {
            activeReader = null;
            try {
              reader.releaseLock();
            } catch (e) {
              transformer.logger?.error({ err: e }, "Error releasing reader lock");
            }
            if (!downstreamCancelled) {
              try {
                controller.close();
              } catch (e) {
                transformer.logger?.error(
                  { err: e },
                  "Error closing Responses downstream stream",
                );
              }
            }
          }
        },
        async cancel(reason) {
          downstreamCancelled = true;
          const reader = activeReader;
          if (!reader) return;
          try {
            await reader.cancel(reason);
          } catch (error) {
            transformer.logger?.error(
              { err: error },
              "Responses upstream stream cancel failed",
            );
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return response;
  }

  private normalizeRequestContent(content: any) {
    if (content.type === "text") {
      return {
        // This object is emitted as an EasyInputMessage even for historical
        // assistant turns. `output_text` belongs only to a full
        // ResponseOutputMessage carrying id/status/type metadata.
        type: "input_text",
        text: content.text,
      };
    }

    if (content.type === "image_url") {
      const imagePayload: Record<string, unknown> = {
        type: "input_image",
      };

      if (typeof content.image_url?.url === "string") {
        imagePayload.image_url = content.image_url.url;
      }

      return imagePayload;
    }

    if (
      content.type === "image_file" &&
      typeof content.image_file?.file_id === "string"
    ) {
      return {
        type: "input_image",
        file_id: content.image_file.file_id,
      };
    }

    if (content.type === "file" && content.file) {
      const filePayload: Record<string, unknown> = { type: "input_file" };
      for (const key of [
        "file_data",
        "file_id",
        "file_url",
        "filename",
      ] as const) {
        if (typeof content.file[key] === "string") {
          filePayload[key] = content.file[key];
        }
      }
      return filePayload;
    }

    return null;
  }

  private convertResponseToChat(
    responseData: ResponsesAPIPayload,
    context?: TransformerContext,
  ): any {
    const omitReasoning = context?.thinkingDisplay === "omitted";
    const outputBlocks: Array<Record<string, any>> = [];
    const visibleText: string[] = [];
    const toolCalls: any[] = [];
    const thinkingBlocks: Array<{
      content: string;
      signature?: string;
      tool_call_id?: string;
    }> = [];
    let pendingThinking: typeof thinkingBlocks = [];
    let refusalText = "";
    let hasRefusal = false;
    let hasIncompleteFunctionCall = false;
    const annotations: any[] = [];
    const annotationKeys = new Set<string>();

    const flushPendingThinking = (toolCallId?: string) => {
      if (toolCallId) {
        for (const block of pendingThinking) block.tool_call_id = toolCallId;
      }
      thinkingBlocks.push(...pendingThinking);
      pendingThinking = [];
    };
    const pushVisibleText = (text: string) => {
      outputBlocks.push({ type: "text", text });
      visibleText.push(text);
    };
    const recordCitation = (annotation: any) => {
      if (
        annotation?.type !== "url_citation" ||
        typeof annotation.url !== "string" ||
        annotation.url.length === 0
      ) {
        return;
      }
      const key = JSON.stringify([
        annotation.url,
        annotation.title || "",
        annotation.start_index || 0,
        annotation.end_index || 0,
      ]);
      if (annotationKeys.has(key)) return;
      annotationKeys.add(key);
      annotations.push({
        type: "url_citation",
        url_citation: {
          url: annotation.url,
          title: annotation.title || "",
          content: "",
          start_index: annotation.start_index || 0,
          end_index: annotation.end_index || 0,
        },
      });
    };

    for (const item of responseData.output || []) {
      // Responses programmatic tool calling is a hosted-runtime protocol: its
      // program item, fingerprint, caller relationship, and caller-bearing
      // function output must all be replayed together. Anthropic direct client
      // tools cannot represent that state. Never relabel a program-owned call
      // as a direct tool_use.
      if (isUnsupportedResponsesItem(item)) {
        rejectUnsupportedResponsesItem(item);
      }
      if (item.type === "reasoning") {
        if (!item.id) {
          throw createApiError(
            "upstream Responses reasoning item is missing id",
            502,
            "upstream_protocol_error",
            "api_error",
          );
        }
        const text = reasoningText(item);
        if (omitReasoning && text && !item.encrypted_content) {
          throw createApiError(
            "upstream omitted encrypted reasoning state",
            502,
            "upstream_protocol_error",
            "api_error",
          );
        }
        if (omitReasoning && !item.encrypted_content) continue;
        const signature = encodeReasoningSignature(item, !omitReasoning);
        if (text || signature) {
          const content = omitReasoning ? "" : text;
          outputBlocks.push({
            type: "thinking",
            thinking: content,
            signature,
          });
          pendingThinking.push({ content, signature });
        }
        continue;
      }

      if (item.type === "function_call") {
        const callId = item.call_id || item.id;
        if (!callId || !item.name) {
          throw createApiError(
            "upstream Responses function_call is missing call_id or name",
            502,
            "upstream_protocol_error",
            "api_error",
          );
        }
        const callIsIncomplete =
          responseData.status === "incomplete" || item.status === "incomplete";
        flushPendingThinking(callIsIncomplete ? undefined : callId);
        const rawArguments =
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {});
        toolCalls.push({
          id: callId,
          function: {
            name: item.name || "",
            arguments: rawArguments,
          },
          type: "function",
        });
        if (callIsIncomplete) {
          hasIncompleteFunctionCall = true;
          const boundedArguments =
            rawArguments.length <= 4096
              ? rawArguments
              : `${rawArguments.slice(0, 4096)}…`;
          pushVisibleText(
            `[incomplete function_call ${item.name || "unknown"}: ${boundedArguments}]`,
          );
        } else {
          outputBlocks.push({
            type: "tool_use",
            id: callId,
            name: item.name || "",
            input: parseResponsesToolArguments(item.arguments),
          });
        }
        continue;
      }

      // Any visible/non-reasoning item breaks reasoning/function adjacency.
      flushPendingThinking();
      if (item.type === "web_search_call") {
        // Responses citations do not identify which web_search_call produced
        // them, so even a mapping that looks plausible becomes ambiguous as
        // soon as multiple calls exist. Preserve the complete formal payload
        // as bounded text instead of guessing call/result ownership.
        pushVisibleText(boundedResponsesFallback("web_search_call", item));
      } else if (item.type === "message") {
        for (const part of item.content || []) {
          if (part.type === "output_text") {
            pushVisibleText(part.text || "");
          } else if (part.type === "refusal") {
            hasRefusal = true;
            const text = part.refusal || "";
            refusalText += text;
            pushVisibleText(text);
          } else if (
            part.type === "output_image" ||
            part.type === "output_image_base64"
          ) {
            pushVisibleText("[generated image omitted]");
          } else {
            pushVisibleText(
              boundedResponsesFallback(
                `message content ${part.type || "unknown"}`,
                part,
              ),
            );
          }
          for (const annotation of part.annotations || []) {
            recordCitation(annotation);
            pushVisibleText(
              boundedResponsesFallback("citation annotation", annotation),
            );
          }
        }
      } else if (item.type === "image_generation_call") {
        pushVisibleText("[generated image omitted]");
      } else {
        pushVisibleText(unsupportedOutputPlaceholder(item));
      }
    }
    flushPendingThinking();

    const incompleteReason = responseData.incomplete_details?.reason;
    const responseIsIncomplete =
      responseData.status === "incomplete" || hasIncompleteFunctionCall;
    const responseIsRefusal =
      hasRefusal ||
      (responseIsIncomplete && incompleteReason === "content_filter");
    const chatResponse = {
      id: responseData.id || "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: responseData.created_at,
      model: responseData.model,
      service_tier: responseData.service_tier,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: visibleText.length > 0 ? visibleText.join("") : null,
            tool_calls: toolCalls.length > 0 ? toolCalls : null,
            thinking: thinkingBlocks.length
              ? {
                  content: thinkingBlocks[0].content,
                  signature: thinkingBlocks[0].signature,
                }
              : null,
            thinking_blocks: thinkingBlocks.length
              ? thinkingBlocks
              : undefined,
            output_blocks: outputBlocks,
            annotations: annotations.length > 0 ? annotations : undefined,
            refusal: refusalText || undefined,
          },
          logprobs: null,
          // Keep partial call bytes for fidelity, but length/refusal is the
          // execution boundary: an incomplete call must not become tool_use.
          finish_reason: responseIsRefusal
            ? "content_filter"
            : responseIsIncomplete
              ? "length"
              : toolCalls.length > 0
                ? "tool_calls"
                : "stop",
        },
      ],
      usage: responseData.usage
        ? {
            prompt_tokens: responseData.usage.input_tokens || 0,
            completion_tokens: responseData.usage.output_tokens || 0,
            total_tokens: responseData.usage.total_tokens || 0,
            prompt_tokens_details: {
              cached_tokens:
                responseData.usage.input_tokens_details?.cached_tokens || 0,
              cache_write_tokens:
                responseData.usage.input_tokens_details?.cache_write_tokens ||
                0,
            },
            ...(typeof responseData.usage.output_tokens_details
              ?.reasoning_tokens === "number"
              ? {
                  completion_tokens_details: {
                    reasoning_tokens:
                      responseData.usage.output_tokens_details.reasoning_tokens,
                  },
                }
              : {}),
          }
        : null,
    };

    return chatResponse;
  }

  private buildImageContent(source: {
    url?: string;
    b64_json?: string;
    mime_type?: string;
  }): MessageContent | null {
    if (!source) return null;

    if (source.url || source.b64_json) {
      return {
        type: "image_url",
        image_url: {
          url:
            source.url ||
            `data:${source.mime_type || "image/png"};base64,${source.b64_json}`,
        },
      };
    }

    return null;
  }
}
