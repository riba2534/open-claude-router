import type { FastifyRequest } from "fastify";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour, generous for long completions

/**
 * Build an AbortSignal that fires when EITHER:
 *   - the request times out, OR
 *   - the client socket is aborted (Ctrl+C in Claude Code) before the reply completes.
 *
 * Note: req.raw 'close' fires on normal completion too. We only abort when
 * `req.raw.aborted === true`, which Node sets when the underlying socket dies
 * mid-response.
 */
export function buildUpstreamSignal(
  req: FastifyRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("upstream timeout")),
    timeoutMs,
  );
  req.raw.once("close", () => {
    clearTimeout(timeout);
    if (req.raw.aborted) {
      controller.abort(new Error("client disconnected"));
    }
  });
  return controller.signal;
}

export interface UpstreamCallOptions {
  url: string;
  authorization: string;
  body: unknown;
  signal: AbortSignal;
}

export async function callUpstream(
  opts: UpstreamCallOptions,
): Promise<Response> {
  return fetch(opts.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: opts.authorization,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
}

export function mapUpstreamStatusToAnthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "api_error";
}

export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export async function buildAnthropicErrorFromUpstream(
  res: Response,
): Promise<{ status: number; body: AnthropicError }> {
  const text = await res.text();
  let message = text || res.statusText;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) message = parsed.error.message;
    else if (parsed?.message) message = parsed.message;
  } catch {
    /* keep raw text */
  }
  return {
    status: res.status,
    body: {
      type: "error",
      error: {
        type: mapUpstreamStatusToAnthropicErrorType(res.status),
        message,
      },
    },
  };
}
