import { type LinkStats, LinkStatsQuery } from "@ofertas/contracts";
import { channels, clicks, inviteLinks, trackedLinks, workspaces } from "@ofertas/db";
import { and, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, now } from "./context";
import { AppError } from "./errors";

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

const human = sql<number>`count(*) filter (where not ${clicks.isBot})::int`;
const unique = sql<number>`count(distinct ${clicks.ipHash}) filter (where not ${clicks.isBot})::int`;
const bot = sql<number>`count(*) filter (where ${clicks.isBot})::int`;

/** Datas locais (YYYY-MM-DD) entre from e to no fuso informado. */
function localDays(from: Date, to: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone });
  const days = new Set<string>();
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS / 4) days.add(fmt.format(t));
  days.add(fmt.format(new Date(to.getTime() - 1)));
  return [...days].sort();
}

/** Cliques de links e convites: totais e quebra por dia, link, convite, canal ou origem. */
export async function getLinkStats(
  ctx: Ctx,
  raw: Partial<LinkStatsQuery> = {},
): Promise<LinkStats> {
  requireScope(ctx.actor, "links:read");
  const q = LinkStatsQuery.parse(raw);
  const to = q.to ? new Date(q.to) : now(ctx);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY_MS);
  if (from >= to) throw new AppError("VALIDATION_ERROR", "'from' deve ser anterior a 'to'.");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new AppError("VALIDATION_ERROR", `Período máximo de ${MAX_RANGE_DAYS} dias.`);
  }

  const wsId = ctx.actor.workspaceId;
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, wsId));
  const tz = ws?.tz ?? "America/Sao_Paulo";

  const conds: SQL[] = [eq(clicks.workspaceId, wsId), gte(clicks.ts, from), lt(clicks.ts, to)];
  if (q.link_id) conds.push(eq(clicks.trackedLinkId, q.link_id));
  if (q.invite_link_id) conds.push(eq(clicks.inviteLinkId, q.invite_link_id));
  if (q.channel_id) conds.push(eq(clicks.channelId, q.channel_id));
  if (q.campaign) conds.push(eq(trackedLinks.campaign, q.campaign));
  if (q.source) conds.push(eq(trackedLinks.source, q.source));
  const where = and(...conds);

  const base = () =>
    ctx.db
      .select({ human, unique, bot })
      .from(clicks)
      .leftJoin(trackedLinks, eq(trackedLinks.id, clicks.trackedLinkId))
      .where(where);

  const [totals] = await base();
  const period = { from: from.toISOString(), to: to.toISOString() };
  const zero = { human: 0, unique: 0, bot: 0 };
  if (q.group_by === "none") return { period, totals: totals ?? zero, rows: [] };

  const keyExpr: Record<Exclude<typeof q.group_by, "none">, SQL> = {
    day: sql`to_char(${clicks.ts} at time zone ${tz}, 'YYYY-MM-DD')`,
    link: sql`${clicks.trackedLinkId}::text`,
    invite: sql`${clicks.inviteLinkId}::text`,
    channel: sql`${clicks.channelId}::text`,
    source: sql`${trackedLinks.source}`,
  };
  const key = keyExpr[q.group_by];
  const grouped = await ctx.db
    .select({ key: sql<string | null>`${key}`, human, unique, bot })
    .from(clicks)
    .leftJoin(trackedLinks, eq(trackedLinks.id, clicks.trackedLinkId))
    .where(where)
    // por posição: o fuso é parâmetro e repetir a expressão geraria parâmetros distintos
    .groupBy(sql`1`)
    .orderBy(q.group_by === "day" ? sql`1` : sql`2 desc`)
    .limit(q.group_by === "day" ? MAX_RANGE_DAYS + 2 : 100);

  const labels = await labelsFor(
    ctx,
    q.group_by,
    grouped.map((g) => g.key),
  );
  let rows = grouped.map((g) => ({ ...g, label: g.key ? (labels.get(g.key) ?? g.key) : null }));

  if (q.group_by === "day") {
    const byDay = new Map(rows.map((r) => [r.key, r]));
    rows = localDays(from, to, tz).map((d) => byDay.get(d) ?? { key: d, label: d, ...zero });
  }
  return { period, totals: totals ?? zero, rows };
}

async function labelsFor(ctx: Ctx, groupBy: string, keys: (string | null)[]) {
  const ids = keys.filter((k): k is string => Boolean(k));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  if (groupBy === "link") {
    const rows = await ctx.db
      .select({ id: trackedLinks.id, slug: trackedLinks.slug, title: trackedLinks.title })
      .from(trackedLinks)
      .where(inArray(trackedLinks.id, ids));
    for (const r of rows) map.set(r.id, r.title ? `${r.title} (${r.slug})` : r.slug);
  } else if (groupBy === "invite") {
    const rows = await ctx.db
      .select({ id: inviteLinks.id, name: inviteLinks.name })
      .from(inviteLinks)
      .where(inArray(inviteLinks.id, ids));
    for (const r of rows) map.set(r.id, r.name);
  } else if (groupBy === "channel") {
    const rows = await ctx.db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(inArray(channels.id, ids));
    for (const r of rows) map.set(r.id, r.name);
  }
  return map;
}
