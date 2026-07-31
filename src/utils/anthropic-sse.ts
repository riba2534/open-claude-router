import { createApiError } from "../transformers/errors.js";

/**
 * The response shape returned to the client must always follow the client's
 * `stream` flag, not whatever Content-Type the upstream happened to answer
 * with. These helpers convert between a complete Anthropic message and the
 * Anthropic SSE event sequence for the two mismatch cases:
 *
 *  - client `stream:true`, upstream answered JSON  -> synthesize SSE
 *  - client `stream:false`, upstream streamed SSE  -> aggregate to JSON
 */

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Keep transport failures inside the Anthropic SSE protocol. Once a streaming
 * reply has started Fastify cannot replace it with a JSON error response; an
 * errored Web ReadableStream otherwise bubbles out as an internal payload-type
 * error or an abruptly reset connection.
 */
export function guardAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  let finished = false;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // The stream may have been canceled concurrently; there is no remaining
      // resource to recover at this protocol boundary.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        if (finished) return;
        finished = true;
        release();
        // Do not expose transport exception details or attempt to synthesize a
        // success terminal after a partial response.
        try {
          controller.enqueue(
            encoder.encode(
              sseEvent("error", {
                type: "error",
                error: {
                  type: "api_error",
                  message: "upstream stream transport failed",
                },
              }),
            ),
          );
          controller.close();
        } catch {
          // A downstream cancellation can race the pending read. In that case
          // the consumer no longer exists, so there is nothing left to emit.
        }
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is best-effort and must not produce an unhandled
        // rejection after the downstream consumer has gone away.
      } finally {
        release();
      }
    },
  });
}

export function anthropicMessageToSseText(message: any): string {
  const frames: string[] = [];
  const usage = message?.usage ?? {};
  const contentBlocks: any[] = Array.isArray(message?.content)
    ? message.content
    : [];

  frames.push(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_details: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: 0,
          ...(usage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
          ...(usage.cache_creation_input_tokens !== undefined
            ? {
                cache_creation_input_tokens:
                  usage.cache_creation_input_tokens,
              }
            : {}),
        },
      },
    }),
  );

  contentBlocks.forEach((block, index) => {
    if (block?.type === "text") {
      frames.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      if (block.text) {
        frames.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          }),
        );
      }
    } else if (block?.type === "thinking") {
      frames.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
      if (block.thinking) {
        frames.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          }),
        );
      }
      if (block.signature) {
        frames.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature },
          }),
        );
      }
    } else if (block?.type === "tool_use") {
      frames.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
            caller: block.caller ?? { type: "direct" },
          },
        }),
      );
      frames.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
      );
    } else {
      // server_tool_use / web_search_tool_result / future blocks: emit whole.
      frames.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: block,
        }),
      );
    }
    frames.push(
      sseEvent("content_block_stop", { type: "content_block_stop", index }),
    );
  });

  frames.push(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: message?.stop_reason ?? "end_turn",
        stop_details: message?.stop_details ?? null,
        stop_sequence: message?.stop_sequence ?? null,
      },
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens !== undefined
          ? { cache_read_input_tokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage.cache_creation_input_tokens !== undefined
          ? {
              cache_creation_input_tokens:
                usage.cache_creation_input_tokens,
            }
          : {}),
      },
    }),
  );
  frames.push(sseEvent("message_stop", { type: "message_stop" }));
  return frames.join("");
}

/**
 * Collapse an Anthropic SSE response (produced by our own transformer) into
 * one complete message object. Any `error` event — or a stream that ends
 * without message_stop — throws a 502 ApiError; a partial stream must never
 * be reported to the client as a completed message.
 */
export async function aggregateAnthropicSseToMessage(
  response: Response,
): Promise<any> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw createApiError(
      "upstream stream transport failed",
      502,
      "upstream_stream_error",
      "api_error",
    );
  }
  const events = text
    .split(/\n\n/)
    .map((frame) =>
      frame.split("\n").find((line) => line.startsWith("data: ")),
    )
    .filter((line): line is string => Boolean(line))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as any[];

  let message: any = null;
  const blocks = new Map<number, any>();
  let completed = false;

  for (const event of events) {
    if (event.type === "error") {
      const status =
        Number.isInteger(event.error?.status) &&
        event.error.status >= 400 &&
        event.error.status <= 599
          ? event.error.status
          : 502;
      throw createApiError(
        event.error?.message ?? "upstream stream error",
        status,
        status !== 502 || event.error?.status === 502
          ? "upstream_responses_error"
          : "upstream_stream_error",
        typeof event.error?.type === "string" ? event.error.type : "api_error",
      );
    }
    if (event.type === "message_start") {
      message = { ...event.message };
      continue;
    }
    if (event.type === "content_block_start") {
      blocks.set(event.index, { ...event.content_block });
      continue;
    }
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!block) continue;
      const delta = event.delta ?? {};
      if (delta.type === "text_delta") {
        block.text = (block.text ?? "") + (delta.text ?? "");
      } else if (delta.type === "thinking_delta") {
        block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
      } else if (delta.type === "signature_delta") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta") {
        block.__partial_json =
          (block.__partial_json ?? "") + (delta.partial_json ?? "");
      }
      continue;
    }
    if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      if (block && typeof block.__partial_json === "string") {
        try {
          block.input = JSON.parse(block.__partial_json || "{}");
        } catch {
          block.__invalid_partial_json = block.__partial_json;
        }
        delete block.__partial_json;
      }
      continue;
    }
    if (event.type === "message_delta") {
      if (message) {
        message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
        message.stop_details =
          event.delta?.stop_details ?? message.stop_details ?? null;
        message.stop_sequence =
          event.delta?.stop_sequence ?? message.stop_sequence ?? null;
        if (event.usage) {
          message.usage = { ...message.usage, ...event.usage };
        }
      }
      continue;
    }
    if (event.type === "message_stop") {
      completed = true;
    }
  }

  if (!message || !completed) {
    throw createApiError(
      "upstream stream ended without a complete message",
      502,
      "upstream_stream_error",
      "api_error",
    );
  }

  message.content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (typeof block.__invalid_partial_json !== "string") return block;
      const raw = block.__invalid_partial_json;
      if (
        message.stop_reason !== "max_tokens" &&
        message.stop_reason !== "refusal"
      ) {
        throw createApiError(
          "upstream tool arguments must be a valid JSON object",
          502,
          "upstream_protocol_error",
          "api_error",
        );
      }
      const bounded = raw.length <= 4096 ? raw : `${raw.slice(0, 4096)}…`;
      return {
        type: "text",
        text: `[incomplete tool_use ${block.name || "unknown"}: ${bounded}]`,
      };
    });
  return message;
}
