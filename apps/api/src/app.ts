import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import { type Deps, isAppError } from "@ofertas/core";
import Fastify from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { enforceRateLimit, resolveActor } from "./auth";
import { mcpRoutes } from "./mcp/route";
import { linkRoutes } from "./routes/links";
import { offerRoutes } from "./routes/offers";
import { v1Routes } from "./routes/v1";

export type AppOptions = {
  deps: Deps;
  allowSignup: boolean;
  publicUrl: string;
  secureCookies?: boolean;
  logger?: boolean;
};

export async function buildApp(opts: AppOptions) {
  const app = Fastify({
    logger: opts.logger ?? false,
    // API sem estado: ao desligar, encerra conexões keep-alive em vez de esperar os clientes.
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Ofertas API",
        version: "0.1.0",
        description:
          "API da plataforma de ofertas. Autenticação: cookie de sessão (painel) ou 'Authorization: Bearer <token>' (agentes/CLI).",
      },
      servers: [{ url: opts.publicUrl }],
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (req) => {
    req.actor = await resolveActor(opts.deps, req);
    if (req.actor) await enforceRateLimit(opts.deps, req.actor);
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos.",
          hint: "Confira os campos em details.issues.",
          details: {
            issues: err.validation.map((v) => ({
              path: v.instancePath,
              message: v.message,
            })),
          },
        },
      });
    }
    if (isAppError(err)) {
      if (err.code === "LIMIT_EXCEEDED") {
        const retry = err.details?.retry_after_seconds;
        if (typeof retry === "number") reply.header("Retry-After", String(retry));
      }
      return reply.status(err.status).send(err.toJSON());
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({
        error: { code: "VALIDATION_ERROR", message: (err as Error).message },
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
  });

  await app.register(v1Routes, {
    prefix: "/v1",
    deps: opts.deps,
    allowSignup: opts.allowSignup,
    secureCookies: opts.secureCookies ?? false,
  });
  await app.register(linkRoutes, { prefix: "/v1", deps: opts.deps });
  await app.register(offerRoutes, { prefix: "/v1", deps: opts.deps });
  await app.register(mcpRoutes, { deps: opts.deps, publicUrl: opts.publicUrl });

  app.get("/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
