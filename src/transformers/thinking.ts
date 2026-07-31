import { ThinkLevel } from "../types/llm.js";

/**
 * Derive a qualitative reasoning effort from an explicit Anthropic
 * `thinking.budget_tokens`.
 *
 * No budget (adaptive thinking) returns undefined so the upstream's own
 * default applies — silently escalating an unspecified budget to "high" both
 * misstates the client's intent and buys unrequested cost/latency. Request
 * validation rejects invalid enabled budgets before this helper is called.
 */
export const getThinkLevel = (
  thinking_budget?: number | null,
): ThinkLevel | undefined => {
  if (
    typeof thinking_budget !== "number" ||
    !Number.isFinite(thinking_budget) ||
    !Number.isInteger(thinking_budget) ||
    thinking_budget < 1024
  ) {
    return undefined;
  }
  if (thinking_budget <= 1024) return "low";
  if (thinking_budget <= 8192) return "medium";
  return "high";
};
