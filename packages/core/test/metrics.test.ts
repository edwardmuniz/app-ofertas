import { fakeAffiliateControls, fakeMessagingControls } from "@ofertas/connectors";
import {
  alerts,
  channelStatsDaily,
  clicks,
  inviteLinks,
  limits,
  messagingAccounts,
  posts,
} from "@ofertas/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AlertNotification,
  type Ctx,
  connectAffiliateAccount,
  createMessagingAccount,
  type Deps,
  getConnectionState,
  getFunnel,
  getMetricsBreakdown,
  getOverview,
  getPerformanceSummary,
  getPublicStatus,
  getSeasonalCalendar,
  getSystemStatus,
  listAlerts,
  localDate,
  recordWorkerHeartbeat,
  resolvePeriod,
  resolveSession,
  rollupClicks,
  runHealthChecks,
  runPublisher,
  saveOffer,
  schedulePosts,
  searchOffers,
  seasonalEvents,
  updatePreferences,
  upsertSegment,
} from "../src";
import { createOwner, importAllGroups, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});
afterEach(() => {
  fakeAffiliateControls.reset();
  fakeMessagingControls.reset();
});

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

async function setup() {
  await deps.db.update(posts).set({ status: "canceled" }).where(eq(posts.status, "scheduled"));
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  const ctx: Ctx = { ...deps, actor: r.actor };
  await deps.db
    .insert(limits)
    .values([{ workspaceId: ctx.actor.workspaceId, key: "posts.jitter_seconds", value: 0 }]);
  await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee", mode: "fake" });
  const account = done(await createMessagingAccount(ctx, { label: "Número", provider: "fake" }));
  await getConnectionState(ctx, account.id);
  const synced = await importAllGroups(ctx, account.id);
  return { ctx, account, channels: synced.channels };
}

/** Publica uma oferta num grupo e devolve o post enviado. */
async function sendOne(ctx: Ctx, channelId: string) {
  const { items } = await searchOffers(ctx, { keyword: "air fryer", limit: 1 });
  const offer = done(await saveOffer(ctx, { product_id: items[0]?.product_id ?? "" }));
  done(
    await schedulePosts(ctx, {
      offer_ids: [offer.id],
      channel_ids: [channelId],
      at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  await runPublisher(deps);
  const [post] = await deps.db
    .select()
    .from(posts)
    .where(and(eq(posts.workspaceId, ctx.actor.workspaceId), eq(posts.status, "sent")));
  if (!post?.trackedLinkId) throw new Error("post não enviado");
  return { offer, post };
}

async function addClicks(
  ctx: Ctx,
  n: number,
  v: { trackedLinkId?: string; inviteLinkId?: string; channelId?: string; isBot?: boolean },
) {
  await deps.db.insert(clicks).values(
    Array.from({ length: n }, (_, i) => ({
      workspaceId: ctx.actor.workspaceId,
      kind: v.inviteLinkId ? ("invite" as const) : ("link" as const),
      trackedLinkId: v.trackedLinkId,
      inviteLinkId: v.inviteLinkId,
      channelId: v.channelId,
      ipHash: `ip-${i}-${Math.random()}`,
      isBot: v.isBot ?? false,
      outcome: "redirect" as const,
    })),
  );
}

describe("métricas", () => {
  it("consolida cliques e resume o período por grupo, oferta e horário", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer, post } = await sendOne(ctx, ch.id);
    await addClicks(ctx, 6, { trackedLinkId: post.trackedLinkId ?? "" });
    await addClicks(ctx, 2, { trackedLinkId: post.trackedLinkId ?? "", isBot: true });
    const [invite] = await deps.db
      .insert(inviteLinks)
      .values({
        workspaceId: ctx.actor.workspaceId,
        name: "Convite",
        slug: `c${Date.now()}`,
        segmentId: done(await upsertSegment(ctx, { name: "seg" })).id,
      })
      .returning();
    await addClicks(ctx, 10, { inviteLinkId: invite?.id, channelId: ch.id });
    await deps.db
      .insert(channelStatsDaily)
      .values({
        channelId: ch.id,
        date: localDate(new Date(), "America/Sao_Paulo"),
        joins: 5,
        leaves: 1,
      })
      .onConflictDoUpdate({
        target: [channelStatsDaily.channelId, channelStatsDaily.date],
        set: { joins: 5, leaves: 1 },
      });

    await rollupClicks(deps);
    // Rodar de novo não duplica.
    await rollupClicks(deps);

    const s = await getPerformanceSummary(ctx, { period: "today" });
    expect(s.publishing.posts_sent).toBe(1);
    expect(s.clicks).toMatchObject({ offer_clicks: 6, invite_clicks: 10, bot_clicks: 2 });
    expect(s.clicks.clicks_per_post).toBe(6);
    expect(s.audience).toMatchObject({ joins: 5, leaves: 1, net_growth: 4, channels_active: 3 });
    expect(s.top_offers[0]).toMatchObject({ offer_id: offer.id, clicks: 6, posts_sent: 1 });
    expect(s.top_channels[0]).toMatchObject({ channel_id: ch.id, clicks: 6 });
    expect(s.revenue).toBeNull();

    const byChannel = await getMetricsBreakdown(ctx, { view: "channels", period: "today" });
    const row = byChannel.channels?.find((c) => c.channel_id === ch.id);
    expect(row).toMatchObject({ posts_sent: 1, clicks: 6, joins: 5, leaves: 1 });

    const byHour = await getMetricsBreakdown(ctx, { view: "hours", period: "today" });
    expect(byHour.hours).toHaveLength(1);
    expect(byHour.hours?.[0]).toMatchObject({ posts: 1, clicks: 6, clicks_per_post: 6 });

    const funnel = await getFunnel(ctx, { period: "today" });
    const stage = (k: string) => funnel.stages.find((x) => x.key === k);
    expect(stage("invite_clicks")?.value).toBe(10);
    expect(stage("joins")).toMatchObject({ value: 5, rate: 0.5 });
    expect(stage("retained")?.value).toBe(4);
    expect(stage("orders")?.value).toBeNull();
  });

  it("isola workspaces e exige escopo metrics:read", async () => {
    const { ctx } = await setup();
    const s = await getPerformanceSummary(ctx, { period: "30d" });
    expect(s.clicks.offer_clicks).toBe(0);
    expect(s.insights.join(" ")).toContain("Nenhum envio");
    const noScope: Ctx = { ...ctx, actor: { ...ctx.actor, scopes: new Set(["offers:read"]) } };
    await expect(getPerformanceSummary(noScope)).rejects.toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });

  it("calcula períodos no fuso do workspace", () => {
    const at = new Date("2026-11-27T15:00:00Z"); // 12:00 em São Paulo
    const today = resolvePeriod({ period: "today" }, at, "America/Sao_Paulo");
    expect(today.cur.from.toISOString()).toBe("2026-11-27T03:00:00.000Z");
    const y = resolvePeriod({ period: "yesterday" }, at, "America/Sao_Paulo");
    expect(y.cur.from.toISOString()).toBe("2026-11-26T03:00:00.000Z");
    expect(y.cur.to.toISOString()).toBe("2026-11-27T03:00:00.000Z");
    expect(() => resolvePeriod({ period: "custom" }, at, "UTC")).toThrow(/from/);
  });
});

describe("alertas", () => {
  it("abre alerta quando o número cai, notifica e resolve quando volta", async () => {
    const { ctx, account } = await setup();
    const sent: AlertNotification[] = [];
    const d: Deps = { ...deps, notify: async (_url, p) => void sent.push(p) };
    await updatePreferences(ctx, { alert_webhook_url: "https://hooks.example.com/x" });

    await deps.db
      .update(messagingAccounts)
      .set({ status: "disconnected" })
      .where(eq(messagingAccounts.id, account.id));
    await runHealthChecks(d);
    await runHealthChecks(d); // não duplica
    const open = await listAlerts(ctx);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "messaging_down", severity: "critical" });
    expect(sent.filter((p) => p.alert.status === "open")).toHaveLength(1);
    expect(sent[0]?.text).toContain("desconectado");

    const status = await getSystemStatus(ctx);
    expect(status.ok).toBe(false);
    expect((await getOverview(ctx)).alerts.some((a) => a.message.includes("desconectado"))).toBe(
      true,
    );

    await deps.db
      .update(messagingAccounts)
      .set({ status: "connected" })
      .where(eq(messagingAccounts.id, account.id));
    await runHealthChecks(d);
    expect(await listAlerts(ctx)).toHaveLength(0);
    expect(sent.at(-1)?.alert.status).toBe("resolved");
    const [row] = await deps.db.select().from(alerts).where(eq(alerts.subject, account.id));
    expect(row?.status).toBe("resolved");
  });

  it("detecta fila parada", async () => {
    const { ctx, channels: chs } = await setup();
    await deps.db.insert(posts).values({
      workspaceId: ctx.actor.workspaceId,
      channelId: chs[0]?.id ?? "",
      customText: "oi",
      scheduledAt: new Date(Date.now() - 30 * 60_000),
      createdBy: "teste",
    });
    await runHealthChecks(deps);
    const open = await listAlerts(ctx);
    expect(open.map((a) => a.kind)).toContain("queue_stalled");
    await deps.db
      .update(posts)
      .set({ status: "canceled" })
      .where(eq(posts.workspaceId, ctx.actor.workspaceId));
    await runHealthChecks(deps);
    expect((await listAlerts(ctx)).map((a) => a.kind)).not.toContain("queue_stalled");
  });

  it("status público reflete o worker", async () => {
    await deps.cache.del("worker:heartbeat");
    expect(await getPublicStatus(deps)).toMatchObject({ db: true, worker: false, ok: false });
    await recordWorkerHeartbeat(deps);
    expect(await getPublicStatus(deps)).toMatchObject({ db: true, worker: true, ok: true });
  });
});

describe("calendário sazonal", () => {
  it("calcula datas móveis e fases", () => {
    const ev = seasonalEvents("2026-10-30", 60);
    const bf = ev.find((e) => e.key === "black_friday");
    expect(bf).toMatchObject({ date: "2026-11-27", days_until: 28, phase: "prepare" });
    expect(ev.find((e) => e.key === "cyber_monday")?.date).toBe("2026-11-30");
    expect(ev[0]?.key).toBe("11_11");
    const next = seasonalEvents("2027-01-01", 365);
    expect(next.find((e) => e.key === "dia_das_maes")?.date).toBe("2027-05-09");
    expect(next.find((e) => e.key === "dia_dos_pais")?.date).toBe("2027-08-08");
  });

  it("exige growth:read", async () => {
    const { ctx } = await setup();
    const cal = await getSeasonalCalendar(ctx, { days: 400 });
    expect(cal.events.length).toBeGreaterThan(5);
    const noScope: Ctx = { ...ctx, actor: { ...ctx.actor, scopes: new Set(["offers:read"]) } };
    await expect(getSeasonalCalendar(noScope)).rejects.toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });
});
