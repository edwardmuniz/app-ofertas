import {
  type ApiToken,
  type CreatedToken,
  CreateTokenInput,
  type Origin,
  SCOPE_PRESETS,
  type Scope,
  TOKEN_SCOPES,
} from "@ofertas/contracts";
import { apiTokens } from "@ofertas/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import { type Actor, type Ctx, type Deps, now } from "./context";
import { randomToken, sha256 } from "./crypto";
import { AppError } from "./errors";
import { runMutation } from "./mutation";

export const TOKEN_PREFIX = "ofk_";
const LAST_USED_THROTTLE_MS = 60_000;

type TokenRow = typeof apiTokens.$inferSelect;

const toApiToken = (r: TokenRow): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt?.toISOString() ?? null,
  expires_at: r.expiresAt?.toISOString() ?? null,
  revoked_at: r.revokedAt?.toISOString() ?? null,
});

export async function createToken(ctx: Ctx, rawInput: CreateTokenInput): Promise<CreatedToken> {
  requireHuman(ctx.actor, "Criar tokens");
  const input = CreateTokenInput.parse(rawInput);
  const scopes = [
    ...new Set([
      ...(input.preset ? SCOPE_PRESETS[input.preset].scopes : []),
      ...(input.scopes ?? []),
    ]),
  ].filter((s) => (TOKEN_SCOPES as readonly string[]).includes(s));

  // O token nunca pode ter mais poder que o usuário que o cria.
  const missing = scopes.filter((s) => !ctx.actor.scopes.has(s as Scope));
  if (missing.length) {
    throw new AppError("FORBIDDEN_SCOPE", "Você não pode conceder escopos que não possui.", {
      details: { missing },
    });
  }

  const plain = TOKEN_PREFIX + randomToken(32);
  const expiresAt = input.expires_in_days
    ? new Date(now(ctx).getTime() + input.expires_in_days * 86_400_000)
    : null;

  const res = await runMutation(ctx, {
    action: "tokens.create",
    scope: "settings:write",
    input: { name: input.name, scopes, expires_at: expiresAt?.toISOString() ?? null },
    preview: async (_c, i) => i,
    execute: async (tx, i) => {
      const [row] = await tx.db
        .insert(apiTokens)
        .values({
          workspaceId: ctx.actor.workspaceId,
          name: i.name,
          tokenHash: sha256(plain),
          prefix: plain.slice(0, 12),
          scopes: i.scopes,
          createdBy: ctx.actor.id,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error("Falha ao criar token");
      return toApiToken(row);
    },
  });
  if (res.status !== "done") throw new Error("Criação de token não concluída");
  return { ...res.result, token: plain };
}

export async function listTokens(ctx: Ctx): Promise<ApiToken[]> {
  requireScope(ctx.actor, "settings:read");
  const rows = await ctx.db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.workspaceId, ctx.actor.workspaceId))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map(toApiToken);
}

export async function revokeToken(ctx: Ctx, id: string): Promise<ApiToken> {
  requireHuman(ctx.actor, "Revogar tokens");
  const res = await runMutation(ctx, {
    action: "tokens.revoke",
    scope: "settings:write",
    input: { id },
    target: (i) => ({ type: "api_token", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.id, i.id), eq(apiTokens.workspaceId, c.actor.workspaceId)));
      if (!row) throw new AppError("NOT_FOUND", "Token não encontrado.");
      return toApiToken(row);
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(apiTokens)
        .set({ revokedAt: now(ctx) })
        .where(and(eq(apiTokens.id, i.id), eq(apiTokens.workspaceId, ctx.actor.workspaceId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Token não encontrado.");
      return toApiToken(row);
    },
  });
  if (res.status !== "done") throw new Error("Revogação não concluída");
  return res.result;
}

/** Valida um token de API e devolve o ator correspondente, ou null. */
export async function authenticateToken(
  deps: Deps,
  plain: string,
  origin: Origin,
): Promise<Actor | null> {
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await deps.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, sha256(plain)), isNull(apiTokens.revokedAt)))
    .limit(1);
  const t = now(deps);
  if (!row || (row.expiresAt && row.expiresAt <= t)) return null;

  if (!row.lastUsedAt || t.getTime() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await deps.db.update(apiTokens).set({ lastUsedAt: t }).where(eq(apiTokens.id, row.id));
  }

  return {
    type: "token",
    id: row.id,
    label: `token:${row.name}`,
    workspaceId: row.workspaceId,
    scopes: new Set(row.scopes as Scope[]),
    origin,
  };
}
