import type { Origin } from "@ofertas/contracts";
import {
  type Actor,
  AppError,
  authenticateToken,
  consumeLimit,
  type Deps,
  getLimit,
  resolveSession,
} from "@ofertas/core";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "ofertas_sid";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

/** Descobre quem está chamando: token Bearer (agente/CLI) ou cookie de sessão (painel). */
export async function resolveActor(deps: Deps, req: FastifyRequest): Promise<Actor | null> {
  const token = bearer(req);
  if (token) {
    const origin: Origin = req.url.startsWith("/mcp")
      ? "mcp"
      : req.headers["x-client"] === "cli"
        ? "cli"
        : "rest";
    const actor = await authenticateToken(deps, token, origin);
    if (!actor) {
      throw new AppError("UNAUTHENTICATED", "Token inválido, expirado ou revogado.", {
        hint: "Gere um novo token em Configurações → Conectar agente.",
      });
    }
    return actor;
  }
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) return (await resolveSession(deps, sid))?.actor ?? null;
  return null;
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) {
    throw new AppError("UNAUTHENTICATED", "Autenticação necessária.", {
      hint: "Envie 'Authorization: Bearer <token>' ou faça login no painel.",
    });
  }
  return req.actor;
}

/** Rate limit por ator. */
export async function enforceRateLimit(deps: Deps, actor: Actor) {
  const max = await getLimit(deps, actor.workspaceId, "api.requests_per_minute");
  await consumeLimit(deps, {
    key: "api.requests_per_minute",
    bucket: `${actor.type}:${actor.id}`,
    max,
    windowSec: 60,
  });
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}
