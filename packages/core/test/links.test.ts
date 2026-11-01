import { events } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClickBuffer,
  type Ctx,
  createInviteLink,
  createTrackedLink,
  type Deps,
  decideLink,
  getLinkStats,
  isBotUserAgent,
  listChannels,
  listInviteLinks,
  listTrackedLinks,
  resolveInvite,
  resolveLink,
  resolveSession,
  updateChannel,
  updateTrackedLink,
  upsertSegment,
} from "../src";
import { createOwner, insertChannel, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});

async function ownerCtx(): Promise<Ctx> {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão inválida");
  return { ...deps, actor: r.actor };
}

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

async function segmentWithGroups(ctx: Ctx, groups: { name: string; members: number }[]) {
  const seg = done(await upsertSegment(ctx, { name: `seg-${Math.random()}` }));
  const channels = [];
  for (const g of groups) {
    channels.push(
      await insertChannel(ctx, ctx.actor.workspaceId, {
        name: g.name,
        invite_url: `https://chat.whatsapp.com/${g.name}`,
        member_count: g.members,
        member_limit: 100,
        segment_ids: [seg.id],
      }),
    );
  }
  return { seg, channels };
}

describe("canais e segmentos", () => {
  it("edita status, limite e segmentos do canal", async () => {
    const ctx = await ownerCtx();
    const seg = done(await upsertSegment(ctx, { name: "tech" }));
    const ch = await insertChannel(ctx, ctx.actor.workspaceId, { name: "Tech #1" });
    const edited = done(
      await updateChannel(ctx, ch.id, {
        member_limit: 500,
        segment_ids: [seg.id],
        status: "paused",
      }),
    );
    expect(edited).toMatchObject({
      name: "Tech #1",
      member_limit: 500,
      status: "paused",
      segment_ids: [seg.id],
    });
    expect(await listChannels(ctx)).toHaveLength(1);
  });

  it("nome de segmento duplicado dá CONFLICT", async () => {
    const ctx = await ownerCtx();
    await upsertSegment(ctx, { name: "casa" });
    await expect(upsertSegment(ctx, { name: "casa" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("segmento de outro workspace não é aceito", async () => {
    const a = await ownerCtx();
    const b = await ownerCtx();
    const segA = done(await upsertSegment(a, { name: "x" }));
    const chB = await insertChannel(b, b.actor.workspaceId, { name: "g" });
    await expect(updateChannel(b, chB.id, { segment_ids: [segA.id] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("links rastreados", () => {
  it("gera slug, aceita slug próprio e recusa reservado/duplicado", async () => {
    const ctx = await ownerCtx();
    const a = done(await createTrackedLink(ctx, { destination_url: "https://shopee.com.br/a" }));
    expect(a.slug).toHaveLength(7);
    expect(a.short_url).toBe(`http://go.test/${a.slug}`);

    const b = done(
      await createTrackedLink(ctx, { destination_url: "https://x.com", slug: "Promo-BF" }),
    );
    expect(b.slug).toBe("promo-bf");

    await expect(
      createTrackedLink(ctx, { destination_url: "https://x.com", slug: "promo-bf" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      createTrackedLink(ctx, { destination_url: "https://x.com", slug: "entrar" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dry_run não cria link", async () => {
    const ctx = await ownerCtx();
    const res = await createTrackedLink(
      ctx,
      { destination_url: "https://x.com" },
      { dryRun: true },
    );
    expect(res.status).toBe("dry_run");
    expect((await listTrackedLinks(ctx)).items).toHaveLength(0);
  });

  it("trocar destino invalida o cache do redirecionador", async () => {
    const ctx = await ownerCtx();
    const link = done(await createTrackedLink(ctx, { destination_url: "https://a.com/1" }));
    expect((await resolveLink(deps, link.slug))?.destination).toBe("https://a.com/1");

    await updateTrackedLink(ctx, { id: link.id, destination_url: "https://a.com/2" });
    expect((await resolveLink(deps, link.slug))?.destination).toBe("https://a.com/2");

    const [evt] = await deps.db
      .select()
      .from(events)
      .where(eq(events.type, "link.destination_changed"));
    expect(evt?.payload).toMatchObject({ from: "https://a.com/1", to: "https://a.com/2" });
  });

  it("slug inexistente fica em cache negativo e some quando o link é criado", async () => {
    const ctx = await ownerCtx();
    expect(await resolveLink(deps, "novo-link")).toBeNull();
    await createTrackedLink(ctx, { destination_url: "https://a.com", slug: "novo-link" });
    expect(await resolveLink(deps, "novo-link")).not.toBeNull();
  });

  it("decideLink: ativo, inativo com fallback, expirado sem fallback", () => {
    const base = {
      id: "1",
      workspaceId: "w",
      destination: "https://d.com",
      fallback: null,
      active: true,
      expiresAt: null,
      channelId: null,
    };
    const at = new Date("2026-11-01T00:00:00Z");
    expect(decideLink(base, at)).toEqual({ outcome: "redirect", url: "https://d.com" });
    expect(decideLink({ ...base, active: false, fallback: "https://f.com" }, at)).toEqual({
      outcome: "fallback",
      url: "https://f.com",
    });
    expect(decideLink({ ...base, expiresAt: "2026-10-01T00:00:00Z" }, at)).toEqual({
      outcome: "gone",
      url: null,
    });
  });

  it("lista com filtros e paginação", async () => {
    const ctx = await ownerCtx();
    for (let i = 0; i < 3; i++) {
      await createTrackedLink(ctx, {
        destination_url: "https://x.com",
        title: `Oferta ${i}`,
        source: i === 0 ? "ig" : "wa",
      });
    }
    expect((await listTrackedLinks(ctx, { source: "wa" })).items).toHaveLength(2);
    const p1 = await listTrackedLinks(ctx, { limit: 2 });
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await listTrackedLinks(ctx, { limit: 2, cursor: p1.next_cursor ?? undefined });
    expect(p2.items).toHaveLength(1);
    expect((await listTrackedLinks(ctx, { q: "oferta 1" })).items).toHaveLength(1);
  });
});

describe("convite rotativo", () => {
  it("fill_first enche o grupo mais antigo e respeita a reserva", async () => {
    const ctx = await ownerCtx();
    const { seg, channels } = await segmentWithGroups(ctx, [
      { name: "g1", members: 95 }, // 100 - reserva 10 = 90 → cheio
      { name: "g2", members: 10 },
      { name: "g3", members: 0 },
    ]);
    const inv = done(await createInviteLink(ctx, { segment_id: seg.id, name: "Tech" }));
    expect(inv.url).toBe(`http://go.test/entrar/${inv.slug}`);
    expect(inv.slug).toBe(inv.slug.toLowerCase());
    expect(inv.capacity).toMatchObject({ channels: 2, available_slots: 80 + 90 });
    expect(inv.capacity.current_channel?.id).toBe(channels[1]?.id);

    const r = await resolveInvite(deps, inv.slug);
    expect(r.kind === "redirect" && r.channel.id).toBe(channels[1]?.id);
  });

  it("round_robin alterna entre grupos com vaga", async () => {
    const ctx = await ownerCtx();
    const { seg } = await segmentWithGroups(ctx, [
      { name: "a", members: 0 },
      { name: "b", members: 0 },
    ]);
    const inv = done(
      await createInviteLink(ctx, { segment_id: seg.id, name: "RR", strategy: "round_robin" }),
    );
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const r = await resolveInvite(deps, inv.slug);
      if (r.kind === "redirect") picks.push(r.channel.name);
    }
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });

  it("todos lotados: retorna full e emite segment.full uma vez", async () => {
    const ctx = await ownerCtx();
    const { seg } = await segmentWithGroups(ctx, [{ name: "lotado", members: 100 }]);
    const inv = done(
      await createInviteLink(ctx, {
        segment_id: seg.id,
        name: "Cheio",
        slug: "cheio",
        fallback_url: "https://instagram.com/loja",
      }),
    );
    expect((await resolveInvite(deps, "CHEIO")).kind).toBe("full");
    await resolveInvite(deps, "cheio");
    const evts = await deps.db.select().from(events).where(eq(events.type, "segment.full"));
    expect(
      evts.filter((e) => (e.payload as { invite_link_id: string }).invite_link_id === inv.id),
    ).toHaveLength(1);
    expect((await listInviteLinks(ctx))[0]?.capacity.channels).toBe(0);
  });
});

describe("cliques e estatísticas", () => {
  it("detecta robôs de prévia sem confundir navegador do Instagram", () => {
    expect(isBotUserAgent("WhatsApp/2.24.1 A")).toBe(true);
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0",
      ),
    ).toBe(false);
    expect(
      isBotUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile"),
    ).toBe(false);
  });

  it("agrega humanos, únicos e robôs por dia, link e origem", async () => {
    const ctx = await ownerCtx();
    const wa = done(
      await createTrackedLink(ctx, { destination_url: "https://a.com", source: "wa" }),
    );
    const ig = done(
      await createTrackedLink(ctx, { destination_url: "https://b.com", source: "ig" }),
    );

    const buf = new ClickBuffer(deps.db);
    const ts = new Date();
    const click = (linkId: string, ip: string, isBot = false) =>
      buf.push({
        workspaceId: ctx.actor.workspaceId,
        kind: "link",
        trackedLinkId: linkId,
        ipHash: ip,
        isBot,
        outcome: "redirect",
        ts,
      });
    click(wa.id, "ip1");
    click(wa.id, "ip1");
    click(wa.id, "ip2");
    click(wa.id, "bot", true);
    click(ig.id, "ip3");
    await buf.close();

    const total = await getLinkStats(ctx, { group_by: "none" });
    expect(total.totals).toEqual({ human: 4, unique: 3, bot: 1 });

    const byLink = await getLinkStats(ctx, { group_by: "link" });
    expect(byLink.rows[0]).toMatchObject({ key: wa.id, human: 3, unique: 2, bot: 1 });

    const bySource = await getLinkStats(ctx, { group_by: "source", source: "ig" });
    expect(bySource.rows).toEqual([{ key: "ig", label: "ig", human: 1, unique: 1, bot: 0 }]);

    const byDay = await getLinkStats(ctx, { group_by: "day" });
    expect(byDay.rows.length).toBeGreaterThanOrEqual(7);
    expect(byDay.rows.reduce((s, r) => s + r.human, 0)).toBe(4);
  });

  it("valida período", async () => {
    const ctx = await ownerCtx();
    await expect(
      getLinkStats(ctx, { from: "2026-10-10T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
