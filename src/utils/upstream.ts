import type { FastifyReply, FastifyRequest } from "fastify";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour, generous for long completions

/**
 * Build an AbortSignal that fires when EITHER:
 *   - the request times out, OR
 *   - the client socket is aborted (Ctrl+C in Claude Code) before the reply completes.
 *
 * IncomingMessage `close` is not a response-lifecycle signal: for a normal
 * POST it fires once the request body has been consumed, long before the model
 * finishes. Use request `aborted` for an interrupted upload and the outgoing
 * response's `close`/`finish` events for disconnect and cleanup instead.
 */
export function buildUpstreamSignal(
  req: FastifyRequest,
  reply: FastifyReply,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): AbortSignal {
  const controller = new AbortController();
  let cleanedUp = false;

  const onRequestAborted = () => abort("client disconnected");
  const onReplyClose = () => {
    if (!reply.raw.writableFinished) {
      abort("client disconnected");
    } else {
      cleanup();
    }
  };
  const onReplyFinish = () => cleanup();

  const timeout = setTimeout(
    () => abort("upstream timeout"),
    timeoutMs,
  );
  timeout.unref();

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    req.raw.removeListener("aborted", onRequestAborted);
    reply.raw.removeListener("close", onReplyClose);
    reply.raw.removeListener("finish", onReplyFinish);
  }

  function abort(message: string): void {
    if (!controller.signal.aborted) {
      controller.abort(new Error(message));
    }
    cleanup();
  }

  req.raw.once("aborted", onRequestAborted);
  reply.raw.once("close", onReplyClose);
  reply.raw.once("finish", onReplyFinish);

  // Cover a socket that disappeared immediately before listeners were armed.
  if (req.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) {
    abort("client disconnected");
  }
  return controller.signal;
}

export interface UpstreamCallOptions {
  url: string;
  authorization: string;
  body: unknown;
  signal: AbortSignal;
  headers?: Record<string, string>;
}

export async function callUpstream(
  opts: UpstreamCallOptions,
): Promise<Response> {
  return fetch(opts.url, {
    method: "POST",
    // A redirect response is still an upstream non-2xx response. Following it
    // here would make the stateless Router issue a second HTTP request, hide
    // the original status, and bypass the caller-owned retry policy.
    redirect: "manual",
    headers: {
      ...opts.headers,
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
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return "timeout_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "api_error";
}

export interface AnthropicError {
  type: "error";
  request_id: string | null;
  error: {
    type: string;
    message: string;
  };
}

export async function buildAnthropicErrorFromUpstream(
  res: Response,
): Promise<{ status: number; body: AnthropicError }> {
  let text = "";
  let requestId: string | null = null;
  let message =
    res.statusText || `upstream returned HTTP ${res.status}`;
  try {
    text = await res.text();
    if (text) message = text;
  } catch {
    // The status and retryability are already known even when a truncated
    // error body cannot be consumed. Keep the original status instead of
    // turning this into an unrelated local 500.
    message = `upstream returned HTTP ${res.status}; response body could not be read`;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error?.message === "string" && parsed.error.message) {
      message = parsed.error.message;
    } else if (typeof parsed?.message === "string" && parsed.message) {
      message = parsed.message;
    }
    requestId =
      typeof parsed?.request_id === "string" ? parsed.request_id : null;
  } catch {
    /* keep raw text */
  }
  return {
    status: res.status,
    body: {
      type: "error",
      request_id: requestId,
      error: {
        type: mapUpstreamStatusToAnthropicErrorType(res.status),
        message,
      },
    },
  };
}
