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

function inferStatusFromOpenAIErrorCode(code: string): number | undefined {
  if (!code) return undefined;
  if (code === "overloaded" || code === "overloaded_error") return 529;
  if (code.includes("rate_limit") || code.includes("quota")) return 429;
  if (code.includes("billing")) return 402;
  if (
    code.includes("authentication") ||
    code.includes("invalid_api_key") ||
    code === "unauthorized"
  ) {
    return 401;
  }
  if (code.includes("permission") || code === "forbidden") return 403;
  if (code.includes("not_found")) return 404;
  if (code.includes("conflict")) return 409;
  if (code.includes("request_too_large")) return 413;
  if (code.includes("timeout")) return 504;
  if (code === "server_error" || code.includes("internal_error")) return 500;
  if (
    code.includes("invalid_request") ||
    code.includes("unsupported") ||
    code.includes("invalid_value") ||
    code.startsWith("invalid_") ||
    code.startsWith("empty_") ||
    code.startsWith("failed_to_") ||
    code === "bad_request"
  ) {
    return 400;
  }
  return undefined;
}

/**
 * Give an OpenAI-shaped error object an Anthropic status and error type.
 *
 * OpenAI-compatible gateways routinely answer HTTP 200 with an `error` object
 * in the body instead of a real status code. Reporting that as a blanket 500
 * throws away what the upstream actually said — a rate limit becomes
 * indistinguishable from a broken gateway — so the error's own `type`/`code`
 * decides the status when the transport did not.
 *
 * `httpStatus` wins whenever the upstream did use a real error status.
 */
export function mapOpenAIErrorToAnthropic(
  error: any,
  httpStatus: number,
): { status: number; type: string } {
  const detailCode =
    typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const typeCode =
    typeof error?.type === "string" ? error.type.toLowerCase() : "";

  let status = httpStatus >= 400 ? httpStatus : 0;
  if (!status) {
    // OpenAI `type` is often generic while `code` carries the actionable cause
    // (for example type=invalid_request_error + code=invalid_api_key). Prefer
    // that specific code, but fall back to type when code is absent/unknown.
    status =
      inferStatusFromOpenAIErrorCode(detailCode) ??
      inferStatusFromOpenAIErrorCode(typeCode) ??
      // An unclassifiable error inside a 2xx means the upstream broke its own
      // contract; 502 says that without pretending the router failed.
      502;
  }

  // Normalize from the final status so a generic OpenAI type cannot contradict
  // a more specific code (401 must be authentication_error, not the shared but
  // semantically different string invalid_request_error).
  const type = mapUpstreamStatusToAnthropicErrorType(status);

  return { status, type };
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
        // An edge proxy or WAF in front of the upstream answers with a full
        // HTML page rather than a JSON error. That whole document would
        // otherwise be inlined verbatim into the message the client renders.
        message: boundUpstreamErrorMessage(message, res.status),
      },
    },
  };
}

/** Upper bound on upstream error text echoed back to the client. */
const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 4096;

function boundUpstreamErrorMessage(message: string, status: number): string {
  if (message.length <= MAX_UPSTREAM_ERROR_MESSAGE_CHARS) return message;
  return (
    `${message.slice(0, MAX_UPSTREAM_ERROR_MESSAGE_CHARS)}` +
    ` […upstream HTTP ${status} body truncated, ${message.length} chars total]`
  );
}
