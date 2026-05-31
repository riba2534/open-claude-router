/**
 * Recursively delete fields from an object tree. Used to scrub Anthropic-only
 * fields (cache_control, reasoning) before forwarding to OpenAI-compatible
 * upstreams that 400 on unknown keys.
 */
export function stripFields(obj: unknown, fields: ReadonlySet<string>): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripFields(item, fields);
    return;
  }
  const o = obj as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (fields.has(key)) {
      delete o[key];
    } else {
      stripFields(o[key], fields);
    }
  }
}

// Always rejected by OpenAI-shape upstreams (both Chat Completions and Responses).
const ALWAYS_STRIP = new Set(["cache_control"]);

// `reasoning` is emitted by AnthropicTransformer from `request.thinking` and
// consumed by OpenAIResponsesTransformer.transformRequestIn — strip only on
// the Chat Completions path, where vanilla upstreams 400 on unknown keys.
const CHAT_COMPLETIONS_REJECT = new Set(["reasoning"]);

// `thinking` / `reasoning_content` are Chat-Completions-only artifacts (the
// former synthesized by AnthropicTransformer, the latter by
// convertThinkingToReasoningContent). The Responses API carries reasoning via
// the top-level `reasoning` param, so these per-message fields must never leak
// into its `input` array.
const RESPONSES_REASONING_ARTIFACTS = new Set([
  "thinking",
  "reasoning_content",
]);

export function scrubAnthropicOnlyFields(body: Record<string, unknown>): void {
  stripFields(body, ALWAYS_STRIP);
}

export function scrubChatCompletionsIncompatibleFields(
  body: Record<string, unknown>,
): void {
  stripFields(body, CHAT_COMPLETIONS_REJECT);
}

export function scrubResponsesReasoningArtifacts(
  body: Record<string, unknown>,
): void {
  stripFields(body, RESPONSES_REASONING_ARTIFACTS);
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
