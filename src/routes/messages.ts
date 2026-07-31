import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AnthropicTransformer } from "../transformers/anthropic.js";
import { OpenAIResponsesTransformer } from "../transformers/responses.js";
import { createApiError } from "../transformers/errors.js";
import {
  checkServiceAuth,
  checkServiceAuthFromOcrTokenHeader,
  isEmbeddedUpstreamPath,
  parseModelMap,
  parseUpstreamConfig,
  parseUpstreamHeaders,
  parseUpstreamFromEmbeddedPath,
  parseUpstreamFormat,
  parseAccessTokens,
  resolveUpstreamModel,
  type UpstreamConfig,
  type UpstreamFormat,
} from "../utils/auth.js";
import {
  scrubAnthropicOnlyFields,
  scrubChatCompletionsIncompatibleFields,
  scrubResponsesReasoningArtifacts,
  convertThinkingToReasoningContent,
  normalizeMultimodalToolResultsForChatCompletions,
} from "../utils/strip.js";
import {
  buildUpstreamSignal,
  callUpstream,
  buildAnthropicErrorFromUpstream,
} from "../utils/upstream.js";
import { countAnthropicTokens } from "../utils/tokenizer.js";

interface MessagesBody {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

async function forwardMessages(
  req: FastifyRequest<{ Body: MessagesBody }>,
  reply: FastifyReply,
  anthropicT: AnthropicTransformer,
  responsesT: OpenAIResponsesTransformer,
  format: UpstreamFormat,
  upstream: UpstreamConfig,
) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createApiError(
      "request body must be a JSON object",
      400,
      "invalid_body",
      "invalid_request_error",
    );
  }
  const wantsStream = body.stream === true;

  // Step 1: Anthropic body -> unified (== OpenAI Chat Completions shape)
  const unified = await anthropicT.transformRequestOut!(body);
  if (upstream.model) {
    unified.model = upstream.model;
  }
  scrubAnthropicOnlyFields(unified as unknown as Record<string, unknown>);

  // `reasoning.enabled` reflects the client's `thinking: { type: "enabled" }`.
  // Capture it before the `reasoning` field is stripped on the chat path below.
  const reasoningEnabled = !!(unified as any).reasoning?.enabled;

  // Step 2: unified -> upstream-specific shape (only needed for Responses API).
  // For chat-completions, unified IS already the OpenAI Chat Completions format,
  // so we send it directly.
  let outboundBody: any = unified;
  if (format === "responses") {
    // Drop the chat-completions-only `thinking` / `reasoning_content` artifacts
    // so they don't leak into the Responses `input`; reasoning is conveyed via
    // the top-level `reasoning` param (consumed by transformRequestIn) instead.
    scrubResponsesReasoningArtifacts(
      unified as unknown as Record<string, unknown>,
    );
    outboundBody = await responsesT.transformRequestIn!(unified as any);
  } else {
    // DeepSeek/Kimi-style upstreams require `reasoning_content` on assistant
    // tool-call messages when thinking is enabled; this also strips the custom
    // `thinking` field. The top-level `reasoning` field is then removed (vanilla
    // /chat/completions 400s on unknown keys).
    convertThinkingToReasoningContent(
      unified as unknown as Record<string, unknown>,
      reasoningEnabled,
    );
    normalizeMultimodalToolResultsForChatCompletions(
      unified as unknown as Record<string, unknown>,
    );
    scrubChatCompletionsIncompatibleFields(
      unified as unknown as Record<string, unknown>,
    );
    // 注入 stream_options 让上游在流式响应末尾返回 usage
    if (wantsStream) {
      (unified as any).stream_options = { include_usage: true };
    }
  }

  req.log.info(
    {
      model: unified.model,
      stream: wantsStream,
      upstream: upstream.url,
      format,
    },
    "forwarding",
  );

  // Step 3: fetch upstream
  // Keep request validation outside the fetch try/catch so bad alias headers
  // return 400 instead of being rewritten as upstream_unreachable/502.
  const upstreamHeaders = parseUpstreamHeaders(req);
  const signal = buildUpstreamSignal(req);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await callUpstream({
      url: upstream.url,
      authorization: upstream.authorization,
      headers: upstreamHeaders,
      body: outboundBody,
      signal,
    });
  } catch (err: any) {
    const isAbort =
      err?.name === "AbortError" ||
      /aborted|disconnected|timeout/i.test(err?.message ?? "");
    throw createApiError(
      `upstream fetch failed: ${err?.message ?? String(err)}`,
      isAbort ? 499 : 502,
      isAbort ? "client_disconnected" : "upstream_unreachable",
      isAbort ? "request_canceled" : "api_error",
    );
  }

  if (!upstreamResponse.ok) {
    const { status, body: errBody } =
      await buildAnthropicErrorFromUpstream(upstreamResponse);
    // Preserve the upstream status/body, but explicitly let Claude Code apply
    // its own bounded retry policy to every upstream HTTP error. The router
    // remains single-attempt and stateless, so retries have exactly one owner.
    reply.header("x-should-retry", "true");
    reply.code(status);
    return errBody;
  }

  // Step 4: upstream response -> unified (only needed for Responses API).
  let upstreamForAnthropic = upstreamResponse;
  if (format === "responses") {
    upstreamForAnthropic = await responsesT.transformResponseOut!(
      upstreamResponse,
    );
  }

  // Step 5: unified -> Anthropic SSE / JSON
  const finalResponse = await anthropicT.transformResponseIn!(
    upstreamForAnthropic,
    { req },
  );

  reply.code(finalResponse.status);
  finalResponse.headers.forEach((v, k) => {
    if (
      k === "transfer-encoding" ||
      k === "content-length" ||
      k === "connection"
    )
      return;
    reply.header(k, v);
  });

  if (wantsStream) {
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    return reply.send(finalResponse.body);
  }
  return await finalResponse.json();
}

function handleCountTokens(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createApiError(
      "request body must be a JSON object",
      400,
      "invalid_body",
      "invalid_request_error",
    );
  }
  reply.code(200);
  return { input_tokens: countAnthropicTokens(body as any) };
}

export async function registerMessagesRoute(fastify: FastifyInstance) {
  const accessTokens = parseAccessTokens(process.env.OCR_ACCESS_TOKENS);
  if (accessTokens.size > 0) {
    fastify.log.info(
      { count: accessTokens.size },
      "service access token whitelist enabled " +
        "(header mode: Authorization Bearer; embedded-path mode: X-OCR-Token)",
    );
  } else {
    fastify.log.warn(
      "service access token whitelist disabled — anyone with the URL can use this proxy",
    );
  }

  // Anthropic transformer: client-side direction (Anthropic <-> unified).
  // Always involved.
  const anthropicTransformer = new AnthropicTransformer({});
  anthropicTransformer.logger = fastify.log;

  // Responses transformer: upstream-side direction (unified <-> OpenAI Responses).
  // Engaged only when X-Upstream-Format: responses.
  const responsesTransformer = new OpenAIResponsesTransformer();
  responsesTransformer.logger = fastify.log;

  // Header mode: explicit X-Upstream-* headers; service token whitelist applies.
  fastify.post(
    "/v1/messages",
    async (
      req: FastifyRequest<{ Body: MessagesBody }>,
      reply: FastifyReply,
    ) => {
      checkServiceAuth(req, accessTokens);
      const format = parseUpstreamFormat(req);
      const upstream = parseUpstreamConfig(req);
      upstream.model = resolveUpstreamModel(
        req.body?.model,
        upstream.model,
        parseModelMap(req),
      );
      return forwardMessages(
        req,
        reply,
        anthropicTransformer,
        responsesTransformer,
        format,
        upstream,
      );
    },
  );

  // Embedded-path mode:
  //     ANTHROPIC_BASE_URL=http://host:port/https://upstream.example.com/path/to/chat/completions
  // Claude Code appends /v1/messages, the bridge strips that suffix and the
  // leading "/", treats the rest as the upstream URL, and forwards.
  // Authorization: Bearer <upstream-auth-value>  (Bearer prefix stripped, value
  // forwarded verbatim — supports non-Bearer upstream auth schemes).
  // NOTE: Authorization is the upstream credential in this mode, so the
  // service-side access-token check reads `X-OCR-Token` instead.
  // Use a catch-all POST route so we go through the standard request lifecycle
  // (setNotFoundHandler doesn't play well with streamed Web ReadableStream
  // responses). Static routes above take precedence over wildcard.
  fastify.post(
    "/*",
    async (
      req: FastifyRequest<{ Body: MessagesBody }>,
      reply: FastifyReply,
    ) => {
      if (!isEmbeddedUpstreamPath(req.url)) {
        throw createApiError(
          `unknown path: ${req.url.split("?")[0]}`,
          404,
          "not_found",
          "not_found_error",
        );
      }
      checkServiceAuthFromOcrTokenHeader(req, accessTokens);
      const format = parseUpstreamFormat(req);
      const { upstream, endpoint } = parseUpstreamFromEmbeddedPath(req);
      if (endpoint === "count_tokens") {
        return handleCountTokens(req, reply);
      }
      upstream.model = resolveUpstreamModel(
        req.body?.model,
        upstream.model,
        parseModelMap(req),
      );
      return forwardMessages(
        req,
        reply,
        anthropicTransformer,
        responsesTransformer,
        format,
        upstream,
      );
    },
  );
}
