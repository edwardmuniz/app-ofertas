import { type AutomationRule, RuleFilters, UpsertAutomationRuleInput } from "@ofertas/contracts";
import {
  automationRules,
  channelSegments,
  channels,
  offers,
  posts,
  products,
  segments,
} from "@ofertas/db";
import { and, asc, desc, eq, gte, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";
import { AppError } from "./errors";
import { getLimit } from "./limits";
import { type MutationOptions, runMutation } from "./mutation";
import { workspaceSchedule } from "./posts";
import { isWithinWindows, localDate, tzOffsetMs } from "./tz";

type RuleRow = typeof automationRules.$inferSelect;

const DAY = 86_400_000;

type RuleStats = AutomationRule["stats"];
const NO_STATS: RuleStats = {
  today: 0,
  scheduled: 0,
  sent_7d: 0,
  sent_total: 0,
  groups: 0,
  groups_at_limit: 0,
};

const toRule = (r: RuleRow, stats: RuleStats = NO_STATS): AutomationRule => ({
  id: r.id,
  name: r.name,
  active: r.active,
  filters: RuleFilters.parse(r.filters),
  segment_ids: r.segmentIds,
  windows: r.windows,
  max_per_day: r.maxPerDay,
  min_interval_minutes: r.minIntervalMinutes,
  template_id: r.templateId,
  creative_template: r.creativeTemplate,
  last_run_at: r.lastRunAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
  stats,
});

export async function listAutomationRules(ctx: Ctx) {
  requireScope(ctx.actor, "posts:read");
  const rows = await ctx.db
    .select()
    .from(automationRules)
    .where(eq(automationRules.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(automationRules.createdAt));
  if (!rows.length) return [];
  const stats = await ruleStats(ctx, rows);
  return rows.map((r) => toRule(r, stats.get(r.id)));
}

/**
 * Quanto cada regra já publicou: hoje (o que conta para o limite diário, por grupo),
 * agendadas, últimos 7 dias e total; e quantos grupos já bateram o máximo do dia.
 */
async function ruleStats(ctx: Ctx, rules: RuleRow[]) {
  const wsId = ctx.actor.workspaceId;
  const at = now(ctx);
  const { tz } = await workspaceSchedule(ctx.db, wsId);
  const today = localDate(at, tz);
  const dayStart = new Date(Date.parse(`${today}T00:00:00Z`) - tzOffsetMs(at, tz)).toISOString();
  const weekAgo = new Date(at.getTime() - 7 * DAY).toISOString();

  const counts = await ctx.db
    .select({
      ruleId: posts.ruleId,
      channelId: posts.channelId,
      today: sql<number>`count(*) filter (where ${posts.status} in ('scheduled', 'sending', 'sent') and ${posts.createdAt} >= ${dayStart})::int`,
      scheduled: sql<number>`count(*) filter (where ${posts.status} in ('scheduled', 'sending'))::int`,
      sent7d: sql<number>`count(*) filter (where ${posts.status} = 'sent' and ${posts.sentAt} >= ${weekAgo})::int`,
      sentTotal: sql<number>`count(*) filter (where ${posts.status} = 'sent')::int`,
    })
    .from(posts)
    .where(
      and(
        eq(posts.workspaceId, wsId),
        inArray(
          posts.ruleId,
          rules.map((r) => r.id),
        ),
      ),
    )
    .groupBy(posts.ruleId, posts.channelId);

  const links = await ctx.db
    .select({ segmentId: channelSegments.segmentId, channelId: channels.id })
    .from(channelSegments)
    .innerJoin(channels, eq(channels.id, channelSegments.channelId))
    .where(and(eq(channels.workspaceId, wsId), eq(channels.status, "active")));

  const out = new Map<string, RuleStats>();
  for (const rule of rules) {
    const segs = new Set(rule.segmentIds);
    const groups = new Set(links.filter((l) => segs.has(l.segmentId)).map((l) => l.channelId));
    const mine = counts.filter((c) => c.ruleId === rule.id);
    const sum = (k: "today" | "scheduled" | "sent7d" | "sentTotal") =>
      mine.reduce((n, c) => n + c[k], 0);
    out.set(rule.id, {
      today: sum("today"),
      scheduled: sum("scheduled"),
      sent_7d: sum("sent7d"),
      sent_total: sum("sentTotal"),
      groups: groups.size,
      groups_at_limit: mine.filter((c) => groups.has(c.channelId) && c.today >= rule.maxPerDay)
        .length,
    });
  }
  return out;
}

/** Cria ou edita uma regra que publica ofertas aprovadas automaticamente. */
export async function upsertAutomationRule(
  ctx: Ctx,
  raw: UpsertAutomationRuleInput,
  opts: MutationOptions = {},
) {
  const input = UpsertAutomationRuleInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "rules.update" : "rules.create",
    scope: "posts:write",
    input,
    opts,
    target: (i) => ({ type: "automation_rule", id: i.id }),
    preview: async (c, i) => {
      if (!i.id && (!i.name || !i.segment_ids?.length)) {
        throw new AppError("VALIDATION_ERROR", "Informe name e segment_ids para criar a regra.");
      }
      if (i.segment_ids?.length) {
        const found = await c.db
          .select({ id: segments.id })
          .from(segments)
          .where(and(eq(segments.workspaceId, wsId), inArray(segments.id, i.segment_ids)));
        if (found.length !== new Set(i.segment_ids).size) {
          throw new AppError("NOT_FOUND", "Segmento(s) não encontrado(s).", {
            hint: "Use list_segments para ver os ids.",
          });
        }
      }
      return i;
    },
    execute: async (tx, i) => {
      const values = {
        ...(i.name !== undefined && { name: i.name }),
        ...(i.active !== undefined && { active: i.active }),
        ...(i.filters !== undefined && { filters: i.filters as Record<string, unknown> }),
        ...(i.segment_ids !== undefined && { segmentIds: i.segment_ids }),
        ...(i.windows !== undefined && { windows: i.windows }),
        ...(i.max_per_day !== undefined && { maxPerDay: i.max_per_day }),
        ...(i.min_interval_minutes !== undefined && { minIntervalMinutes: i.min_interval_minutes }),
        ...(i.template_id !== undefined && { templateId: i.template_id }),
        ...(i.creative_template !== undefined && { creativeTemplate: i.creative_template }),
      };
      const [row] = i.id
        ? await tx.db
            .update(automationRules)
            .set(values)
            .where(and(eq(automationRules.id, i.id), eq(automationRules.workspaceId, wsId)))
            .returning()
        : await tx.db
            .insert(automationRules)
            .values({
              ...values,
              name: i.name ?? "",
              segmentIds: i.segment_ids ?? [],
              workspaceId: wsId,
            })
            .returning();
      if (!row) throw new AppError("NOT_FOUND", "Regra não encontrada.");
      return toRule(row);
    },
  });
}

/**
 * Roda as regras ativas: em cada grupo, dentro da janela, agenda no máximo 1 oferta por vez,
 * respeitando o intervalo mínimo e o limite diário. Chamado pelo worker a cada minuto.
 */
export async function runAutomationRules(deps: Deps) {
  const at = now(deps);
  const rules = await deps.db
    .select()
    .from(automationRules)
    .where(eq(automationRules.active, true));
  let scheduled = 0;

  for (const rule of rules) {
    const sched = await workspaceSchedule(deps.db, rule.workspaceId);
    const windows = rule.windows.length ? rule.windows : sched.windows;
    await deps.db
      .update(automationRules)
      .set({ lastRunAt: at })
      .where(eq(automationRules.id, rule.id));
    if (!isWithinWindows(at, windows, sched.tz)) continue;

    const filters = RuleFilters.parse(rule.filters);
    const targets = await deps.db
      .selectDistinct({ channel: channels })
      .from(channelSegments)
      .innerJoin(channels, eq(channels.id, channelSegments.channelId))
      .where(
        and(
          inArray(channelSegments.segmentId, rule.segmentIds),
          eq(channels.status, "active"),
          sql`${channels.messagingAccountId} is not null`,
          sql`${channels.externalId} is not null`,
        ),
      );

    // Início do dia local, para contar o limite diário.
    const today = localDate(at, sched.tz);
    const dayStart = new Date(Date.parse(`${today}T00:00:00Z`) - tzOffsetMs(at, sched.tz));
    const minInterval = Math.max(
      rule.minIntervalMinutes,
      await getLimit(deps, rule.workspaceId, "posts.min_interval_minutes"),
    );

    for (const { channel } of targets) {
      const [stats] = await deps.db
        .select({
          today: sql<number>`count(*) filter (where ${posts.ruleId} = ${rule.id} and ${posts.createdAt} >= ${dayStart.toISOString()})::int`,
          pending: sql<number>`count(*) filter (where ${posts.ruleId} = ${rule.id} and ${posts.status} in ('scheduled', 'sending'))::int`,
          last: sql<string | null>`max(coalesce(${posts.sentAt}, ${posts.scheduledAt}))`,
        })
        .from(posts)
        .where(
          and(
            eq(posts.channelId, channel.id),
            inArray(posts.status, ["scheduled", "sending", "sent"]),
          ),
        );
      if ((stats?.today ?? 0) >= rule.maxPerDay || (stats?.pending ?? 0) > 0) continue;
      if (stats?.last && at.getTime() - new Date(stats.last).getTime() < minInterval * 60_000)
        continue;

      const conds: SQL[] = [
        eq(offers.workspaceId, rule.workspaceId),
        eq(offers.status, "approved"),
        sql`not exists (
          select 1 from posts p join offers o2 on o2.id = p.offer_id
          where p.channel_id = ${channel.id} and o2.product_id = ${products.id}
            and p.status in ('scheduled', 'sending', 'sent')
            and p.created_at >= ${new Date(at.getTime() - 7 * DAY).toISOString()}
        )`,
      ];
      if (filters.min_score !== undefined) conds.push(gte(offers.score, filters.min_score));
      if (filters.min_discount !== undefined)
        conds.push(gte(offers.discountPct, filters.min_discount));
      if (filters.platforms?.length) conds.push(inArray(products.platform, filters.platforms));
      if (filters.keywords?.length) {
        const kw = or(
          ...filters.keywords.flatMap((k) => [
            ilike(products.title, `%${k}%`),
            ilike(products.categoryName, `%${k}%`),
          ]),
        );
        if (kw) conds.push(kw);
      }
      const [best] = await deps.db
        .select({ offerId: offers.id })
        .from(offers)
        .innerJoin(products, eq(products.id, offers.productId))
        .where(and(...conds))
        .orderBy(desc(offers.score), desc(offers.createdAt))
        .limit(1);
      if (!best) continue;

      const jitter = Math.floor(
        Math.random() * (await getLimit(deps, rule.workspaceId, "posts.jitter_seconds")) * 1000,
      );
      await deps.db.insert(posts).values({
        workspaceId: rule.workspaceId,
        channelId: channel.id,
        offerId: best.offerId,
        templateId: rule.templateId,
        creativeTemplate: rule.creativeTemplate,
        ruleId: rule.id,
        scheduledAt: new Date(at.getTime() + jitter),
        createdBy: `regra:${rule.name}`,
      });
      scheduled++;
    }
  }
  return { rules: rules.length, scheduled };
}
