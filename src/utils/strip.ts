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

const ANTHROPIC_ONLY = new Set([
  "cache_control",
  // Some OpenAI-compatible gateways accept a top-level `reasoning` field, but
  // vanilla /chat/completions rejects it as unknown. Stripping is the safe default.
  "reasoning",
]);

export function scrubAnthropicOnlyFields(body: Record<string, unknown>): void {
  stripFields(body, ANTHROPIC_ONLY);
}
