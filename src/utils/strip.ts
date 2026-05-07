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

export function scrubAnthropicOnlyFields(body: Record<string, unknown>): void {
  stripFields(body, ALWAYS_STRIP);
}

export function scrubChatCompletionsIncompatibleFields(
  body: Record<string, unknown>,
): void {
  stripFields(body, CHAT_COMPLETIONS_REJECT);
}
