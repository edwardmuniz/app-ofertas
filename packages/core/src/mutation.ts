import type { Scope } from "@ofertas/contracts";
import { approvals, idempotencyKeys } from "@ofertas/db";
import { and, eq, gt } from "drizzle-orm";
import { recordAudit } from "./audit";
import { requireScope } from "./authz";
import { type Ctx, now, type TxCtx } from "./context";
import { sha256, stableStringify } from "./crypto";
import { AppError, isAppError } from "./errors";
import { resolvePolicy } from "./policy";

export type MutationOptions = {
  dryRun?: boolean;
  idempotencyKey?: string;
  reason?: string;
};

export type MutationResult<P, R> =
  | { status: "dry_run"; preview: P }
  | { status: "done"; result: R }
  | { status: "pending_approval"; approval_id: string; preview: P };

export type MutationSpec<I, P, R> = {
  /** Nome da ação no log, ex.: "workspace.update_preferences" */
  action: string;
  scope: Scope;
  input: I;
  opts?: MutationOptions;
  target?: (input: I) => { type: string; id?: string };
  /** Calcula o que será feito. NÃO pode ter efeitos colaterais. */
  preview: (ctx: Ctx, input: I) => Promise<P>;
  /** Executa de fato, dentro de uma transação. */
  execute: (ctx: TxCtx, input: I, preview: P) => Promise<R>;
};

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ponto único por onde passam as ações que alteram algo.
 * Garante: escopo, prévia (dry_run), idempotência, política de aprovação e auditoria.
 */
export async function runMutation<I, P, R>(
  ctx: Ctx,
  spec: MutationSpec<I, P, R>,
): Promise<MutationResult<P, R>> {
  const { actor } = ctx;
  const opts = spec.opts ?? {};
  requireScope(actor, spec.scope);

  const preview = await spec.preview(ctx, spec.input);
  if (opts.dryRun) return { status: "dry_run", preview };

  const requestHash = sha256(stableStringify({ action: spec.action, input: spec.input }));
  if (opts.idempotencyKey) {
    const [stored] = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, actor.workspaceId),
          eq(idempotencyKeys.key, opts.idempotencyKey),
          gt(idempotencyKeys.expiresAt, now(ctx)),
        ),
      )
      .limit(1);
    if (stored) {
      if (stored.requestHash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Esta idempotency_key já foi usada com outros parâmetros.",
          { hint: "Gere uma chave nova para uma operação diferente." },
        );
      }
      return stored.response as MutationResult<P, R>;
    }
  }

  const target = spec.target?.(spec.input);
  const auditBase = { action: spec.action, target, params: spec.input, reason: opts.reason };

  const mode = await resolvePolicy(ctx.db, actor.workspaceId, spec.action);
  if (mode === "blocked") {
    await recordAudit(ctx.db, actor, {
      ...auditBase,
      result: "error",
      error: { code: "ACTION_BLOCKED" },
    });
    throw new AppError(
      "ACTION_BLOCKED",
      `A ação "${spec.action}" está bloqueada neste workspace.`,
      {
        hint: "Um administrador pode mudar a política dessa ação no painel.",
      },
    );
  }

  try {
    return await ctx.db.transaction(async (tx) => {
      const txCtx: TxCtx = { ...ctx, db: tx };
      let response: MutationResult<P, R>;

      if (mode === "approval" && actor.type !== "user") {
        const [row] = await tx
          .insert(approvals)
          .values({
            workspaceId: actor.workspaceId,
            actionType: spec.action,
            payload: spec.input as object,
            preview: preview as object,
            requestedByType: actor.type,
            requestedById: actor.id,
            reason: opts.reason ?? null,
          })
          .returning({ id: approvals.id });
        if (!row) throw new Error("Falha ao criar aprovação");
        response = { status: "pending_approval", approval_id: row.id, preview };
        await recordAudit(tx, actor, { ...auditBase, result: "pending_approval" });
      } else {
        const result = await spec.execute(txCtx, spec.input, preview);
        response = { status: "done", result };
        await recordAudit(tx, actor, { ...auditBase, result: "ok" });
      }

      if (opts.idempotencyKey) {
        await tx.insert(idempotencyKeys).values({
          workspaceId: actor.workspaceId,
          key: opts.idempotencyKey,
          actorId: actor.id,
          requestHash,
          response: response as object,
          expiresAt: new Date(now(ctx).getTime() + IDEMPOTENCY_TTL_MS),
        });
      }
      return response;
    });
  } catch (err) {
    // A transação desfez tudo; registramos a falha fora dela.
    await recordAudit(ctx.db, actor, {
      ...auditBase,
      result: "error",
      error: isAppError(err)
        ? err.toJSON().error
        : { code: "INTERNAL_ERROR", message: String(err) },
    }).catch(() => {});
    throw err;
  }
}
