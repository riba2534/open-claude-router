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
 * Preserve nested Anthropic tool-result images by moving them to a standard
 * multimodal user turn after the complete (possibly parallel) tool-result
 * group. Responses can preserve images directly on function output.
 */
export function normalizeMultimodalToolResultsForChatCompletions(
  body: Record<string, unknown>,
): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  const normalized: any[] = [];
  let pendingImages: any[] = [];

  const flushImages = (next?: any) => {
    if (pendingImages.length === 0) return;
    if (next?.role === "user") {
      const existing = Array.isArray(next.content)
        ? next.content
        : typeof next.content === "string" && next.content
          ? [{ type: "text", text: next.content }]
          : [];
      next.content = [...pendingImages, ...existing];
    } else {
      normalized.push({ role: "user", content: pendingImages });
    }
    pendingImages = [];
  };

  for (const message of messages as any[]) {
    if (message?.role !== "tool") {
      flushImages(message);
      normalized.push(message);
      continue;
    }

    if (Array.isArray(message.content)) {
      const textParts = message.content.filter(
        (part: any) => part?.type === "text",
      );
      pendingImages.push(
        ...message.content.filter((part: any) => part?.type === "image_url"),
      );
      message.content = textParts.length > 0 ? textParts : "";
    } else if (message.content == null) {
      message.content = "";
    }
    normalized.push(message);
  }
  flushImages();
  body.messages = normalized;
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

    const thinking = m.thinking as { content?: string } | undefined;
    if (thinking?.content) {
      m.reasoning_content = thinking.content;
    }
    delete m.thinking;

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
