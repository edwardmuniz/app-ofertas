import { type SavedSearch, SearchOffersInput, UpsertSavedSearchInput } from "@ofertas/contracts";
import { offers, savedSearches } from "@ofertas/db";
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";
import { runSearch } from "./offers";

type SavedSearchRow = typeof savedSearches.$inferSelect;

export type HarvestResult = {
  found?: number;
  qualified?: number;
  added?: number;
  errors?: { platform: string; message: string }[];
  error?: string;
};

const toSavedSearch = (r: SavedSearchRow): SavedSearch => ({
  id: r.id,
  name: r.name,
  query: SearchOffersInput.parse(r.query),
  interval_minutes: r.intervalMinutes,
  min_score: r.minScore,
  active: r.active,
  last_run_at: r.lastRunAt?.toISOString() ?? null,
  last_result: r.lastResult ?? null,
  created_at: r.createdAt.toISOString(),
});

export async function listSavedSearches(ctx: Ctx): Promise<SavedSearch[]> {
  requireScope(ctx.actor, "offers:read");
  const rows = await ctx.db
    .select()
    .from(savedSearches)
    .where(eq(savedSearches.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(savedSearches.createdAt));
  return rows.map(toSavedSearch);
}

/** Cria ou edita uma busca salva. O worker roda as buscas ativas no intervalo definido. */
export async function upsertSavedSearch(
  ctx: Ctx,
  raw: UpsertSavedSearchInput,
  opts: MutationOptions = {},
) {
  const input = UpsertSavedSearchInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "saved_searches.update" : "saved_searches.create",
    scope: "offers:write",
    input,
    opts,
    target: (i) => ({ type: "saved_search", id: i.id }),
    preview: async (c, i) => {
      if (!i.id && (!i.name || !i.query)) {
        throw new AppError("VALIDATION_ERROR", "Informe name e query para criar a busca salva.");
      }
      if (i.id) {
        const [row] = await c.db
          .select({ id: savedSearches.id })
          .from(savedSearches)
          .where(and(eq(savedSearches.id, i.id), eq(savedSearches.workspaceId, wsId)));
        if (!row) throw new AppError("NOT_FOUND", "Busca salva não encontrada.");
      }
      return i;
    },
    execute: async (tx, i) => {
      const values = {
        ...(i.name !== undefined && { name: i.name }),
        ...(i.query !== undefined && { query: i.query as Record<string, unknown> }),
        ...(i.interval_minutes !== undefined && { intervalMinutes: i.interval_minutes }),
        ...(i.min_score !== undefined && { minScore: i.min_score }),
        ...(i.active !== undefined && { active: i.active }),
      };
      const [row] = i.id
        ? await tx.db
            .update(savedSearches)
            .set(values)
            .where(and(eq(savedSearches.id, i.id), eq(savedSearches.workspaceId, wsId)))
            .returning()
        : await tx.db
            .insert(savedSearches)
            .values({
              ...values,
              name: i.name ?? "",
              query: (i.query ?? {}) as Record<string, unknown>,
              workspaceId: wsId,
            })
            .returning();
      if (!row) throw new AppError("NOT_FOUND", "Busca salva não encontrada.");
      return toSavedSearch(row);
    },
  });
}

/** Ofertas recusadas ou já na curadoria não voltam pela busca automática. */
async function productsAlreadyCurated(deps: Deps, productIds: string[]) {
  if (productIds.length === 0) return new Set<string>();
  const rows = await deps.db
    .select({ productId: offers.productId })
    .from(offers)
    .where(
      and(
        inArray(offers.productId, productIds),
        inArray(offers.status, ["new", "approved", "rejected"]),
      ),
    );
  return new Set(rows.map((r) => r.productId));
}

/** Roda uma busca salva: ofertas com nota suficiente entram na curadoria como "new". */
export async function runSavedSearch(deps: Deps, row: SavedSearchRow): Promise<HarvestResult> {
  const actor = systemActor(row.workspaceId, "offer-harvest");
  const at = now(deps);
  let result: HarvestResult;
  try {
    const { candidates, errors } = await runSearch(
      deps,
      row.workspaceId,
      SearchOffersInput.parse(row.query),
    );
    const good = candidates.filter((c) => c.score >= row.minScore && c.item.available);
    const curated = await productsAlreadyCurated(
      deps,
      good.map((c) => c.product.id),
    );
    const fresh = good.filter((c) => !curated.has(c.product.id));
    if (fresh.length) {
      await deps.db.insert(offers).values(
        fresh.map((c) => ({
          workspaceId: row.workspaceId,
          productId: c.product.id,
          affiliateAccountId: c.account.id,
          status: "new" as const,
          price: c.item.price,
          originalPrice: c.item.originalPrice,
          discountPct: c.item.discountPct,
          commissionRate: c.item.commissionRate,
          commissionValue: c.item.commissionValue,
          affiliateUrl: c.item.affiliateUrl,
          validUntil: c.item.validUntil,
          score: c.score,
          qualityFlags: c.flags,
          savedSearchId: row.id,
        })),
      );
    }
    result = { found: candidates.length, qualified: good.length, added: fresh.length, errors };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  await deps.db
    .update(savedSearches)
    .set({ lastRunAt: at, lastResult: result as Record<string, unknown> })
    .where(eq(savedSearches.id, row.id));
  await recordAudit(deps.db, actor, {
    action: "offers.harvest",
    target: { type: "saved_search", id: row.id },
    params: result,
    result: "error" in result ? "error" : "ok",
  });
  return result;
}

/** Roda todas as buscas salvas vencidas e expira ofertas fora do prazo. Chamado pelo worker. */
export async function runDueSavedSearches(deps: Deps) {
  const at = now(deps);
  const due = await deps.db
    .select()
    .from(savedSearches)
    .where(
      and(
        eq(savedSearches.active, true),
        or(
          sql`${savedSearches.lastRunAt} is null`,
          sql`${savedSearches.lastRunAt} + (${savedSearches.intervalMinutes} * interval '1 minute') <= ${at.toISOString()}`,
        ),
      ),
    )
    .orderBy(asc(savedSearches.lastRunAt));
  const results = [];
  for (const row of due) results.push({ id: row.id, ...(await runSavedSearch(deps, row)) });

  const expired = await deps.db
    .update(offers)
    .set({ status: "expired" })
    .where(
      and(
        inArray(offers.status, ["new", "approved"]),
        isNotNull(offers.validUntil),
        lt(offers.validUntil, at),
      ),
    )
    .returning({ id: offers.id });
  return { ran: results, expired: expired.length };
}
