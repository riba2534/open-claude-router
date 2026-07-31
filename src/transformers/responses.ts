import { UnifiedChatRequest, MessageContent } from "../types/llm.js";
import { Transformer } from "../types/transformer.js";
import { SseBlockDecoder } from "./sse.js";

const REASONING_SIGNATURE_PREFIX = "ocr-responses-reasoning-v1:";

function encodeReasoningSignature(
  id: string | undefined,
  encryptedContent: string | undefined,
): string | undefined {
  if (!id || !encryptedContent) return undefined;
  return (
    REASONING_SIGNATURE_PREFIX +
    Buffer.from(
      JSON.stringify({ id, encrypted_content: encryptedContent }),
      "utf8",
    ).toString("base64url")
  );
}

function decodeReasoningSignature(
  signature: string | undefined,
): { id: string; encrypted_content: string } | null {
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
      typeof decoded?.encrypted_content === "string" &&
      decoded.encrypted_content.length > 0
    ) {
      return {
        id: decoded.id,
        encrypted_content: decoded.encrypted_content,
      };
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
    output?: Array<{
      type: string;
      encrypted_content?: string;
    }>;
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
    if (reasoningEffort || reasoningOutputRequested) {
      (request as any).reasoning = {
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(reasoningOutputRequested ? { summary: "detailed" } : {}),
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
          .map((content) => this.normalizeRequestContent(content, message.role))
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
          output: convertedMessage.content ?? "",
        });
        return;
      }

      if (message.role === "assistant") {
        const thinking = message.thinking;
        const replayableReasoning = decodeReasoningSignature(
          thinking?.signature,
        );
        if (replayableReasoning) {
          input.push({
            type: "reasoning",
            id: replayableReasoning.id,
            encrypted_content: replayableReasoning.encrypted_content,
            summary: [],
          });
        }

        const hasContent =
          typeof convertedMessage.content === "string"
            ? convertedMessage.content.length > 0
            : Array.isArray(convertedMessage.content) &&
              convertedMessage.content.length > 0;
        if (hasContent || !Array.isArray(message.tool_calls)) {
          delete convertedMessage.tool_calls;
          delete convertedMessage.thinking;
          delete convertedMessage.cache_control;
          input.push(convertedMessage);
        }
      } else {
        delete convertedMessage.cache_control;
        input.push(convertedMessage);
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((tool) => {
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

      const transformer = this;
      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();
          const sseDecoder = new SseBlockDecoder();

          // 索引跟踪变量，只有在事件类型切换时才增加索引
          let currentIndex = -1;
          let lastEventType = "";

          // 获取当前应该使用的索引的函数
          const getCurrentIndex = (eventType: string) => {
            if (eventType !== lastEventType) {
              currentIndex++;
              lastEventType = eventType;
            }
            return currentIndex;
          };

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
          const functionItemsAdded = new Set<string>();
          let stopReading = false;
          let fatalStreamError = false;
          const getEventItemKey = (event: ResponsesStreamEvent): string =>
            event.item_id ||
            event.item?.id ||
            `output:${event.output_index ?? "unknown"}`;
          const getContentPartKey = (
            event: ResponsesStreamEvent,
            contentIndex = event.content_index ?? 0,
          ): string => `${getEventItemKey(event)}:content:${contentIndex}`;
          const getSummaryPartKey = (
            event: ResponsesStreamEvent,
            summaryIndex = event.summary_index ?? 0,
          ): string => `${getEventItemKey(event)}:summary:${summaryIndex}`;
          const getToolCallIndex = (itemId: string): number => {
            if (!toolCallIndexMap.has(itemId)) {
              toolCallIndexMap.set(itemId, nextToolCallIndex++);
            }
            return toolCallIndexMap.get(itemId)!;
          };
          const emitChatDelta = (
            itemId: string | undefined,
            eventType: string,
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
                      index: getCurrentIndex(eventType),
                      delta,
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
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
                        textDeltaParts.add(getContentPartKey(data));
                        // 将output_text.delta转换为chat格式
                        const chatChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: streamModel,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
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
                              index: getCurrentIndex(data.type),
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
                            textDeltaParts.add(
                              getContentPartKey(partEvent, index),
                            );
                            initialContent.push(part.text);
                          } else if (part.type === "refusal" && part.refusal) {
                            refusalDeltaParts.add(
                              getContentPartKey(partEvent, index),
                            );
                            initialContent.push(part.refusal);
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
                        !textDeltaParts.has(getContentPartKey(data))
                      ) {
                        textDeltaParts.add(getContentPartKey(data));
                        emitChatDelta(data.item_id, data.type, {
                          content: data.text,
                        });
                      } else if (
                        data.type === "response.refusal.delta"
                      ) {
                        const refusalDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (refusalDelta) {
                          refusalDeltaParts.add(getContentPartKey(data));
                          emitChatDelta(data.item_id, data.type, {
                            content: refusalDelta,
                          });
                        }
                      } else if (
                        data.type === "response.refusal.done" &&
                        data.refusal &&
                        !refusalDeltaParts.has(getContentPartKey(data))
                      ) {
                        refusalDeltaParts.add(getContentPartKey(data));
                        emitChatDelta(data.item_id, data.type, {
                          content: data.refusal,
                        });
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
                              index: getCurrentIndex(data.type),
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
                              index: getCurrentIndex(data.type),
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
                        const finishReason = data.response?.output?.some(
                          (item: any) => item.type === "function_call"
                        )
                          ? "tool_calls"
                          : data.type === "response.incomplete"
                            ? data.response?.incomplete_details?.reason ===
                              "content_filter"
                              ? "content_filter"
                              : "length"
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
                          reasoningSummaryParts.add(getSummaryPartKey(data));
                          emitChatDelta(data.item_id, data.type, {
                            thinking: { content: summaryDelta },
                          });
                        }
                      } else if (
                        data.type === "response.reasoning_summary_text.done" &&
                        data.text &&
                        !reasoningSummaryParts.has(getSummaryPartKey(data))
                      ) {
                        reasoningSummaryParts.add(getSummaryPartKey(data));
                        emitChatDelta(data.item_id, data.type, {
                          thinking: { content: data.text },
                        });
                      } else if (
                        data.type === "response.reasoning_text.delta"
                      ) {
                        const reasoningDelta =
                          typeof data.delta === "string" ? data.delta : "";
                        if (reasoningDelta) {
                          reasoningTextParts.add(getContentPartKey(data));
                          emitChatDelta(data.item_id, data.type, {
                            thinking: { content: reasoningDelta },
                          });
                        }
                      } else if (
                        data.type === "response.reasoning_text.done" &&
                        data.text &&
                        !reasoningTextParts.has(getContentPartKey(data))
                      ) {
                        reasoningTextParts.add(getContentPartKey(data));
                        emitChatDelta(data.item_id, data.type, {
                          thinking: { content: data.text },
                        });
                      } else if (
                        data.type === "response.output_item.done" &&
                        data.item?.type === "message"
                      ) {
                        const itemId = data.item.id || data.item_id || "";
                        (data.item.content || []).forEach((part, index) => {
                          const partEvent = {
                            ...data,
                            item_id: itemId,
                          };
                          const partKey = getContentPartKey(partEvent, index);
                          if (
                            part.type === "output_text" &&
                            part.text &&
                            !textDeltaParts.has(partKey)
                          ) {
                            textDeltaParts.add(partKey);
                            emitChatDelta(itemId, data.type, {
                              role: "assistant",
                              content: part.text,
                            });
                          } else if (
                            part.type === "refusal" &&
                            part.refusal &&
                            !refusalDeltaParts.has(partKey)
                          ) {
                            refusalDeltaParts.add(partKey);
                            emitChatDelta(itemId, data.type, {
                              role: "assistant",
                              content: part.refusal,
                            });
                          }
                        });
                      } else if (
                        data.type === "response.output_item.done" &&
                        data.item?.type === "function_call"
                      ) {
                        const itemId = data.item.id || data.item_id || "";
                        if (!functionItemsAdded.has(itemId)) {
                          functionItemsAdded.add(itemId);
                          if (data.item.arguments) {
                            argumentDeltaItems.add(itemId);
                          }
                          emitChatDelta(itemId, data.type, {
                            role: "assistant",
                            tool_calls: [
                              {
                                index: getToolCallIndex(itemId),
                                id: data.item.call_id || data.item.id,
                                function: {
                                  name: data.item.name || "",
                                  arguments: data.item.arguments || "",
                                },
                                type: "function",
                              },
                            ],
                          });
                        } else if (
                          data.item.arguments &&
                          !argumentDeltaItems.has(itemId)
                        ) {
                          argumentDeltaItems.add(itemId);
                          emitChatDelta(itemId, data.type, {
                            tool_calls: [
                              {
                                index: getToolCallIndex(itemId),
                                function: {
                                  arguments: data.item.arguments,
                                },
                              },
                            ],
                          });
                        }
                      } else if (
                        data.type === "response.output_item.done" &&
                        data.item?.type === "reasoning"
                      ) {
                        const itemId = data.item.id || data.item_id || "";
                        const reasoningParts = (data.item.content || [])
                          .map((part, index) => ({ part, index }))
                          .filter(({ part }) => part.type === "reasoning_text");
                        if (reasoningParts.length > 0) {
                          reasoningParts.forEach(({ part, index }) => {
                            const partEvent = {
                              ...data,
                              item_id: itemId,
                            };
                            const partKey = getContentPartKey(partEvent, index);
                            if (
                              part.text &&
                              !reasoningTextParts.has(partKey)
                            ) {
                              reasoningTextParts.add(partKey);
                              emitChatDelta(itemId, data.type, {
                                thinking: { content: part.text },
                              });
                            }
                          });
                        } else {
                          (data.item.summary || []).forEach((part, index) => {
                            const partEvent = {
                              ...data,
                              item_id: itemId,
                            };
                            const partKey = getSummaryPartKey(partEvent, index);
                            if (
                              part.text &&
                              !reasoningSummaryParts.has(partKey)
                            ) {
                              reasoningSummaryParts.add(partKey);
                              emitChatDelta(itemId, data.type, {
                                thinking: { content: part.text },
                              });
                            }
                          });
                        }
                        const signature = encodeReasoningSignature(
                          data.item.id || data.item_id,
                          data.item.encrypted_content,
                        );
                        if (signature) {
                          emitChatDelta(itemId, data.type, {
                            thinking: { signature },
                          });
                        }
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
            if (!isStreamEnded) {
              const doneChunk = `data: [DONE]\n\n`;
              controller.enqueue(encoder.encode(doneChunk));
            }
          } catch (error) {
            transformer.logger?.error({ err: error }, "Stream error");
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {
              transformer.logger?.error({ err: e }, "Error releasing reader lock");
            }
            controller.close();
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

  private normalizeRequestContent(content: any, role: string | undefined) {
    if (content.type === "text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content.text,
      };
    }

    if (content.type === "image_url") {
      const imagePayload: Record<string, unknown> = {
        type: role === "assistant" ? "output_image" : "input_image",
      };

      if (typeof content.image_url?.url === "string") {
        imagePayload.image_url = content.image_url.url;
      }

      return imagePayload;
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
    const reasoningOutputs = responseData.output?.filter(
      (item) => item.type === "reasoning",
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

    const reasoningText = reasoningOutputs
      .map((item) => {
        const contentText = (item.content || [])
          .filter((part) => part.type === "reasoning_text")
          .map((part) => part.text || "")
          .join("");
        if (contentText) return contentText;
        return (item.summary || [])
          .map((part) => part.text || "")
          .join("");
      })
      .filter(Boolean)
      .join("\n");
    const encryptedContent = reasoningOutputs.find(
      (item) => item.encrypted_content,
    )?.encrypted_content;
    const reasoningItem = reasoningOutputs.find(
      (item) => item.encrypted_content,
    );
    if (reasoningText || encryptedContent) {
      thinking = {
        content: reasoningText,
        signature: encodeReasoningSignature(
          reasoningItem?.id,
          encryptedContent,
        ),
      };
    }

    if (messageOutputs.length > 0) {
      const contentParts: MessageContent[] = [];
      messageOutputs.flatMap((message) => message.content || []).forEach((item: any) => {
        if (item.type === "output_text") {
          contentParts.push({ type: "text", text: item.text || "" });
        } else if (item.type === "refusal") {
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
            annotations: annotations.length > 0 ? annotations : undefined,
          },
          logprobs: null,
          finish_reason: toolCalls
            ? "tool_calls"
            : responseData.status === "incomplete"
              ? incompleteReason === "content_filter"
                ? "content_filter"
                : "length"
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
