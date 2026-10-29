import { type AuditEntry, type AuditPage, AuditQuery } from "@ofertas/contracts";
import { auditLogs, type DbOrTx } from "@ofertas/db";
import { and, desc, eq } from "drizzle-orm";
import { requireScope } from "./authz";
import type { Actor, Ctx } from "./context";
import { olderThan, toPage } from "./cursor";

export type AuditInput = {
  action: string;
  target?: { type: string; id?: string };
  params?: unknown;
  reason?: string;
  result: "ok" | "error" | "pending_approval";
  error?: unknown;
};

export async function recordAudit(db: DbOrTx, actor: Actor, input: AuditInput) {
  await db.insert(auditLogs).values({
    workspaceId: actor.workspaceId,
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    origin: actor.origin,
    action: input.action,
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
    params: input.params ?? null,
    reason: input.reason ?? null,
    result: input.result,
    error: input.error ?? null,
  });
}

export async function listAudit(ctx: Ctx, rawQuery: Partial<AuditQuery> = {}): Promise<AuditPage> {
  requireScope(ctx.actor, "settings:read");
  const q = AuditQuery.parse(rawQuery);
  const conds = [eq(auditLogs.workspaceId, ctx.actor.workspaceId)];
  if (q.origin) conds.push(eq(auditLogs.origin, q.origin));
  if (q.actor_type) conds.push(eq(auditLogs.actorType, q.actor_type));
  if (q.action) conds.push(eq(auditLogs.action, q.action));
  if (q.cursor) {
    const older = olderThan(q.cursor, auditLogs.createdAt, auditLogs.id);
    if (older) conds.push(older);
  }

  const rows = await ctx.db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(q.limit + 1);

  return toPage(
    rows,
    q.limit,
    (r): AuditEntry => ({
      id: r.id,
      created_at: r.createdAt.toISOString(),
      actor_type: r.actorType,
      actor_id: r.actorId,
      actor_label: r.actorLabel,
      origin: r.origin,
      action: r.action,
      target_type: r.targetType,
      target_id: r.targetId,
      params: r.params,
      reason: r.reason,
      result: r.result,
      error: r.error,
    }),
  );
}
