import { encodingForModel, type Tiktoken } from "js-tiktoken";

let _enc: Tiktoken | null = null;
function enc(): Tiktoken {
  if (!_enc) _enc = encodingForModel("gpt-4o");
  return _enc;
}

function count(s: string): number {
  if (!s) return 0;
  try {
    return enc().encode(s).length;
  } catch {
    return Math.ceil(s.length / 4); // very rough fallback
  }
}

interface AnthropicCountRequest {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Array<{
    role: string;
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          input?: unknown;
          content?: unknown;
        }>;
  }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
  }>;
}

export function countAnthropicTokens(req: AnthropicCountRequest): number {
  let total = 0;

  if (typeof req.system === "string") {
    total += count(req.system);
  } else if (Array.isArray(req.system)) {
    for (const part of req.system) {
      if (part?.type === "text" && part.text) total += count(part.text);
    }
  }

  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      total += count(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && part.text) {
          total += count(part.text);
        } else if (part?.type === "tool_use" && part.input !== undefined) {
          total += count(JSON.stringify(part.input));
        } else if (part?.type === "tool_result") {
          if (typeof part.content === "string") {
            total += count(part.content);
          } else if (part.content !== undefined) {
            total += count(JSON.stringify(part.content));
          }
        } else if (part?.type === "image") {
          total += 256; // image placeholder budget
        }
      }
    }
    total += 4; // per-message overhead (tag/role)
  }

  for (const tool of req.tools ?? []) {
    total += count(tool.name);
    if (tool.description) total += count(tool.description);
    if (tool.input_schema !== undefined) {
      total += count(JSON.stringify(tool.input_schema));
    }
  }

  return total;
}
