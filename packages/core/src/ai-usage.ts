import { type AiUsage, CopyWriterError } from "@ofertas/connectors";
import { AI_FEATURES, type AiUsageSummary } from "@ofertas/contracts";
import { aiUsage, type DbOrTx, workspaces } from "@ofertas/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, now } from "./context";

export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * Grava o consumo de uma geração com IA (tokens e custo informado pelo provedor). Nunca derruba
 * quem chamou: medir o gasto não pode impedir o texto ou a rodada.
 */
export async function recordAiUsage(
  db: DbOrTx,
  workspaceId: string,
  feature: AiFeature,
  usage: AiUsage | null | undefined,
) {
  if (!usage) return;
  try {
    await db.insert(aiUsage).values({
      workspaceId,
      feature,
      provider: usage.provider,
      model: usage.model,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    });
  } catch (err) {
    console.error("ai_usage: falha ao gravar", err);
  }
}

/** Consumo que veio junto com um erro da IA (a chamada que falhou também pode ter custado). */
export function usageOfError(err: unknown): AiUsage | undefined {
  return err instanceof CopyWriterError ? err.usage : undefined;
}

type Row = {
  feature: AiFeature;
  calls: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** Gasto com IA de hoje e do mês (no fuso do workspace), separado por função. */
export async function getAiUsage(ctx: Ctx): Promise<AiUsageSummary> {
  requireScope(ctx.actor, "metrics:read");
  const wsId = ctx.actor.workspaceId;
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, wsId));
  const tz = ws?.tz ?? "America/Sao_Paulo";
  const at = now(ctx).toISOString();
  const start = (unit: "day" | "month") =>
    sql`(date_trunc(${unit}, ${at}::timestamptz at time zone ${tz}) at time zone ${tz})`;
  const today = sql`${aiUsage.createdAt} >= ${start("day")}`;

  const rows = await ctx.db
    .select({
      feature: aiUsage.feature,
      monthCalls: sql<number>`count(*)::int`,
      monthRequests: sql<number>`coalesce(sum(${aiUsage.requests}), 0)::int`,
      monthIn: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      monthOut: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
      monthCost: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`,
      unpriced: sql<number>`(count(*) filter (where ${aiUsage.costUsd} is null))::int`,
      dayCalls: sql<number>`(count(*) filter (where ${today}))::int`,
      dayRequests: sql<number>`coalesce(sum(${aiUsage.requests}) filter (where ${today}), 0)::int`,
      dayIn: sql<number>`coalesce(sum(${aiUsage.inputTokens}) filter (where ${today}), 0)::int`,
      dayOut: sql<number>`coalesce(sum(${aiUsage.outputTokens}) filter (where ${today}), 0)::int`,
      dayCost: sql<number>`coalesce(sum(${aiUsage.costUsd}) filter (where ${today}), 0)::float8`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, wsId), gte(aiUsage.createdAt, start("month"))))
    .groupBy(aiUsage.feature);

  const [first] = await ctx.db
    .select({ at: sql<Date | string | null>`min(${aiUsage.createdAt})` })
    .from(aiUsage)
    .where(eq(aiUsage.workspaceId, wsId));

  const period = (pick: (r: (typeof rows)[number]) => Omit<Row, "feature">) => {
    const byFeature: Row[] = AI_FEATURES.map((feature) => {
      const r = rows.find((x) => x.feature === feature);
      return r
        ? { feature, ...pick(r) }
        : { feature, calls: 0, requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    });
    return {
      cost_usd: byFeature.reduce((s, r) => s + r.cost_usd, 0),
      by_feature: byFeature,
    };
  };
  return {
    today: period((r) => ({
      calls: r.dayCalls,
      requests: r.dayRequests,
      input_tokens: r.dayIn,
      output_tokens: r.dayOut,
      cost_usd: r.dayCost,
    })),
    month: period((r) => ({
      calls: r.monthCalls,
      requests: r.monthRequests,
      input_tokens: r.monthIn,
      output_tokens: r.monthOut,
      cost_usd: r.monthCost,
    })),
    since: first?.at ? new Date(first.at).toISOString() : null,
    unpriced_calls: rows.reduce((s, r) => s + r.unpriced, 0),
  };
}
