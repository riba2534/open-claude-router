import { decodeChatReasoningSignature } from "./chat-reasoning.js";

export function scrubAnthropicOnlyFields(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    delete record.cache_control;
    if (!Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (part && typeof part === "object") {
        delete (part as Record<string, unknown>).cache_control;
      }
    }
  }
}

export function scrubChatCompletionsIncompatibleFields(
  body: Record<string, unknown>,
): void {
  delete body.reasoning;
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (message && typeof message === "object") {
      delete (message as Record<string, unknown>).output_blocks;
    }
  }
}

export function scrubResponsesReasoningArtifacts(
  body: Record<string, unknown>,
): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    // Signed `thinking` is consumed by the Responses transformer. Only the
    // Chat-Completions extension is incompatible with Responses input.
    delete (message as Record<string, unknown>).reasoning_content;
  }
}

/**
 * Chat Completions formally permits only text in `role:"tool"` messages.
 * Preserve nested Anthropic tool-result images/files by moving them to a
 * standard multimodal user turn after the complete (possibly parallel)
 * tool-result group. Responses can preserve them directly on function output.
 * This also strips the internal file fallback envelope from ordinary user
 * parts, degrading URL-only files because Chat has no formal `file_url` field.
 */
export function normalizeMultimodalToolResultsForChatCompletions(
  body: Record<string, unknown>,
): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  const normalized: any[] = [];
  let pendingSidecars: any[] = [];
  let toolResultOrdinal = 0;

  const normalizeFilePart = (part: any): any => {
    if (
      part?.type === "image_file" &&
      typeof part.image_file?.file_id === "string"
    ) {
      return {
        type: "file",
        file: { file_id: part.image_file.file_id },
      };
    }
    if (part?.type !== "file") return part;
    const file = part.file;
    const fallback =
      typeof part.fallback_text === "string"
        ? part.fallback_text
        : "[unsupported document omitted]";
    if (!file || typeof file !== "object") {
      return { type: "text", text: fallback };
    }

    // Chat Completions supports file_data/file_id, but not a remote file_url.
    // Keep only formal fields and remove the internal fallback envelope.
    if (typeof file.file_data === "string" || typeof file.file_id === "string") {
      return {
        type: "file",
        file: {
          ...(typeof file.file_data === "string"
            ? { file_data: file.file_data }
            : {}),
          ...(typeof file.file_id === "string" ? { file_id: file.file_id } : {}),
          ...(typeof file.filename === "string"
            ? { filename: file.filename }
            : {}),
        },
      };
    }
    return { type: "text", text: fallback };
  };

  const flushSidecars = (next?: any) => {
    if (pendingSidecars.length === 0) return;
    // The provenance marker exists to say which tool result owns which bytes.
    // With a single contributing tool result there is nothing to disambiguate,
    // and the marker measurably degrades how vision models read the image it
    // sits next to — so it is emitted only when the sidecar actually merges
    // several parallel multimodal tool results.
    const parts =
      pendingSidecars.length === 1
        ? pendingSidecars[0].parts
        : pendingSidecars.flatMap((group) => [
            ...group.parts,
            { type: "text", text: group.marker },
          ]);
    if (next?.role === "user") {
      const existing = Array.isArray(next.content)
        ? next.content
        : typeof next.content === "string" && next.content
          ? [{ type: "text", text: next.content }]
          : [];
      next.content = [...parts, ...existing];
    } else {
      normalized.push({ role: "user", content: parts });
    }
    pendingSidecars = [];
  };

  for (const message of messages as any[]) {
    if (Array.isArray(message?.content)) {
      message.content = message.content.map(normalizeFilePart);
    }
    if (message?.role !== "tool") {
      flushSidecars(message);
      normalized.push(message);
      continue;
    }
    toolResultOrdinal += 1;

    if (Array.isArray(message.content)) {
      const textParts = message.content.filter(
        (part: any) => part?.type === "text",
      );
      const multimodalParts = message.content.filter(
        (part: any) => part?.type === "image_url" || part?.type === "file",
      );
      if (multimodalParts.length > 0) {
        const toolCallId =
          typeof message.tool_call_id === "string"
            ? message.tool_call_id
            : undefined;
        const provenance = {
          tool_index: toolResultOrdinal,
          ...(toolCallId !== undefined
            ? {
                // Encode every JavaScript UTF-16 code unit so even a JSON
                // string containing an unpaired surrogate remains exactly
                // reversible. Plain UTF-8 would replace it with U+FFFD.
                tool_call_id_utf16be_base64url:
                  encodeUtf16CodeUnitsBase64Url(toolCallId),
              }
            : {}),
        };
        // Chat Completions only permits text in role:"tool" content, so the
        // bytes move to a user sidecar. Each contributing tool result is kept
        // as its own group with a deterministic provenance marker; flushSidecars
        // decides whether the marker is actually needed. The marker trails its
        // bytes rather than leading them — a machine-readable envelope directly
        // in front of an image measurably degrades how vision models read it.
        pendingSidecars.push({
          parts: multimodalParts,
          marker: `[tool_result multimodal content ${JSON.stringify(provenance)}]`,
        });
      }
      // A tool result that carried nothing but images/files would otherwise be
      // left with an empty string here, which several OpenAI-compatible gateways
      // reject outright ("Invalid value for 'content'"). Point at the sidecar
      // instead so the turn stays well-formed and self-explanatory.
      message.content =
        textParts.length > 0
          ? collapseToolText(textParts)
          : multimodalParts.length > 0
            ? TOOL_RESULT_MOVED_TEXT
            : "";
    } else if (message.content == null) {
      message.content = "";
    }
    normalized.push(message);
  }
  flushSidecars();
  body.messages = normalized;
}

/**
 * Placeholder left in a `role:"tool"` message whose entire payload was images or
 * files. The bytes themselves live in the user sidecar that follows.
 */
const TOOL_RESULT_MOVED_TEXT =
  "[tool_result multimodal content moved to the following user message]";

/**
 * Chat Completions accepts either a string or an array of text parts as tool
 * content, but a plain string is what every implementation agrees on. Collapse
 * the common single-text-part case back to a string — losslessly — and keep the
 * array only when a tool genuinely returned several text blocks.
 */
function collapseToolText(textParts: any[]): any {
  if (
    textParts.length === 1 &&
    textParts[0]?.type === "text" &&
    typeof textParts[0].text === "string"
  ) {
    return textParts[0].text;
  }
  return textParts;
}

function encodeUtf16CodeUnitsBase64Url(value: string): string {
  const bytes = Buffer.allocUnsafe(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    bytes.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return bytes.toString("base64url");
}

/**
 * Convert Anthropic `thinking` blocks on assistant messages to the
 * `reasoning_content` field that DeepSeek/Kimi-style upstreams expect, and
 * always remove the custom `thinking` field (vanilla Chat Completions 400s on
 * unknown keys).
 *
 * AnthropicTransformer only attaches `message.thinking = { content, signature }`
 * when the source turn carries a *signed* thinking block. Reasoning-enabled
 * DeepSeek-compatible upstreams, however, reject ANY assistant message that has
 * tool_calls but no `reasoning_content` ("thinking is enabled but
 * reasoning_content is missing in assistant tool call message at index N").
 * Historical / compacted / redacted turns routinely lack a signed thinking
 * block, so when reasoning is enabled we guarantee the field is present on every
 * tool-call assistant message — carrying over the thinking text when available
 * and falling back to an empty string otherwise.
 */
export function convertThinkingToReasoningContent(
  body: Record<string, unknown>,
  reasoningEnabled: boolean,
): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    // Prefer the full multi-block form (joined — reasoning_content is a single
    // string) and fall back to the single-block field.
    const thinkingBlocks = m.thinking_blocks as
      | Array<{ content?: string; signature?: string }>
      | undefined;
    const joinedThinking = Array.isArray(thinkingBlocks)
      ? thinkingBlocks
          .map((block) =>
            block?.content || decodeChatReasoningSignature(block?.signature)
          )
          .filter(Boolean)
          .join("\n")
      : "";
    const thinking = m.thinking as
      | { content?: string; signature?: string }
      | undefined;
    const singleThinking = thinking?.content ||
      decodeChatReasoningSignature(thinking?.signature);
    if (joinedThinking) {
      m.reasoning_content = joinedThinking;
    } else if (singleThinking) {
      m.reasoning_content = singleThinking;
    }
    delete m.thinking;
    delete m.thinking_blocks;

    if (
      reasoningEnabled &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0 &&
      typeof m.reasoning_content !== "string"
    ) {
      m.reasoning_content = "";
    }
  }
}
