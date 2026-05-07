import Fastify from "fastify";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerCountTokensRoute } from "./routes/count_tokens.js";
import type { ApiError } from "./transformers/errors.js";

const PORT = Number(process.env.PORT ?? 3457);
const HOST = process.env.HOST ?? "0.0.0.0";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        'req.headers["x-upstream-authorization"]',
        'req.headers["x-api-key"]',
      ],
      censor: "[REDACTED]",
    },
  },
  bodyLimit: 32 * 1024 * 1024, // 32 MB — Claude Code can send fat prompts with many tools
  trustProxy: true,
});

fastify.setErrorHandler((error, req, reply) => {
  const apiErr = error as ApiError;
  const status = apiErr.statusCode ?? 500;
  const type = apiErr.type ?? "api_error";
  const code = apiErr.code ?? "internal_error";

  const message = (error as Error)?.message ?? "internal error";

  if (status >= 500) {
    req.log.error({ err: error }, "request failed");
  } else {
    req.log.warn({ msg: message, code, type }, "request rejected");
  }

  reply.code(status).send({
    type: "error",
    error: {
      type,
      message,
    },
  });
});

fastify.get("/healthz", async () => ({ status: "ok" }));
fastify.get("/", async () => ({
  name: "open-claude-router",
  description:
    "stateless Anthropic <-> OpenAI bridge — pass X-Upstream-Url + X-Upstream-Authorization (+ X-Upstream-Model) headers per request",
}));

await registerMessagesRoute(fastify);
await registerCountTokensRoute(fastify);

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  fastify.log.info({ signal }, "shutting down");
  try {
    await fastify.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
