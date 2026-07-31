import { UnifiedChatRequest, MessageContent } from "../types/llm.js";
import { Transformer } from "../types/transformer.js";
import { SseBlockDecoder } from "./sse.js";

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
): string | undefined {
  if (!item.id) return undefined;
  const envelope: RouterReasoningEnvelope = { id: item.id };
  if (item.encrypted_content) {
    envelope.encrypted_content = item.encrypted_content;
  } else {
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
  if (code === "rate_limit_exceeded") return "rate_limit_error";
  if (
    code === "invalid_prompt" ||
    code?.startsWith("invalid_") ||
    code?.startsWith("unsupported_") ||
    code?.startsWith("empty_") ||
    code?.startsWith("failed_to_")
  ) {
    return "invalid_request_error";
  }
  return "api_error";
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
    annotations?: Array<{
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
}

interface ResponsesAPIPayload {
  id: string;
  object: string;
  model: string;
  created_at: number;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
  status?: string;
  incomplete_details?: {
    reason?: string;
  };
}

interface ResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
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
    }>;
    reasoning?: string; // 添加 reasoning 字段支持
    summary?: Array<{ type?: string; text?: string }>;
    encrypted_content?: string;
    result?: string;
    status?: string;
  };
  text?: string;
  refusal?: string;
  arguments?: string;
  response?: {
    id?: string;
    model?: string;
    created_at?: number;
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
  };
  reasoning_summary?: string; // 添加推理摘要支持
  annotation?: {
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
          const reasoningItem = {
            type: "reasoning",
            id: replayableReasoning.id,
            ...(replayableReasoning.encrypted_content
              ? {
                  encrypted_content:
                    replayableReasoning.encrypted_content,
                }
              : {}),
            summary: replayableReasoning.summary ?? [],
            ...(replayableReasoning.content
              ? { content: replayableReasoning.content }
              : {}),
          };
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
      }));
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

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      const jsonResponse: any = await response.json();

      // 检查是否为responses API格式的JSON响应
      if (jsonResponse.object === "response" && jsonResponse.output) {
        if (jsonResponse.status === "failed") {
          return new Response(
            JSON.stringify({
              error: {
                type: mapResponsesErrorType(jsonResponse.error?.code),
                message:
                  jsonResponse.error?.message ||
                  "Responses request failed",
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        // 将responses格式转换为chat格式
        const chatResponse = this.convertResponseToChat(jsonResponse);
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
          const textDeltaParts = new Set<string>();
          const refusalDeltaParts = new Set<string>();
          const argumentDeltaItems = new Set<string>();
          const reasoningSummaryParts = new Set<string>();
          const reasoningTextParts = new Set<string>();
          const reasoningTextItems = new Set<string>();
          const reasoningSignatureItems = new Set<string>();
          const functionItemsAdded = new Set<string>();
          const imageGenerationItems = new Set<string>();
          let sawRefusal = false;
          let sawIncompleteFunctionCall = false;
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
          const seenAny = (marked: Set<string>, keys: string[]): boolean =>
            keys.some((key) => marked.has(key));
          const markAll = (marked: Set<string>, keys: string[]): void =>
            keys.forEach((key) => marked.add(key));
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
            const itemId = item.id || item.call_id || "";
            const itemEvent: ResponsesStreamEvent = {
              type: eventType,
              item_id: item.id,
              output_index: outputIndex,
              item: item as ResponsesStreamEvent["item"],
            };

            if (item.type === "message") {
              (item.content || []).forEach((part, index) => {
                const partKeys = getContentPartKeys(itemEvent, index);
                if (
                  part.type === "output_text" &&
                  part.text &&
                  !seenAny(textDeltaParts, partKeys)
                ) {
                  markAll(textDeltaParts, partKeys);
                  emitChatDelta(itemId, eventType, {
                    role: "assistant",
                    content: part.text,
                  });
                } else if (part.type === "refusal") {
                  sawRefusal = true;
                  if (
                    part.refusal &&
                    !seenAny(refusalDeltaParts, partKeys)
                  ) {
                    markAll(refusalDeltaParts, partKeys);
                    emitChatDelta(itemId, eventType, {
                      role: "assistant",
                      content: part.refusal,
                    });
                  }
                }
              });
              return;
            }

            if (item.type === "function_call") {
              if (item.status === "incomplete") {
                sawIncompleteFunctionCall = true;
              }
              if (!functionItemsAdded.has(itemId)) {
                functionItemsAdded.add(itemId);
                if (item.arguments) argumentDeltaItems.add(itemId);
                emitChatDelta(itemId, eventType, {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: getToolCallIndex(itemId),
                      id: item.call_id || item.id,
                      function: {
                        name: item.name || "",
                        arguments: item.arguments || "",
                      },
                      type: "function",
                    },
                  ],
                });
              } else if (
                item.arguments &&
                !argumentDeltaItems.has(itemId)
              ) {
                argumentDeltaItems.add(itemId);
                emitChatDelta(itemId, eventType, {
                  tool_calls: [
                    {
                      index: getToolCallIndex(itemId),
                      function: { arguments: item.arguments },
                    },
                  ],
                });
              }
              return;
            }

            if (item.type === "reasoning") {
              const itemKeys = getEventItemKeys(itemEvent);
              const reasoningParts = (item.content || [])
                .map((part, index) => ({ part, index }))
                .filter(({ part }) => part.type === "reasoning_text");
              if (reasoningParts.length > 0) {
                markAll(reasoningTextItems, itemKeys);
                discardBufferedSummariesForItem(itemKeys);
                for (const { part, index } of reasoningParts) {
                  const partKeys = getContentPartKeys(itemEvent, index);
                  if (
                    part.text &&
                    !seenAny(reasoningTextParts, partKeys)
                  ) {
                    markAll(reasoningTextParts, partKeys);
                    emitChatDelta(itemId, eventType, {
                      thinking: { content: part.text },
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
            }
          };
          const emitFatalStreamError = (
            message: string,
            error: unknown,
            data: string,
          ) => {
            if (fatalStreamError) return;
            transformer.logger?.error(
              { err: error, data },
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
                    message: "malformed upstream SSE event",
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
                          choices: [],
                        };
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(metadataChunk)}\n\n`,
                          ),
                        );
                      } else if (data.type === "response.output_text.delta") {
                        const textDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (!textDelta) continue;
                        markAll(textDeltaParts, getContentPartKeys(data));
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
                                content: textDelta,
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
                        data.item?.type === "function_call"
                      ) {
                        if (data.item.status === "incomplete") {
                          sawIncompleteFunctionCall = true;
                        }
                        if (data.item?.id) {
                          functionItemsAdded.add(data.item.id);
                        }
                        // 处理function call开始 - 创建初始的tool call chunk
                        const functionCallChunk = {
                          id:
                            data.item.call_id ||
                            data.item.id ||
                            "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: streamModel,
                          choices: [
                            {
                              index: 0,
                              delta: {
                                role: "assistant",
                                tool_calls: [
                                  {
                                    // Key the index map by item.id (= the
                                    // `item_id` carried on later
                                    // function_call_arguments.delta events).
                                    // call_id is a *different* identifier, so
                                    // keying by it here would never match the
                                    // delta lookup below and would scatter a
                                    // tool call's name and arguments across two
                                    // indices.
                                    index: getToolCallIndex(
                                      data.item.id || data.item.call_id || ""
                                    ),
                                    id: data.item.call_id || data.item.id,
                                    function: {
                                      name: data.item.name || "",
                                      arguments: "",
                                    },
                                    type: "function",
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "message"
                      ) {
                        const initialContent: string[] = [];
                        (data.item.content || []).forEach((part, index) => {
                          const partEvent = {
                            ...data,
                            item_id: data.item?.id || data.item_id,
                          };
                          if (part.type === "output_text" && part.text) {
                            markAll(
                              textDeltaParts,
                              getContentPartKeys(partEvent, index),
                            );
                            initialContent.push(part.text);
                          } else if (part.type === "refusal") {
                            sawRefusal = true;
                            if (part.refusal) {
                              markAll(
                                refusalDeltaParts,
                                getContentPartKeys(partEvent, index),
                              );
                              initialContent.push(part.refusal);
                            }
                          }
                        });
                        if (initialContent.length > 0) {
                          emitChatDelta(data.item.id, data.type, {
                            role: "assistant",
                            content: initialContent.join(""),
                          });
                        }
                      } else if (
                        data.type === "response.output_text.done" &&
                        data.text &&
                        !seenAny(textDeltaParts, getContentPartKeys(data))
                      ) {
                        markAll(textDeltaParts, getContentPartKeys(data));
                        emitChatDelta(data.item_id, data.type, {
                          content: data.text,
                        });
                      } else if (
                        data.type === "response.refusal.delta"
                      ) {
                        const refusalDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        sawRefusal = true;
                        if (refusalDelta) {
                          markAll(refusalDeltaParts, getContentPartKeys(data));
                          emitChatDelta(data.item_id, data.type, {
                            content: refusalDelta,
                          });
                        }
                      } else if (
                        data.type === "response.refusal.done"
                      ) {
                        sawRefusal = true;
                        if (
                          data.refusal &&
                          !seenAny(
                            refusalDeltaParts,
                            getContentPartKeys(data),
                          )
                        ) {
                          markAll(refusalDeltaParts, getContentPartKeys(data));
                          emitChatDelta(data.item_id, data.type, {
                            content: data.refusal,
                          });
                        }
                      } else if (
                        data.type === "response.output_text.annotation.added"
                      ) {
                        const annotationChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: streamModel,
                          choices: [
                            {
                              index: 0,
                              delta: {
                                annotations: [
                                  {
                                    type: "url_citation",
                                    url_citation: {
                                      url: data.annotation?.url || "",
                                      title: data.annotation?.title || "",
                                      content: "",
                                      start_index:
                                        data.annotation?.start_index || 0,
                                      end_index:
                                        data.annotation?.end_index || 0,
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(annotationChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.function_call_arguments.delta"
                      ) {
                        const argumentDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (!argumentDelta) continue;
                        if (data.item_id) argumentDeltaItems.add(data.item_id);
                        // 处理function call参数增量
                        const functionCallChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: streamModel,
                          choices: [
                            {
                              index: 0,
                              delta: {
                                tool_calls: [
                                  {
                                    index: getToolCallIndex(
                                      data.item_id || ""
                                    ),
                                    function: {
                                      arguments: argumentDelta,
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.function_call_arguments.done" &&
                        data.arguments &&
                        !argumentDeltaItems.has(data.item_id || "")
                      ) {
                        if (data.item_id) argumentDeltaItems.add(data.item_id);
                        emitChatDelta(data.item_id, data.type, {
                          tool_calls: [
                            {
                              index: getToolCallIndex(data.item_id || ""),
                              function: { arguments: data.arguments },
                            },
                          ],
                        });
                      } else if (
                        data.type === "response.completed" ||
                        data.type === "response.incomplete"
                      ) {
                        // The terminal event contains a complete Response. Use it
                        // as a deduplicated fallback for compatible endpoints
                        // that omit some/all output_item and delta events.
                        (data.response?.output || []).forEach((item, index) => {
                          emitResponseItemFallback(item, index, data.type);
                        });
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

                        const endChunk = {
                          id: data.response?.id || streamId,
                          object: "chat.completion.chunk",
                          created: streamCreated,
                          model: data.response?.model || streamModel,
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
                                },
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
                        data.type === "response.failed"
                      ) {
                        const errorChunk = {
                          id: data.response?.id || streamId,
                          object: "chat.completion.chunk",
                          created: streamCreated,
                          model: data.response?.model || streamModel,
                          error:
                            data.type === "error"
                              ? {
                                  type: data.code || "api_error",
                                  message:
                                    data.message || "Responses stream error",
                                }
                              : data.response?.error ||
                                data.error || {
                                  type: "api_error",
                                  message: "Responses stream failed",
                                },
                          choices: [],
                        };
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(errorChunk)}\n\n`,
                          ),
                        );
                        isStreamEnded = true;
                        stopReading = true;
                      } else if (
                        data.type === "response.reasoning_summary_text.delta"
                      ) {
                        const summaryDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (summaryDelta) {
                          // Buffer summaries until the reasoning item closes.
                          // If reasoning_text also exists, non-streaming prefers
                          // it and streaming must not concatenate both channels.
                          bufferSummary(data, summaryDelta, false);
                        }
                      } else if (
                        data.type === "response.reasoning_summary_text.done" &&
                        data.text
                      ) {
                        bufferSummary(data, data.text, true);
                      } else if (
                        data.type === "response.reasoning_text.delta"
                      ) {
                        const reasoningDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (reasoningDelta) {
                          markAll(reasoningTextItems, getEventItemKeys(data));
                          discardBufferedSummariesForItem(
                            getEventItemKeys(data),
                          );
                          markAll(reasoningTextParts, getContentPartKeys(data));
                          emitChatDelta(data.item_id, data.type, {
                            thinking: { content: reasoningDelta },
                          });
                        }
                      } else if (
                        data.type === "response.reasoning_text.done" &&
                        data.text &&
                        !seenAny(reasoningTextParts, getContentPartKeys(data))
                      ) {
                        markAll(reasoningTextItems, getEventItemKeys(data));
                        discardBufferedSummariesForItem(getEventItemKeys(data));
                        markAll(reasoningTextParts, getContentPartKeys(data));
                        emitChatDelta(data.item_id, data.type, {
                          thinking: { content: data.text },
                        });
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

  private convertResponseToChat(responseData: ResponsesAPIPayload): any {
    const messageOutputs = responseData.output?.filter(
      (item) => item.type === "message",
    );
    const functionCallOutputs = responseData.output?.filter(
      (item) => item.type === "function_call",
    );
    const imageGenerationOutputs = responseData.output?.filter(
      (item) => item.type === "image_generation_call",
    );
    const annotations = messageOutputs
      .flatMap((message) => message.content || [])
      .flatMap((item) => item.annotations || [])
      .map((item) => ({
          type: "url_citation",
          url_citation: {
            url: item.url || "",
            title: item.title || "",
            content: "",
            start_index: item.start_index || 0,
            end_index: item.end_index || 0,
          },
        }));

    let messageContent: string | MessageContent[] | null = null;
    let toolCalls: any = null;
    let thinking: any = null;

    // One thinking block per reasoning item — each keeps its own id +
    // replay envelope, paired only with a directly following function_call.
    // Any intervening visible/unknown output flushes the reasoning as unpaired;
    // otherwise reasoning -> message -> function_call would be reordered into
    // message -> reasoning -> function_call by the unified Chat shape.
    // Collapsing items into one block loses every id after the first.
    const reasoningItemText = (item: ResponsesAPIOutputItem): string => {
      const contentText = (item.content || [])
        .filter((part) => part.type === "reasoning_text")
        .map((part) => part.text || "")
        .join("");
      if (contentText) return contentText;
      return (item.summary || []).map((part) => part.text || "").join("");
    };
    const thinkingBlocks: Array<{
      content: string;
      signature?: string;
      tool_call_id?: string;
    }> = [];
    {
      let pendingThinking: typeof thinkingBlocks = [];
      for (const item of responseData.output || []) {
        if (item.type === "reasoning") {
          const text = reasoningItemText(item);
          const signature = encodeReasoningSignature(item);
          if (text || signature) {
            pendingThinking.push({ content: text, signature });
          }
        } else if (item.type === "function_call") {
          const pairedCallId = item.call_id || item.id;
          if (pairedCallId) {
            for (const block of pendingThinking) {
              block.tool_call_id = pairedCallId;
            }
          }
          thinkingBlocks.push(...pendingThinking);
          pendingThinking = [];
        } else {
          thinkingBlocks.push(...pendingThinking);
          pendingThinking = [];
        }
      }
      thinkingBlocks.push(...pendingThinking);
    }
    if (thinkingBlocks.length) {
      thinking = {
        content: thinkingBlocks[0].content,
        signature: thinkingBlocks[0].signature,
      };
    }

    const contentParts: MessageContent[] = [];
    let hasRefusal = false;
    if (messageOutputs.length > 0) {
      messageOutputs.flatMap((message) => message.content || []).forEach((item: any) => {
        if (item.type === "output_text") {
          contentParts.push({ type: "text", text: item.text || "" });
        } else if (item.type === "refusal") {
          hasRefusal = true;
          contentParts.push({ type: "text", text: item.refusal || "" });
        } else if (item.type === "output_image") {
          const imageContent = this.buildImageContent({
            url: item.image_url,
            mime_type: item.mime_type,
          });
          if (imageContent) contentParts.push(imageContent);
        } else if (item.type === "output_image_base64") {
          const imageContent = this.buildImageContent({
            b64_json: item.image_base64,
            mime_type: item.mime_type,
          });
          if (imageContent) contentParts.push(imageContent);
        }
      });

    }
    // The formal image-generation output is an output item, not a message
    // content part. Anthropic has no equivalent response block; emit a bounded
    // placeholder rather than returning a successful-looking empty message or
    // inlining a potentially multi-megabyte base64 result.
    for (const _image of imageGenerationOutputs) {
      contentParts.push({ type: "text", text: "[generated image omitted]" });
    }
    if (contentParts.length > 0) {
      if (contentParts.some((part) => part.type === "image_url")) {
        messageContent = contentParts;
      } else {
        messageContent = contentParts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
    }

    if (functionCallOutputs && functionCallOutputs.length > 0) {
      // 处理function_call类型的输出（支持多工具并行调用）
      toolCalls = functionCallOutputs.map((fc: any) => ({
        id: fc.call_id || fc.id,
        function: {
          name: fc.name,
          arguments: fc.arguments,
        },
        type: "function",
      }));
    }

    const incompleteReason = responseData.incomplete_details?.reason;
    const hasIncompleteFunctionCall = functionCallOutputs.some(
      (item) => item.status === "incomplete",
    );
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
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: messageContent || null,
            tool_calls: toolCalls,
            thinking: thinking,
            thinking_blocks: thinkingBlocks.length
              ? thinkingBlocks
              : undefined,
            annotations: annotations.length > 0 ? annotations : undefined,
          },
          logprobs: null,
          // Keep partial call bytes for fidelity, but length/refusal is the
          // execution boundary: an incomplete call must not become tool_use.
          finish_reason: responseIsRefusal
            ? "content_filter"
            : responseIsIncomplete
              ? "length"
              : toolCalls
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
            },
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
