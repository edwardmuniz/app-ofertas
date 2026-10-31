import { Preferences, type WorkspaceOverview } from "@ofertas/contracts";
import { apiTokens, approvals, auditLogs, type DbOrTx, memberships, workspaces } from "@ofertas/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { overviewAlerts } from "./alerts";
import { requireScope } from "./authz";
import { type Actor, type Ctx, now } from "./context";
import { AppError } from "./errors";
import { MODULES } from "./modules";
import { type MutationOptions, runMutation } from "./mutation";

const count = sql<number>`count(*)::int`;

async function loadWorkspace(ctx: { db: DbOrTx; actor: Actor }) {
  const [ws] = await ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!ws) throw new AppError("NOT_FOUND", "Workspace não encontrado.");
  return ws;
}

/** Resumo do workspace. Qualquer ator autenticado pode ler. */
export async function getOverview(ctx: Ctx): Promise<WorkspaceOverview> {
  const ws = await loadWorkspace(ctx);
  const wsId = ws.id;
  const t = now(ctx);
  const dayAgo = new Date(t.getTime() - 86_400_000);

  const [[members], [tokens], [pending], [actions]] = await Promise.all([
    ctx.db.select({ n: count }).from(memberships).where(eq(memberships.workspaceId, wsId)),
    ctx.db
      .select({ n: count })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.workspaceId, wsId),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, t)),
        ),
      ),
    ctx.db
      .select({ n: count })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, wsId), eq(approvals.status, "pending"))),
    ctx.db
      .select({ n: count })
      .from(auditLogs)
      .where(and(eq(auditLogs.workspaceId, wsId), gt(auditLogs.createdAt, dayAgo))),
  ]);

  const alerts: WorkspaceOverview["alerts"] = await overviewAlerts(ctx);
  if ((pending?.n ?? 0) > 0) {
    alerts.push({ level: "warning", message: `${pending?.n} aprovação(ões) aguardando decisão.` });
  }

  return {
    workspace: { id: ws.id, name: ws.name, timezone: ws.timezone },
    counts: {
      members: members?.n ?? 0,
      active_tokens: tokens?.n ?? 0,
      pending_approvals: pending?.n ?? 0,
      actions_last_24h: actions?.n ?? 0,
    },
    modules: MODULES.map((m) => ({ ...m })),
    alerts,
  };
}

export async function getPreferences(ctx: Ctx): Promise<Preferences> {
  requireScope(ctx.actor, "settings:read");
  const ws = await loadWorkspace(ctx);
  return Preferences.parse(ws.settings.preferences ?? {});
}

/** Atualização parcial: campos enviados substituem os atuais; campos omitidos ficam como estão. */
export async function updatePreferences(ctx: Ctx, patch: Preferences, opts: MutationOptions = {}) {
  const input = Preferences.parse(patch);
  return runMutation(ctx, {
    action: "workspace.update_preferences",
    scope: "settings:write",
    input,
    opts,
    target: () => ({ type: "workspace", id: ctx.actor.workspaceId }),
    preview: async (c, i) => {
      const before = Preferences.parse((await loadWorkspace(c)).settings.preferences ?? {});
      const after = Preferences.parse({ ...before, ...i });
      const changed = Object.keys(i);
      return { before, after, changed_fields: changed };
    },
    execute: async (tx, _i, preview) => {
      const ws = await loadWorkspace(tx);
      await tx.db
        .update(workspaces)
        .set({ settings: { ...ws.settings, preferences: preview.after } })
        .where(eq(workspaces.id, ws.id));
      return preview.after;
    },
  });
}
