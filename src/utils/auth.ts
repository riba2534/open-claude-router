import type { FastifyRequest } from "fastify";
import { createApiError } from "../transformers/errors.js";

export interface UpstreamConfig {
  url: string;
  authorization: string;
  model?: string;
}

export type UpstreamFormat = "chat-completions" | "responses";

/**
 * Parse the optional `X-Upstream-Format` header. Default `chat-completions`
 * (current behaviour for all existing aliases). `responses` opts in to the
 * OpenAI Responses API protocol path. Unknown values reject with 400.
 */
export function parseUpstreamFormat(req: FastifyRequest): UpstreamFormat {
  const v = req.headers["x-upstream-format"];
  const raw = (Array.isArray(v) ? v[0] : v ?? "").trim().toLowerCase();
  if (raw === "" || raw === "chat-completions") return "chat-completions";
  if (raw === "responses") return "responses";
  throw createApiError(
    `unknown X-Upstream-Format value: ${raw} (expected 'chat-completions' or 'responses')`,
    400,
    "invalid_upstream_format",
    "invalid_request_error",
  );
}

export function parseReasoningSummary(
  req: FastifyRequest,
): string | false | undefined {
  const v = req.headers["x-upstream-reasoning-summary"];
  const raw = (Array.isArray(v) ? v[0] : v)?.trim();
  if (raw === undefined || raw === "") return undefined;

  const normalized = raw.toLowerCase();
  if (
    normalized === "none" ||
    normalized === "off" ||
    normalized === "false" ||
    normalized === "0" ||
    normalized === "disabled"
  ) {
    return false;
  }
  if (HEADER_INJECTION_RE.test(raw) || HEADER_VALUE_INVALID_RE.test(raw)) {
    throw createApiError(
      "X-Upstream-Reasoning-Summary contains invalid characters",
      400,
      "invalid_reasoning_summary",
      "invalid_request_error",
    );
  }
  return raw;
}

export function parseAccessTokens(env: string | undefined): Set<string> {
  if (!env) return new Set();
  return new Set(
    env
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

export function checkServiceAuth(
  req: FastifyRequest,
  allowed: Set<string>,
): void {
  if (allowed.size === 0) return; // disabled

  const raw = req.headers["authorization"];
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith("bearer ")) {
    throw createApiError(
      "missing or malformed Authorization header",
      401,
      "unauthorized",
      "authentication_error",
    );
  }
  const token = raw.slice(7).trim();
  if (!allowed.has(token)) {
    throw createApiError(
      "invalid access token",
      401,
      "unauthorized",
      "authentication_error",
    );
  }
}

/**
 * Service-side access-token check for embedded-path mode. The standard
 * `Authorization` header is consumed as the upstream credential in this mode,
 * so we read the service-side token from `X-OCR-Token` instead.
 *
 * No-op when the whitelist is empty (i.e. `OCR_ACCESS_TOKENS` unset).
 */
export function checkServiceAuthFromOcrTokenHeader(
  req: FastifyRequest,
  allowed: Set<string>,
): void {
  if (allowed.size === 0) return;

  const v = req.headers["x-ocr-token"];
  const token = Array.isArray(v) ? v[0] : v;
  if (!token || !allowed.has(token.trim())) {
    throw createApiError(
      "missing or invalid X-OCR-Token header " +
        "(required in embedded-path mode when OCR_ACCESS_TOKENS is enabled)",
      401,
      "unauthorized",
      "authentication_error",
    );
  }
}

const HEADER_INJECTION_RE = /[\r\n]/;
// Reject C0 control characters (except TAB, 0x09) and DEL in header values.
// CR/LF are already rejected elsewhere; this also catches NUL and other CTLs
// that undici rejects, so clients get a 400 instead of a later upstream fetch
// failure.
const HEADER_VALUE_INVALID_RE = /[\x00-\x08\x0A-\x1F\x7F]/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PROTECTED_UPSTREAM_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-ocr-token",
]);

function readHeader(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

export function parseUpstreamHeaders(
  req: FastifyRequest,
): Record<string, string> | undefined {
  const raw = readHeader(req, "x-upstream-headers");
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw createApiError(
      "X-Upstream-Headers must be a non-empty JSON object",
      400,
      "invalid_upstream_headers",
      "invalid_request_error",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createApiError(
      "X-Upstream-Headers must be a JSON object",
      400,
      "invalid_upstream_headers",
      "invalid_request_error",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createApiError(
      "X-Upstream-Headers must be a JSON object",
      400,
      "invalid_upstream_headers",
      "invalid_request_error",
    );
  }

  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(parsed)) {
    const normalizedName = name.toLowerCase();
    if (
      !HEADER_NAME_RE.test(name) ||
      PROTOTYPE_POLLUTION_KEYS.has(normalizedName)
    ) {
      throw createApiError(
        `invalid upstream header name: ${name}`,
        400,
        "invalid_upstream_header",
        "invalid_request_error",
      );
    }
    if (
      PROTECTED_UPSTREAM_HEADERS.has(normalizedName) ||
      normalizedName.startsWith("x-upstream-")
    ) {
      throw createApiError(
        `protected upstream header cannot be overridden: ${normalizedName}`,
        400,
        "protected_upstream_header",
        "invalid_request_error",
      );
    }
    if (typeof value !== "string" || HEADER_VALUE_INVALID_RE.test(value)) {
      throw createApiError(
        `invalid value for upstream header: ${name}`,
        400,
        "invalid_upstream_header",
        "invalid_request_error",
      );
    }
    headers[normalizedName] = value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/**
 * Returns true iff the request path embeds the upstream URL directly, e.g.:
 *     /https://upstream.example.com/path/v1/messages
 *     /http://...
 * (NOT to be confused with the standard /v1/messages route.)
 */
export function isEmbeddedUpstreamPath(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0];
  return path.startsWith("/https://") || path.startsWith("/http://");
}

/**
 * Parse upstream from an embedded-URL path, e.g.:
 *     /https://upstream.example.com/foo/bar/v1/messages
 *     /https://upstream.example.com/foo/bar/v1/messages/count_tokens
 *
 * The upstream URL is everything between the leading `/` and the trailing
 * `/v1/messages` (or `/v1/messages/count_tokens`). Upstream Authorization
 * comes from the standard `Authorization: Bearer ...` header — the Bearer
 * prefix is stripped and the remainder forwarded verbatim, so non-Bearer
 * upstream auth schemes can pass through.
 */
export function parseUpstreamFromEmbeddedPath(req: FastifyRequest): {
  upstream: UpstreamConfig;
  endpoint: "messages" | "count_tokens";
} {
  const rawUrl = req.url.split("?")[0];

  if (!isEmbeddedUpstreamPath(rawUrl)) {
    throw createApiError(
      `expected /http(s):// embedded prefix, got ${rawUrl}`,
      400,
      "invalid_path",
      "invalid_request_error",
    );
  }

  let pathPart = rawUrl.slice(1); // drop leading "/"

  const COUNT_SUFFIX = "/v1/messages/count_tokens";
  const MSG_SUFFIX = "/v1/messages";
  let endpoint: "messages" | "count_tokens";
  if (pathPart.endsWith(COUNT_SUFFIX)) {
    endpoint = "count_tokens";
    pathPart = pathPart.slice(0, -COUNT_SUFFIX.length);
  } else if (pathPart.endsWith(MSG_SUFFIX)) {
    endpoint = "messages";
    pathPart = pathPart.slice(0, -MSG_SUFFIX.length);
  } else {
    throw createApiError(
      `unrecognized path: ${rawUrl} (expected suffix ${MSG_SUFFIX} or ${COUNT_SUFFIX})`,
      404,
      "unknown_path",
      "not_found_error",
    );
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(pathPart);
    if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
      throw new Error("non-http protocol");
    }
  } catch {
    throw createApiError(
      `embedded upstream URL is not a valid http(s) URL: ${pathPart}`,
      400,
      "invalid_upstream_url",
      "invalid_request_error",
    );
  }

  // Authorization: Bearer <upstream auth value>
  const raw = req.headers["authorization"];
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith("bearer ")) {
    throw createApiError(
      "embedded-path mode requires Authorization: Bearer <upstream-auth-value>",
      401,
      "missing_upstream_auth",
      "authentication_error",
    );
  }
  const upstreamAuth = raw.slice(7).trim();
  if (!upstreamAuth) {
    throw createApiError(
      "Authorization Bearer token is empty",
      401,
      "missing_upstream_auth",
      "authentication_error",
    );
  }
  if (HEADER_INJECTION_RE.test(upstreamAuth)) {
    throw createApiError(
      "Authorization value contains CR/LF",
      400,
      "invalid_upstream_header",
      "invalid_request_error",
    );
  }

  return {
    upstream: {
      url: pathPart,
      authorization: upstreamAuth,
      model: readHeader(req, "x-upstream-model") || undefined,
    },
    endpoint,
  };
}

/**
 * Parse `X-Upstream-Model-Map` into Map<clientModel, upstreamModel>.
 * Format: `claude-opus-4-6=gpt-5.5,claude-sonnet-4-6=gpt-5.4`.
 */
export function parseModelMap(req: FastifyRequest): Map<string, string> {
  const raw = readHeader(req, "x-upstream-model-map");
  if (raw === undefined || raw.trim() === "") return new Map();

  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (!trimmed || eq <= 0 || eq === trimmed.length - 1) {
      throw createApiError(
        "X-Upstream-Model-Map contains an invalid mapping " +
          "(expected format: model-a=upstream-a,model-b=upstream-b)",
        400,
        "invalid_model_map",
        "invalid_request_error",
      );
    }
    const from = trimmed.slice(0, eq).trim();
    const to = trimmed.slice(eq + 1).trim();
    if (!from || !to || HEADER_VALUE_INVALID_RE.test(from + to)) {
      throw createApiError(
        "X-Upstream-Model-Map contains an invalid mapping " +
          "(expected format: model-a=upstream-a,model-b=upstream-b)",
        400,
        "invalid_model_map",
        "invalid_request_error",
      );
    }
    map.set(from, to);
  }
  return map;
}

/**
 * Resolve upstream model override. Undefined means "do not override"; the
 * transformed request keeps its original body model.
 */
export function resolveUpstreamModel(
  bodyModel: string | undefined,
  upstreamModel: string | undefined,
  modelMap: Map<string, string>,
): string | undefined {
  const mapped = bodyModel ? modelMap.get(bodyModel) : undefined;
  return mapped ?? upstreamModel;
}

export function parseUpstreamConfig(req: FastifyRequest): UpstreamConfig {
  const url = readHeader(req, "x-upstream-url");
  const auth = readHeader(req, "x-upstream-authorization");
  const model = readHeader(req, "x-upstream-model");

  if (!url) {
    throw createApiError(
      "missing X-Upstream-Url header",
      400,
      "missing_upstream_url",
      "invalid_request_error",
    );
  }
  if (!auth) {
    throw createApiError(
      "missing X-Upstream-Authorization header",
      400,
      "missing_upstream_auth",
      "invalid_request_error",
    );
  }
  if (HEADER_INJECTION_RE.test(url) || HEADER_INJECTION_RE.test(auth)) {
    throw createApiError(
      "upstream header value contains CR/LF",
      400,
      "invalid_upstream_header",
      "invalid_request_error",
    );
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("non-http protocol");
    }
  } catch {
    throw createApiError(
      `X-Upstream-Url is not a valid http(s) URL: ${url}`,
      400,
      "invalid_upstream_url",
      "invalid_request_error",
    );
  }
  return { url, authorization: auth, model: model || undefined };
}
