import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Deps } from "@ofertas/core";
import type { FastifyInstance } from "fastify";
import { requireActor } from "../auth";
import { createMcpServer } from "./server";

/**
 * MCP via Streamable HTTP, sem estado (cada POST é independente).
 * Autenticação: Authorization: Bearer <token de agente>.
 */
export async function mcpRoutes(app: FastifyInstance, opts: { deps: Deps; publicUrl: string }) {
  app.post("/mcp", async (req, reply) => {
    if (req.actor?.type !== "token") {
      reply.header("WWW-Authenticate", `Bearer realm="${opts.publicUrl}/mcp"`);
    }
    const actor = requireActor(req);
    const server = createMcpServer({ ...opts.deps, actor });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    // Sem sessão e com resposta JSON: a resposta deve estar encerrada aqui.
    if (!reply.raw.writableEnded) reply.raw.end();
  });

  const notAllowed = async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) =>
    reply.code(405).send({
      error: { code: "VALIDATION_ERROR", message: "Use POST /mcp (servidor sem sessão)." },
    });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
