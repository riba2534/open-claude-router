const CHAT_REASONING_SIGNATURE_PREFIX = "ocr-chat-reasoning-v1:";
const RESPONSES_REASONING_SIGNATURE_PREFIX = "ocr-responses-reasoning-v1:";

export function isRouterOwnedReasoningSignature(
  signature: unknown,
): signature is string {
  return typeof signature === "string" && (
    signature.startsWith(CHAT_REASONING_SIGNATURE_PREFIX) ||
    signature.startsWith(RESPONSES_REASONING_SIGNATURE_PREFIX)
  );
}

/**
 * Chat Completions reasoning_content has no encrypted replay token. Wrap its
 * exact bytes in a Router-owned opaque signature so Anthropic
 * thinking.display:"omitted" can remain stateless and reversible across the
 * tool round trip. Clients must treat this value as opaque, just like a native
 * Anthropic signature.
 */
export function encodeChatReasoningSignature(content: string): string {
  return CHAT_REASONING_SIGNATURE_PREFIX + Buffer.from(
    JSON.stringify({ reasoning_content: content }),
    "utf8",
  ).toString("base64url");
}

export function decodeChatReasoningSignature(
  signature: unknown,
): string | undefined {
  if (
    typeof signature !== "string" ||
    !signature.startsWith(CHAT_REASONING_SIGNATURE_PREFIX)
  ) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(
        signature.slice(CHAT_REASONING_SIGNATURE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    );
    return typeof decoded?.reasoning_content === "string"
      ? decoded.reasoning_content
      : undefined;
  } catch {
    return undefined;
  }
}
