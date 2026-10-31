// Métricas: consolidação de cliques por hora e consultas de resumo, funil e detalhamento.
import {
  type Funnel,
  type MetricsBreakdown,
  MetricsBreakdownQuery,
  MetricsPeriodQuery,
  type PerformanceSummary,
} from "@ofertas/contracts";
import {
  alerts,
  channelStatsDaily,
  channels,
  clickStatsHourly,
  clicks,
  offers,
  posts,
  products,
  workspaces,
} from "@ofertas/db";
import { and, desc, eq, gte, inArray, lt, lte, ne, type SQL, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";
import { AppError } from "./errors";
import { localDate, localMidnight } from "./tz";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_RANGE_DAYS = 366;
export const ROLLUP_STAMP_KEY = "metrics:rollup:at";

const truncHour = (d: Date) => new Date(Math.floor(d.getTime() / HOUR) * HOUR);

// ── Consolidação ────────────────────────────────────────────────

/**
 * Recalcula `click_stats_hourly` para as horas entre `from` e `to` (apaga e reinsere, então
 * pode rodar quantas vezes quiser). Sem `from`: continua de 2 h antes da última hora
 * consolidada, ou desde o primeiro clique.
 */
export async function rollupClicks(
  deps: Pick<Deps, "db" | "now" | "cache">,
  opts: { from?: Date; to?: Date } = {},
) {
  const t = now(deps);
  let from = opts.from;
  if (!from) {
    const [last] = await deps.db
      .select({ h: sql<string | null>`max(${clickStatsHourly.hour})` })
      .from(clickStatsHourly);
    if (last?.h) from = new Date(new Date(last.h).getTime() - 2 * HOUR);
    else {
      const [first] = await deps.db
        .select({ t: sql<string | null>`min(${clicks.ts})` })
        .from(clicks);
      if (!first?.t) {
        await deps.cache.set(ROLLUP_STAMP_KEY, t.toISOString(), 30 * 86_400);
        return { from: null, to: null, rows: 0 };
      }
      from = new Date(first.t);
    }
  }
  const fromHour = truncHour(from);
  const toHour = new Date(truncHour(opts.to ?? t).getTime() + HOUR);
  const fromIso = fromHour.toISOString();
  const toIso = toHour.toISOString();

  const rows = await deps.db.transaction(async (tx) => {
    await tx
      .delete(clickStatsHourly)
      .where(and(gte(clickStatsHourly.hour, fromHour), lt(clickStatsHourly.hour, toHour)));
    const res = await tx.execute(sql`
      insert into click_stats_hourly
        (id, workspace_id, hour, kind, channel_id, offer_id, post_id, tracked_link_id, invite_link_id, human, bot)
      select gen_random_uuid(), c.workspace_id,
        date_trunc('hour', c.ts at time zone 'UTC') at time zone 'UTC',
        c.kind, coalesce(c.channel_id, tl.channel_id), tl.offer_id, tl.post_id,
        c.tracked_link_id, c.invite_link_id,
        count(*) filter (where not c.is_bot), count(*) filter (where c.is_bot)
      from clicks c
      left join tracked_links tl on tl.id = c.tracked_link_id
      where c.ts >= ${fromIso}::timestamptz and c.ts < ${toIso}::timestamptz
      group by 2, 3, 4, 5, 6, 7, 8, 9
    `);
    return (res as unknown as { count?: number }).count ?? 0;
  });
  await deps.cache.set(ROLLUP_STAMP_KEY, t.toISOString(), 30 * 86_400);
  return { from: fromIso, to: toIso, rows };
}

// ── Período ─────────────────────────────────────────────────────

type Range = { from: Date; to: Date; label: string };
type Periods = { cur: Range; prev: Range; tz: string };

async function workspaceTz(ctx: Ctx) {
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  return ws?.tz ?? "America/Sao_Paulo";
}

export function resolvePeriod(raw: MetricsPeriodQuery, at: Date, tz: string): Omit<Periods, "tz"> {
  const q = MetricsPeriodQuery.parse(raw);
  const shift = (r: Range, ms: number, label: string): Range => ({
    from: new Date(r.from.getTime() - ms),
    to: new Date(r.to.getTime() - ms),
    label,
  });
  switch (q.period) {
    case "today": {
      const cur = { from: localMidnight(at, tz), to: at, label: "Hoje" };
      return { cur, prev: shift(cur, DAY, "Ontem até o mesmo horário") };
    }
    case "yesterday": {
      const today = localMidnight(at, tz);
      const cur = {
        from: localMidnight(new Date(today.getTime() - HOUR), tz),
        to: today,
        label: "Ontem",
      };
      return { cur, prev: shift(cur, cur.to.getTime() - cur.from.getTime(), "Anteontem") };
    }
    case "7d":
    case "30d": {
      const days = q.period === "7d" ? 7 : 30;
      const cur = {
        from: new Date(at.getTime() - days * DAY),
        to: at,
        label: `Últimos ${days} dias`,
      };
      return { cur, prev: shift(cur, days * DAY, `${days} dias anteriores`) };
    }
    case "custom": {
      if (!q.from || !q.to)
        throw new AppError("VALIDATION_ERROR", "Com period=custom, informe 'from' e 'to'.");
      const cur = { from: new Date(q.from), to: new Date(q.to), label: "Período escolhido" };
      const len = cur.to.getTime() - cur.from.getTime();
      if (len <= 0) throw new AppError("VALIDATION_ERROR", "'from' deve ser anterior a 'to'.");
      if (len > MAX_RANGE_DAYS * DAY)
        throw new AppError("VALIDATION_ERROR", `Período máximo de ${MAX_RANGE_DAYS} dias.`);
      return { cur, prev: shift(cur, len, "Período anterior equivalente") };
    }
  }
}

async function periods(ctx: Ctx, raw: MetricsPeriodQuery): Promise<Periods> {
  const tz = await workspaceTz(ctx);
  return { ...resolvePeriod(raw, now(ctx), tz), tz };
}

const iso = (r: Range) => ({ from: r.from.toISOString(), to: r.to.toISOString(), label: r.label });
const pct = (cur: number, prev: number) =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
const ratio = (a: number, b: number, digits = 2) =>
  b > 0 ? Math.round((a / b) * 10 ** digits) / 10 ** digits : null;

// ── Agregados base ──────────────────────────────────────────────

const sentStatuses = ["sent", "deleted"] as const;

function rollupWhere(wsId: string, r: Range, extra: SQL[] = []) {
  return and(
    eq(clickStatsHourly.workspaceId, wsId),
    gte(clickStatsHourly.hour, truncHour(r.from)),
    lt(clickStatsHourly.hour, r.to),
    ...extra,
  );
}

async function totals(ctx: Ctx, r: Range, tz: string) {
  const wsId = ctx.actor.workspaceId;
  const fromDay = localDate(r.from, tz);
  const toDay = localDate(new Date(r.to.getTime() - 1), tz);
  const [[aud], [pub], [clk]] = await Promise.all([
    ctx.db
      .select({
        joins: sql<number>`coalesce(sum(${channelStatsDaily.joins}), 0)::int`,
        leaves: sql<number>`coalesce(sum(${channelStatsDaily.leaves}), 0)::int`,
      })
      .from(channelStatsDaily)
      .innerJoin(channels, eq(channels.id, channelStatsDaily.channelId))
      .where(
        and(
          eq(channels.workspaceId, wsId),
          gte(channelStatsDaily.date, fromDay),
          lte(channelStatsDaily.date, toDay),
        ),
      ),
    ctx.db
      .select({
        sent: sql<number>`count(*) filter (where ${posts.status} in ('sent', 'deleted') and ${posts.sentAt} >= ${r.from.toISOString()}::timestamptz and ${posts.sentAt} < ${r.to.toISOString()}::timestamptz)::int`,
        failed: sql<number>`count(*) filter (where ${posts.status} = 'failed' and ${posts.updatedAt} >= ${r.from.toISOString()}::timestamptz and ${posts.updatedAt} < ${r.to.toISOString()}::timestamptz)::int`,
      })
      .from(posts)
      .where(eq(posts.workspaceId, wsId)),
    ctx.db
      .select({
        link: sql<number>`coalesce(sum(${clickStatsHourly.human}) filter (where ${clickStatsHourly.kind} = 'link'), 0)::int`,
        invite: sql<number>`coalesce(sum(${clickStatsHourly.human}) filter (where ${clickStatsHourly.kind} = 'invite'), 0)::int`,
        bot: sql<number>`coalesce(sum(${clickStatsHourly.bot}), 0)::int`,
      })
      .from(clickStatsHourly)
      .where(rollupWhere(wsId, r)),
  ]);
  return {
    joins: aud?.joins ?? 0,
    leaves: aud?.leaves ?? 0,
    sent: pub?.sent ?? 0,
    failed: pub?.failed ?? 0,
    linkClicks: clk?.link ?? 0,
    inviteClicks: clk?.invite ?? 0,
    botClicks: clk?.bot ?? 0,
  };
}

async function activeChannels(ctx: Ctx) {
  return ctx.db
    .select({
      id: channels.id,
      name: channels.name,
      status: channels.status,
      members: channels.memberCount,
      limit: channels.memberLimit,
    })
    .from(channels)
    .where(and(eq(channels.workspaceId, ctx.actor.workspaceId), ne(channels.status, "archived")));
}

async function channelRows(ctx: Ctx, r: Range, tz: string) {
  const wsId = ctx.actor.workspaceId;
  const [list, sent, clk, daily] = await Promise.all([
    activeChannels(ctx),
    ctx.db
      .select({ id: posts.channelId, n: sql<number>`count(*)::int` })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, wsId),
          inArray(posts.status, [...sentStatuses]),
          gte(posts.sentAt, r.from),
          lt(posts.sentAt, r.to),
        ),
      )
      .groupBy(posts.channelId),
    ctx.db
      .select({
        id: clickStatsHourly.channelId,
        n: sql<number>`coalesce(sum(${clickStatsHourly.human}), 0)::int`,
      })
      .from(clickStatsHourly)
      .where(rollupWhere(wsId, r, [eq(clickStatsHourly.kind, "link")]))
      .groupBy(clickStatsHourly.channelId),
    ctx.db
      .select({
        id: channelStatsDaily.channelId,
        joins: sql<number>`sum(${channelStatsDaily.joins})::int`,
        leaves: sql<number>`sum(${channelStatsDaily.leaves})::int`,
      })
      .from(channelStatsDaily)
      .innerJoin(channels, eq(channels.id, channelStatsDaily.channelId))
      .where(
        and(
          eq(channels.workspaceId, wsId),
          gte(channelStatsDaily.date, localDate(r.from, tz)),
          lte(channelStatsDaily.date, localDate(new Date(r.to.getTime() - 1), tz)),
        ),
      )
      .groupBy(channelStatsDaily.channelId),
  ]);
  const sentBy = new Map(sent.map((s) => [s.id, s.n]));
  const clicksBy = new Map(clk.map((c) => [c.id, c.n]));
  const dailyBy = new Map(daily.map((d) => [d.id, d]));
  return list.map((c) => {
    const postsSent = sentBy.get(c.id) ?? 0;
    const clicksN = clicksBy.get(c.id) ?? 0;
    const d = dailyBy.get(c.id);
    const perPost = ratio(clicksN, postsSent, 1);
    return {
      channel_id: c.id,
      name: c.name,
      status: c.status,
      members: c.members,
      member_limit: c.limit,
      joins: d?.joins ?? 0,
      leaves: d?.leaves ?? 0,
      posts_sent: postsSent,
      clicks: clicksN,
      clicks_per_post: perPost,
      clicks_per_100_members:
        perPost !== null && c.members > 0 ? Math.round((perPost / c.members) * 10_000) / 100 : null,
      leaves_per_post: ratio(d?.leaves ?? 0, postsSent),
    };
  });
}

async function offerRows(ctx: Ctx, r: Range, limit: number) {
  const wsId = ctx.actor.workspaceId;
  const [clk, sent] = await Promise.all([
    ctx.db
      .select({
        id: clickStatsHourly.offerId,
        n: sql<number>`coalesce(sum(${clickStatsHourly.human}), 0)::int`,
      })
      .from(clickStatsHourly)
      .where(rollupWhere(wsId, r, [sql`${clickStatsHourly.offerId} is not null`]))
      .groupBy(clickStatsHourly.offerId),
    ctx.db
      .select({ id: posts.offerId, n: sql<number>`count(*)::int` })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, wsId),
          inArray(posts.status, [...sentStatuses]),
          gte(posts.sentAt, r.from),
          lt(posts.sentAt, r.to),
          sql`${posts.offerId} is not null`,
        ),
      )
      .groupBy(posts.offerId),
  ]);
  const clicksBy = new Map(clk.map((c) => [c.id as string, c.n]));
  const sentBy = new Map(sent.map((s) => [s.id as string, s.n]));
  const ids = [...new Set([...clicksBy.keys(), ...sentBy.keys()])];
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({
      id: offers.id,
      status: offers.status,
      price: offers.price,
      discount: offers.discountPct,
      title: products.title,
      platform: products.platform,
    })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.workspaceId, wsId), inArray(offers.id, ids)));
  return rows
    .map((o) => {
      const postsSent = sentBy.get(o.id) ?? 0;
      const clicksN = clicksBy.get(o.id) ?? 0;
      return {
        offer_id: o.id,
        title: o.title,
        platform: o.platform,
        status: o.status,
        price: o.price,
        discount_pct: o.discount,
        posts_sent: postsSent,
        clicks: clicksN,
        clicks_per_post: ratio(clicksN, postsSent, 1),
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.posts_sent - a.posts_sent)
    .slice(0, limit);
}

/** Cliques atribuídos ao horário (local) em que cada post foi enviado. */
async function hourCells(ctx: Ctx, r: Range, tz: string) {
  const wsId = ctx.actor.workspaceId;
  const fromIso = r.from.toISOString();
  const toIso = r.to.toISOString();
  const res = await ctx.db.execute(sql`
    select extract(dow from p.sent_at at time zone ${tz})::int as weekday,
      extract(hour from p.sent_at at time zone ${tz})::int as hour,
      count(*)::int as posts,
      coalesce(sum(c.clicks), 0)::int as clicks
    from posts p
    left join (
      select post_id, sum(human) as clicks from click_stats_hourly
      where workspace_id = ${wsId} and hour >= ${fromIso}::timestamptz - interval '1 hour'
      group by post_id
    ) c on c.post_id = p.id
    where p.workspace_id = ${wsId} and p.status in ('sent', 'deleted')
      and p.sent_at >= ${fromIso}::timestamptz and p.sent_at < ${toIso}::timestamptz
    group by 1, 2
    order by 1, 2
  `);
  return (res as unknown as { weekday: number; hour: number; posts: number; clicks: number }[]).map(
    (c) => ({ ...c, clicks_per_post: ratio(c.clicks, c.posts, 1) }),
  );
}

async function openAlerts(ctx: Ctx) {
  return ctx.db
    .select({ severity: alerts.severity, message: alerts.message })
    .from(alerts)
    .where(and(eq(alerts.workspaceId, ctx.actor.workspaceId), eq(alerts.status, "open")))
    .orderBy(desc(alerts.openedAt));
}

// ── Casos de uso ────────────────────────────────────────────────

/** Resumo de desempenho do período, com comparação e observações para orientar a ação. */
export async function getPerformanceSummary(
  ctx: Ctx,
  raw: MetricsPeriodQuery = {},
): Promise<PerformanceSummary> {
  requireScope(ctx.actor, "metrics:read");
  const { cur, prev, tz } = await periods(ctx, raw);
  const t = now(ctx);
  const [c, p, chans, offs, hours, openList, [next], stamp] = await Promise.all([
    totals(ctx, cur, tz),
    totals(ctx, prev, tz),
    channelRows(ctx, cur, tz),
    offerRows(ctx, cur, 5),
    hourCells(ctx, cur, tz),
    openAlerts(ctx),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, ctx.actor.workspaceId),
          eq(posts.status, "scheduled"),
          lt(posts.scheduledAt, new Date(t.getTime() + DAY)),
        ),
      ),
    ctx.cache.get(ROLLUP_STAMP_KEY),
  ]);

  const active = chans.filter((ch) => ch.status === "active");
  const membersTotal = active.reduce((s, ch) => s + ch.members, 0);
  const bestHours = hours
    .filter((h) => h.posts >= 2 && h.clicks_per_post !== null)
    .sort((a, b) => (b.clicks_per_post ?? 0) - (a.clicks_per_post ?? 0))
    .slice(0, 3)
    .map((h) => ({
      weekday: h.weekday,
      hour: h.hour,
      posts: h.posts,
      clicks_per_post: h.clicks_per_post ?? 0,
    }));

  const insights: string[] = [];
  if (c.sent === 0)
    insights.push("Nenhum envio no período: confira regras automáticas e janelas de envio.");
  if (c.failed > 0) insights.push(`${c.failed} envio(s) falharam no período. Veja em Publicações.`);
  const clickChange = pct(c.linkClicks, p.linkClicks);
  if (clickChange !== null && clickChange <= -30)
    insights.push(
      `Cliques em ofertas caíram ${Math.abs(clickChange)}% em relação ao período anterior.`,
    );
  if (c.leaves > c.joins && c.leaves >= 5)
    insights.push(
      "Saíram mais pessoas do que entraram: reveja frequência e qualidade das ofertas.",
    );
  for (const ch of active) {
    if (ch.member_limit > 0 && ch.members / ch.member_limit >= 0.9)
      insights.push(
        `Grupo "${ch.name}" está com ${Math.round((ch.members / ch.member_limit) * 100)}% da capacidade: crie o próximo e adicione ao convite rotativo.`,
      );
  }
  const totalClicks = c.linkClicks + c.inviteClicks + c.botClicks;
  if (totalClicks >= 20 && c.botClicks / totalClicks > 0.3)
    insights.push(
      "Mais de 30% dos cliques parecem robôs (pré-visualizações de link). Eles não entram nas métricas.",
    );
  const best = bestHours[0];
  if (best)
    insights.push(
      `Melhor horário até agora: ${WEEKDAYS[best.weekday]} às ${best.hour}h (${best.clicks_per_post} cliques por envio).`,
    );

  return {
    period: iso(cur),
    previous_period: iso(prev),
    timezone: tz,
    audience: {
      members_total: membersTotal,
      channels_active: active.length,
      joins: c.joins,
      leaves: c.leaves,
      net_growth: c.joins - c.leaves,
      joins_change_pct: pct(c.joins, p.joins),
    },
    publishing: {
      posts_sent: c.sent,
      posts_failed: c.failed,
      scheduled_next_24h: next?.n ?? 0,
      posts_sent_change_pct: pct(c.sent, p.sent),
    },
    clicks: {
      offer_clicks: c.linkClicks,
      invite_clicks: c.inviteClicks,
      bot_clicks: c.botClicks,
      clicks_per_post: ratio(c.linkClicks, c.sent, 1),
      offer_clicks_change_pct: clickChange,
    },
    top_channels: [...active]
      .sort((a, b) => b.clicks - a.clicks || b.members - a.members)
      .slice(0, 5)
      .map((ch) => ({
        channel_id: ch.channel_id,
        name: ch.name,
        members: ch.members,
        posts_sent: ch.posts_sent,
        clicks: ch.clicks,
        clicks_per_post: ch.clicks_per_post,
      })),
    top_offers: offs.map((o) => ({
      offer_id: o.offer_id,
      title: o.title,
      platform: o.platform,
      posts_sent: o.posts_sent,
      clicks: o.clicks,
    })),
    best_hours: bestHours,
    revenue: null,
    alerts: openList,
    insights,
    data_freshness: stamp ?? t.toISOString(),
  };
}

export const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Referências internas iniciais. Ajuste conforme a operação acumular histórico. */
const BENCHMARKS = { joins: 0.4, retained: 0.7, offer_clicks: 0.03 } as const;

const FUNNEL_HINTS: Record<keyof typeof BENCHMARKS, string> = {
  joins:
    "Poucos cliques no convite viram entrada: revise a página/chamada do convite e se o grupo da vez não está cheio.",
  retained:
    "Muita gente sai depois de entrar: reduza a frequência, melhore a curadoria e fixe uma mensagem de boas-vindas.",
  offer_clicks:
    "Membros clicam pouco nas ofertas: teste horários (veja o mapa de horários), cards com preço e ofertas com mais desconto.",
};

/** Funil parcial: cliques no convite → entradas → retidos → cliques em ofertas → (pedidos). */
export async function getFunnel(ctx: Ctx, raw: MetricsPeriodQuery = {}): Promise<Funnel> {
  requireScope(ctx.actor, "metrics:read");
  const { cur, prev, tz } = await periods(ctx, raw);
  const [c, p, chans] = await Promise.all([
    totals(ctx, cur, tz),
    totals(ctx, prev, tz),
    activeChannels(ctx),
  ]);
  const members = chans.filter((ch) => ch.status === "active").reduce((s, ch) => s + ch.members, 0);
  const days = Math.max(1 / 24, (cur.to.getTime() - cur.from.getTime()) / DAY);
  const retained = (x: typeof c) => Math.max(0, x.joins - x.leaves);
  const perMemberDay =
    members > 0 ? Math.round((c.linkClicks / members / days) * 1000) / 1000 : null;

  const stages: Funnel["stages"] = [
    {
      key: "invite_clicks",
      label: "Cliques no convite",
      value: c.inviteClicks,
      previous: p.inviteClicks,
      change_pct: pct(c.inviteClicks, p.inviteClicks),
      rate: null,
      benchmark: null,
      note: "Cliques humanos nos links de convite rotativo.",
    },
    {
      key: "joins",
      label: "Entradas nos grupos",
      value: c.joins,
      previous: p.joins,
      change_pct: pct(c.joins, p.joins),
      rate: ratio(c.joins, c.inviteClicks),
      benchmark: BENCHMARKS.joins,
      note: "Inclui quem entrou sem passar pelo convite rastreado (taxa pode passar de 100%).",
    },
    {
      key: "retained",
      label: "Ficaram (entradas − saídas)",
      value: retained(c),
      previous: retained(p),
      change_pct: pct(retained(c), retained(p)),
      rate: ratio(retained(c), c.joins),
      benchmark: BENCHMARKS.retained,
      note: null,
    },
    {
      key: "offer_clicks",
      label: "Cliques em ofertas",
      value: c.linkClicks,
      previous: p.linkClicks,
      change_pct: pct(c.linkClicks, p.linkClicks),
      rate: perMemberDay,
      benchmark: BENCHMARKS.offer_clicks,
      note: "Taxa = cliques por membro por dia (base: membros atuais dos grupos ativos).",
    },
    {
      key: "orders",
      label: "Pedidos e comissão",
      value: null,
      previous: null,
      change_pct: null,
      rate: null,
      benchmark: null,
      note: "Chega com o módulo Financeiro (importação de comissões).",
    },
  ];

  let bottleneck: Funnel["bottleneck"] = null;
  let worst = 1;
  for (const s of stages) {
    if (s.rate === null || s.benchmark === null) continue;
    if (s.key === "joins" && c.inviteClicks < 20) continue; // pouca amostra
    if (s.key === "retained" && c.joins < 10) continue;
    const score = s.rate / s.benchmark;
    if (score < worst) {
      worst = score;
      const k = s.key as keyof typeof BENCHMARKS;
      bottleneck = { key: s.key, label: s.label, hint: FUNNEL_HINTS[k] };
    }
  }
  return { period: iso(cur), stages, bottleneck };
}

/** Detalhamento por grupo, por oferta ou por horário de envio. */
export async function getMetricsBreakdown(
  ctx: Ctx,
  raw: MetricsBreakdownQuery,
): Promise<MetricsBreakdown> {
  requireScope(ctx.actor, "metrics:read");
  const q = MetricsBreakdownQuery.parse(raw);
  const { cur, tz } = await periods(ctx, q);
  const base = { period: iso(cur), view: q.view };
  if (q.view === "channels") {
    const rows = await channelRows(ctx, cur, tz);
    return {
      ...base,
      channels: rows.sort((a, b) => b.clicks - a.clicks || b.members - a.members).slice(0, q.limit),
    };
  }
  if (q.view === "offers") return { ...base, offers: await offerRows(ctx, cur, q.limit) };
  return { ...base, hours: await hourCells(ctx, cur, tz) };
}
