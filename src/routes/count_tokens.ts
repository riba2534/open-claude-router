import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkServiceAuth, parseAccessTokens } from "../utils/auth.js";
import { countAnthropicTokens } from "../utils/tokenizer.js";
import { createApiError } from "../transformers/errors.js";

export async function registerCountTokensRoute(fastify: FastifyInstance) {
  const accessTokens = parseAccessTokens(process.env.OCR_ACCESS_TOKENS);

  fastify.post(
    "/v1/messages/count_tokens",
    async (req: FastifyRequest, reply: FastifyReply) => {
      checkServiceAuth(req, accessTokens);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw createApiError(
          "request body must be a JSON object",
          400,
          "invalid_body",
          "invalid_request_error",
        );
      }
      const input_tokens = countAnthropicTokens(body as any);
      reply.code(200);
      return { input_tokens };
    },
  );
}
