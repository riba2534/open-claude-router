import type { ChatCompletion } from "openai/resources";
import {
  AnthropicEffort,
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

function jsonFallback(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return String(value ?? "");
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
    return { type: "text" as const, text: jsonFallback(block) };
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
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => ({
            type: "text" as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({
          role: "system",
          content: textParts,
        });
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

            const textAndMediaParts = msg.content.filter(
              (c: any) =>
                (c.type === "text" && c.text) ||
                (c.type === "image" && c.source)
            );
            if (textAndMediaParts.length) {
              messages.push({
                role: "user",
                content: textAndMediaParts.map((part: any) => {
                  if (part?.type === "image") {
                    return convertAnthropicImage(part);
                  }
                  return part;
                }).filter(Boolean),
              });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            if (textParts.length) {
              assistantMessage.content = textParts
                .map((text: any) => text.text)
                .join("\n");
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

            const thinkingPart = msg.content.find(
              (c: any) => c.type === "thinking" && c.signature
            );
            if (thinkingPart) {
              assistantMessage.thinking = {
                content: thinkingPart.thinking,
                signature: thinkingPart.signature,
              };
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
      result.reasoning = {
        effort:
          explicitEffort ?? getThinkLevel(request.thinking.budget_tokens),
        enabled: true,
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
        parameters: tool.input_schema,
      },
    }));
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
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
        const toolCalls = new Map<number, any>();
        let totalChunks = 0;
        let contentChunks = 0;
        let toolCallChunks = 0;
        let isClosed = false;
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

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
              const dataStr = new TextDecoder().decode(data);
              this.logger.debug({
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
                this.logger.debug({
                  reqId: context.req.id,
                  error: error instanceof Error ? error.message : String(error),
                  type: "send data error",
                });
                throw error;
              }
            }
          }
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
        const flushToolCalls = () => {
          if (toolCalls.size === 0) return;
          closeCurrentBlock();
          for (const [, toolCall] of [...toolCalls.entries()].sort(
            ([left], [right]) => left - right,
          )) {
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
              );
            }
            safeEnqueue(
              encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: blockIndex,
                })}\n\n`,
              ),
            );
          }
          toolCalls.clear();
        };

        const safeClose = () => {
          if (!isClosed) {
            try {
              if (!hasStarted) {
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
          const sseDecoder = new SseBlockDecoder();

          while (true) {
            if (isClosed) {
              break;
            }

            const { done, value } = await reader.read();
            const events = done
              ? sseDecoder.finish()
              : sseDecoder.push(value);

            for (const event of events) {
              if (isClosed || streamFailed) break;

              const data = event.data.trim();
              this.logger.debug({
                reqId: context.req.id,
                type: "recieved data",
                data,
              });

              if (data === "[DONE]") {
                // `[DONE]` is a framing terminator, not proof of a successful
                // completion. Stop reading now; safeClose() still requires a
                // preceding finish_reason before it can emit message_stop.
                sawDone = true;
                break;
              }

              try {
                const chunk = JSON.parse(data);
                totalChunks++;
                this.logger.debug({
                  reqId: context.req.id,
                  response: chunk,
                  tppe: "Original Response",
                });
                if (chunk.error) {
                  const errorMessage = {
                    type: "error",
                    error: {
                      type: "api_error",
                      message: JSON.stringify(chunk.error),
                    },
                  };

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
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  } else {
                    stopReasonMessageDelta.usage = {
                      input_tokens:
                        (chunk.usage?.prompt_tokens || 0) -
                        (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0),
                      output_tokens: chunk.usage?.completion_tokens || 0,
                      cache_read_input_tokens:
                        chunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                    };
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
                const choiceText =
                  choice?.delta?.content ||
                  (choice?.delta as any)?.refusal ||
                  "";

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
                    if (
                      currentBlockType === null &&
                      contentChunks === 0 &&
                      toolCallChunks === 0
                    ) {
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
                    }
                    // Seal only while the thinking block is actually open. A
                    // stray signature arriving after the block was closed by a
                    // content/tool chunk must be dropped — emitting it onto the
                    // current (text/tool) block breaks Anthropic clients.
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

                if (
                  choice?.delta?.annotations?.length &&
                  !isClosed &&
                  !hasFinished
                ) {
                  // Close the open content block (seals unsigned thinking).
                  flushToolCalls();
                  closeCurrentBlock();

                  choice?.delta?.annotations.forEach((annotation: any) => {
                    const id = `srvtoolu_${uuidv4()}`;
                    const useBlockIndex = assignContentBlockIndex();
                    const useBlockStart = {
                      type: "content_block_start",
                      index: useBlockIndex,
                      content_block: {
                        type: "server_tool_use",
                        id,
                        name: "web_search",
                        input: { query: "" },
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          useBlockStart
                        )}\n\n`
                      )
                    );
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify({
                          type: "content_block_stop",
                          index: useBlockIndex,
                        })}\n\n`
                      )
                    );

                    const resultBlockIndex = assignContentBlockIndex();
                    const resultBlockStart = {
                      type: "content_block_start",
                      index: resultBlockIndex,
                      content_block: {
                        type: "web_search_tool_result",
                        tool_use_id: id,
                        content: [
                          {
                            type: "web_search_result",
                            title: annotation.url_citation.title,
                            url: annotation.url_citation.url,
                          },
                        ],
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          resultBlockStart
                        )}\n\n`
                      )
                    );

                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: resultBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  });
                }

                if (choice?.delta?.tool_calls && !isClosed && !hasFinished) {
                  toolCallChunks++;

                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const toolCallIndex = toolCall.index ?? 0;
                    let currentToolCall = toolCalls.get(toolCallIndex);
                    if (!currentToolCall) {
                      closeCurrentBlock();
                      currentToolCall = {
                        id:
                          toolCall.id ||
                          `call_${Date.now()}_${toolCallIndex}`,
                        name:
                          toolCall.function?.name || `tool_${toolCallIndex}`,
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
                  sawTerminal = true;
                  hasFinished = true;
                  if (contentChunks === 0 && toolCallChunks === 0) {
                    this.logger?.error(
                      "Warning: No content in the stream response!"
                    );
                  }

                  flushToolCalls();
                  closeCurrentBlock();

                  if (!isClosed) {
                    const stopReasonMapping: Record<string, string> = {
                      stop: "end_turn",
                      length: "max_tokens",
                      tool_calls: "tool_use",
                      content_filter: "end_turn",
                    };

                    const anthropicStopReason =
                      stopReasonMapping[choice.finish_reason] || "end_turn";

                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  }

                  continue;
                }
              } catch (parseError: any) {
                this.logger?.error(
                  `parseError: ${parseError.name} message: ${parseError.message} stack: ${parseError.stack} data: ${data}`
                );
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
          if (streamFailed) {
            if (!isClosed) {
              controller.close();
              isClosed = true;
            }
          } else {
            safeClose();
          }
        } catch (error) {
          if (!isClosed) {
            try {
              controller.error(error);
            } catch (controllerError) {
              this.logger?.error({ err: controllerError }, "controller.error failed");
            }
          }
        } finally {
          if (reader) {
            try {
              reader.releaseLock();
            } catch (releaseError) {
              this.logger?.error({ err: releaseError }, "reader.releaseLock failed");
            }
          }
        }
      },
      cancel: (reason) => {
        this.logger.debug(
          {
            reqId: context.req.id,
          },
          `cancel stream: ${reason}`
        );
      },
    });

    return readable;
  }

  private convertOpenAIResponseToAnthropic(
    openaiResponse: ChatCompletion,
    context: TransformerContext
  ): any {
    this.logger.debug(
      {
        reqId: context.req.id,
        response: openaiResponse,
      },
      `Original OpenAI response`
    );
    try {
      const choice = openaiResponse.choices[0];
      if (!choice) {
        throw new Error("No choices found in OpenAI response");
      }
      const content: any[] = [];
      if (choice.message.annotations?.length) {
        const id = `srvtoolu_${uuidv4()}`;
        content.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {
            query: "",
          },
        });
        content.push({
          type: "web_search_tool_result",
          tool_use_id: id,
          content: choice.message.annotations.map((item) => {
            return {
              type: "web_search_result",
              url: item.url_citation.url,
              title: item.url_citation.title,
            };
          }),
        });
      }
      // Thinking blocks precede text/tool blocks in Anthropic responses.
      const upstreamThinking = (choice.message as any)?.thinking;
      const messageThinking =
        upstreamThinking?.content ??
        (choice.message as any)?.reasoning_content;
      if (
        typeof messageThinking === "string" &&
        (messageThinking.length > 0 || upstreamThinking?.signature)
      ) {
        content.unshift({
          type: "thinking",
          thinking: messageThinking,
          signature:
            upstreamThinking?.signature ||
            `sig_${Date.now()}`,
        });
      }
      if (typeof choice.message.content === "string" && choice.message.content) {
        content.push({ type: "text", text: choice.message.content });
      } else if (Array.isArray(choice.message.content)) {
        for (const part of choice.message.content as any[]) {
          if (part?.type === "text" && typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
          } else {
            content.push({ type: "text", text: jsonFallback(part) });
          }
        }
      }
      if (
        typeof (choice.message as any).refusal === "string" &&
        (choice.message as any).refusal
      ) {
        content.push({
          type: "text",
          text: (choice.message as any).refusal,
        });
      }
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        choice.message.tool_calls.forEach((toolCall) => {
          let parsedInput = {};
          try {
            const argumentsStr = toolCall.function.arguments || "{}";

            if (typeof argumentsStr === "object") {
              parsedInput = argumentsStr;
            } else if (typeof argumentsStr === "string") {
              parsedInput = JSON.parse(argumentsStr);
            }
          } catch {
            parsedInput = { text: toolCall.function.arguments || "" };
          }

          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          });
        });
      }
      const result = {
        id: openaiResponse.id,
        type: "message",
        role: "assistant",
        model: openaiResponse.model,
        content: content,
        stop_reason:
          choice.finish_reason === "stop"
            ? "end_turn"
            : choice.finish_reason === "length"
            ? "max_tokens"
            : choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "content_filter"
            ? "end_turn"
            : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens:
            (openaiResponse.usage?.prompt_tokens || 0) -
            (openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0),
          output_tokens: openaiResponse.usage?.completion_tokens || 0,
          cache_read_input_tokens:
            openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
        },
      };
      this.logger.debug(
        {
          reqId: context.req.id,
          result,
        },
        `Conversion complete, final Anthropic response`
      );
      return result;
    } catch {
      throw createApiError(
        `Provider error: ${JSON.stringify(openaiResponse)}`,
        500,
        "provider_error"
      );
    }
  }
}
