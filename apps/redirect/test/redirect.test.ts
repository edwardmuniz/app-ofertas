import {
  ClickBuffer,
  createInviteLink,
  createTrackedLink,
  type Deps,
  getLinkStats,
  MemoryCache,
  MemoryCounterStore,
  resolveSession,
  signup,
  updateTrackedLink,
  upsertChannel,
  upsertSegment,
} from "@ofertas/core";
import { createDb, runMigrations } from "@ofertas/db";
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

describe("convites", () => {
  it("manda para o grupo com vaga e registra o canal do clique", async () => {
    const seg = done(await upsertSegment(ctx, { name: "tech" }));
    const g = done(
      await upsertChannel(ctx, {
        name: "Tech 1",
        invite_url: "https://chat.whatsapp.com/AAA",
        segment_ids: [seg.id],
      }),
    );
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
    await upsertChannel(ctx, {
      name: "Lotado",
      invite_url: "https://chat.whatsapp.com/BBB",
      member_count: 1024,
      segment_ids: [seg.id],
    });
    await createInviteLink(ctx, { segment_id: seg.id, name: "Cheio", slug: "cheio" });
    const res = await app.inject({ url: "/entrar/cheio", headers: { "user-agent": BROWSER_UA } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Grupos lotados");
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
