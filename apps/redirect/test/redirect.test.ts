import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import {
  ClickBuffer,
  createInviteLink,
  createTrackedLink,
  type Deps,
  getAudienceStats,
  getLinkStats,
  MemoryCache,
  MemoryCounterStore,
  MemoryStorage,
  resolveSession,
  SecretBox,
  signup,
  updateStorefront,
  updateTrackedLink,
  upsertSegment,
} from "@ofertas/core";
import { channelSegments, channels, createDb, offers, products, runMigrations } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRedirectApp } from "../src/app";

const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile";

let app: FastifyInstance;
let deps: Deps;
let clicks: ClickBuffer;
let closeDb: () => Promise<void>;
let ctx: Parameters<typeof createTrackedLink>[0];

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(res.status);
  return res.result;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST não definida");
  await runMigrations(url);
  const conn = createDb(url, { max: 5 });
  closeDb = conn.close;
  await resetDb(conn.db);
  deps = {
    db: conn.db,
    counters: new MemoryCounterStore(),
    cache: new MemoryCache(),
    redirectBaseUrl: "http://go.test",
    secrets: new SecretBox(Buffer.alloc(32, 1).toString("base64")),
    affiliateConnectors: defaultAffiliateConnectorFactory,
    messaging: createMessagingProviderFactory({}),
    messagingWebhookUrl: "http://api.test/webhooks/whatsapp",
    storage: new MemoryStorage(),
    fetchMedia: async () => {
      throw new Error("sem rede nos testes");
    },
    fetchPage: async () => {
      throw new Error("sem rede nos testes");
    },
    openStream: async () => {
      throw new Error("sem rede nos testes");
    },
    publicApiUrl: "http://localhost",
  };
  clicks = new ClickBuffer(conn.db, { flushMs: 60_000 });
  app = await buildRedirectApp({ deps, clicks, ipSalt: "salt-de-teste-123456" });

  const s = await signup(
    deps,
    { name: "D", email: "d@teste.com", password: "12345678", workspace_name: "L" },
    { allowSignup: true },
  );
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  ctx = { ...deps, actor: r.actor };
});

afterAll(async () => {
  await app.close();
  await clicks.close();
  await closeDb();
});

describe("links", () => {
  it("redireciona com 302, sem cache, e conta clique humano", async () => {
    const link = done(
      await createTrackedLink(ctx, { destination_url: "https://shopee.com.br/p/1" }),
    );
    const res = await app.inject({
      url: `/${link.slug}?src=ig_bio&utm_source=ig&lixo=1`,
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://shopee.com.br/p/1");
    expect(res.headers["cache-control"]).toBe("no-store");

    await app.inject({ url: `/${link.slug}`, headers: { "user-agent": "WhatsApp/2.24 A" } });
    await clicks.flush();

    const stats = await getLinkStats(ctx, { link_id: link.id, group_by: "none" });
    expect(stats.totals).toEqual({ human: 1, unique: 1, bot: 1 });
  });

  it("slug inexistente → 404 em HTML", async () => {
    const res = await app.inject({ url: "/naoexiste" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("link desativado vai para o fallback; sem fallback → 410", async () => {
    const a = done(
      await createTrackedLink(ctx, {
        destination_url: "https://a.com",
        fallback_url: "https://loja.com/ofertas",
      }),
    );
    const b = done(await createTrackedLink(ctx, { destination_url: "https://b.com" }));
    await updateTrackedLink(ctx, { id: a.id, active: false });
    await updateTrackedLink(ctx, { id: b.id, active: false });

    const ra = await app.inject({ url: `/${a.slug}`, headers: { "user-agent": BROWSER_UA } });
    expect(ra.headers.location).toBe("https://loja.com/ofertas");
    const rb = await app.inject({ url: `/${b.slug}`, headers: { "user-agent": BROWSER_UA } });
    expect(rb.statusCode).toBe(410);
  });

  it("robots.txt bloqueia indexação", async () => {
    const res = await app.inject({ url: "/robots.txt" });
    expect(res.body).toContain("Disallow: /");
  });
});

/** Grupo direto no banco (não há cadastro manual de canais). */
async function insertChannel(
  workspaceId: string,
  v: { name: string; inviteUrl: string; memberCount?: number; segmentId: string },
) {
  const [row] = await deps.db
    .insert(channels)
    .values({ workspaceId, name: v.name, inviteUrl: v.inviteUrl, memberCount: v.memberCount ?? 0 })
    .returning();
  if (!row) throw new Error("canal");
  await deps.db.insert(channelSegments).values({ channelId: row.id, segmentId: v.segmentId });
  return row;
}

describe("convites", () => {
  it("manda para o grupo com vaga e registra o canal do clique", async () => {
    const seg = done(await upsertSegment(ctx, { name: "tech" }));
    const g = await insertChannel(ctx.actor.workspaceId, {
      name: "Tech 1",
      inviteUrl: "https://chat.whatsapp.com/AAA",
      segmentId: seg.id,
    });
    const inv = done(
      await createInviteLink(ctx, { segment_id: seg.id, name: "Tech", slug: "tech" }),
    );
    const res = await app.inject({
      url: "/entrar/tech?ref=membro42",
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://chat.whatsapp.com/AAA");
    await clicks.flush();

    const byChannel = await getLinkStats(ctx, { invite_link_id: inv.id, group_by: "channel" });
    expect(byChannel.rows[0]).toMatchObject({ key: g.id, label: "Tech 1", human: 1 });
  });

  it("grupos lotados sem fallback → página de lotado", async () => {
    const seg = done(await upsertSegment(ctx, { name: "cheio" }));
    await insertChannel(ctx.actor.workspaceId, {
      name: "Lotado",
      inviteUrl: "https://chat.whatsapp.com/BBB",
      memberCount: 1024,
      segmentId: seg.id,
    });
    await createInviteLink(ctx, { segment_id: seg.id, name: "Cheio", slug: "cheio" });
    const res = await app.inject({ url: "/entrar/cheio", headers: { "user-agent": BROWSER_UA } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Grupos lotados");
  });
});

describe("vitrine", () => {
  it("mostra marca, botão do grupo com a origem e ofertas; conta visita e clique em oferta", async () => {
    const wsId = ctx.actor.workspaceId;
    const seg = done(await upsertSegment(ctx, { name: "casa" }));
    await insertChannel(wsId, {
      name: "Casa 1",
      inviteUrl: "https://chat.whatsapp.com/CASA",
      segmentId: seg.id,
    });
    const invite = done(
      await createInviteLink(ctx, { segment_id: seg.id, name: "Casa e Cozinha", slug: "casa" }),
    );
    const [prod] = await deps.db
      .insert(products)
      .values({
        workspaceId: wsId,
        platform: "amazon",
        externalId: "B0TESTE001",
        title: "Air Fryer <Philco> 11L",
        url: "https://www.amazon.com.br/dp/B0TESTE001",
        imageUrls: ["https://m.media-amazon.com/images/I/x.jpg"],
      })
      .returning();
    if (!prod) throw new Error("produto");
    const [offer] = await deps.db
      .insert(offers)
      .values({
        workspaceId: wsId,
        productId: prod.id,
        status: "approved",
        price: 389,
        originalPrice: 530.34,
        discountPct: 27,
        score: 80,
        affiliateUrl: "https://www.amazon.com.br/dp/B0TESTE001?tag=loja-20",
        priceDetails: { pix_price: 350.1, installments: null },
      })
      .returning();
    if (!offer) throw new Error("oferta");

    await expect(updateStorefront(ctx, { slug: "admin", title: "Teste" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const sf = done(
      await updateStorefront(ctx, {
        slug: "achadinhos",
        title: "Achadinhos do Edu",
        tagline: "Ofertas todo dia",
        invite_link_ids: [invite.id],
      }),
    );
    expect(sf.url).toBe("http://go.test/@achadinhos");
    expect(sf.source_links[0]?.url).toBe("http://go.test/@achadinhos?src=tiktok");

    const res = await app.inject({
      url: "/@achadinhos?src=tiktok",
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Achadinhos do Edu");
    expect(res.body).toContain("Air Fryer &lt;Philco&gt; 11L");
    expect(res.body).toContain("http://go.test/entrar/casa?src=tiktok&amp;via=vitrine");
    expect(res.body).toContain('href="https://www.amazon.com.br/dp/B0TESTE001?tag=loja-20"');
    expect(res.body).toContain("no Pix");

    const beacon = await app.inject({
      method: "POST",
      url: `/@achadinhos/c?src=tiktok&via=vitrine&o=${offer.id}`,
      headers: { "user-agent": BROWSER_UA },
    });
    expect(beacon.statusCode).toBe(204);
    const join = await app.inject({
      url: "/entrar/casa?src=tiktok&via=vitrine",
      headers: { "user-agent": BROWSER_UA },
    });
    expect(join.headers.location).toBe("https://chat.whatsapp.com/CASA");
    await clicks.flush();

    const stats = await getAudienceStats(ctx, { period: "today" });
    expect(stats.sources.find((r) => r.source === "tiktok")).toMatchObject({
      views: 1,
      invite_clicks: 1,
      offer_clicks: 1,
      view_to_invite: 1,
    });

    // Personalização: cores, botão, link extra, destaque e só destaques.
    await expect(
      updateStorefront(ctx, { design: { links: [{ label: "x", url: "javascript:alert(1)" }] } }),
    ).rejects.toThrow(/http/);
    const styled = done(
      await updateStorefront(ctx, {
        design: {
          accent_color: "#ea580c",
          join_label: "Quero entrar",
          links: [{ label: "Instagram", url: "https://instagram.com/achadinhos" }],
          featured_offer_ids: [offer.id],
          offers_mode: "featured_only",
        },
      }),
    );
    expect(styled.design).toMatchObject({
      accent_color: "#EA580C",
      offers_title: "Ofertas de hoje",
      group_by_category: false,
    });
    // Só os campos enviados mudam.
    done(await updateStorefront(ctx, { design: { offers_title: "Achados" } }));
    const page2 = await app.inject({ url: "/@achadinhos", headers: { "user-agent": BROWSER_UA } });
    expect(page2.body).toContain("--accent:#EA580C");
    expect(page2.body).toContain(">Quero entrar<");
    expect(page2.body).toContain('href="https://instagram.com/achadinhos"');
    expect(page2.body).toContain("<h2>Destaques</h2>");

    // Pausada ou inexistente: 404 amigável.
    done(await updateStorefront(ctx, { active: false }));
    expect((await app.inject({ url: "/@achadinhos" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/@naoexiste" })).statusCode).toBe(404);
  });

  it("endereço de outro workspace é recusado", async () => {
    const s = await signup(
      deps,
      { name: "E", email: "e@teste.com", password: "12345678", workspace_name: "M" },
      { allowSignup: true },
    );
    const r = await resolveSession(deps, s.sessionToken);
    if (!r) throw new Error("sessão");
    await expect(
      updateStorefront({ ...deps, actor: r.actor }, { slug: "achadinhos", title: "Outro" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("desempenho", () => {
  it("p95 do redirecionamento abaixo de 50 ms (cache aquecido)", async () => {
    const link = done(await createTrackedLink(ctx, { destination_url: "https://p.com" }));
    await app.inject({ url: `/${link.slug}` });
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await app.inject({ url: `/${link.slug}`, headers: { "user-agent": BROWSER_UA } });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThan(50);
  });
});
