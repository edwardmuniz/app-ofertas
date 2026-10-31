import { fakeAffiliateControls, fakeMessagingControls } from "@ofertas/connectors";
import { limits, posts } from "@ofertas/db";
import { inspectImage } from "@ofertas/render";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  completeUpload,
  connectAffiliateAccount,
  createMessagingAccount,
  createSafeFetcher,
  type Deps,
  generateCreative,
  getBrandKit,
  getConnectionState,
  importMediaFromUrl,
  listCreatives,
  listPosts,
  receiveUpload,
  requestUpload,
  resolveSession,
  runPublisher,
  saveOffer,
  schedulePosts,
  searchOffers,
  serveMedia,
  syncGroups,
  updateBrandKit,
  validateCreative,
} from "../src";
import { createOwner, fakeFetchMedia, setupTestDeps } from "./helpers";

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
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  const ctx: Ctx = { ...deps, actor: r.actor };
  await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee", mode: "fake" });
  const { items } = await searchOffers(ctx, { keyword: "air fryer", limit: 3 });
  const c = items[0];
  if (!c) throw new Error("busca vazia");
  const offer = done(await saveOffer(ctx, { product_id: c.product_id, coupon_code: "BF10" }));
  return { ctx, offer, candidate: c };
}

/** Lê a imagem pela URL assinada, como a Evolution Go faria. */
async function fetchSigned(url: string) {
  const u = new URL(url);
  const assetId = u.pathname.split("/").pop() ?? "";
  return serveMedia(deps, assetId, Number(u.searchParams.get("e")), u.searchParams.get("s") ?? "");
}

describe("brand kit e geração", () => {
  it("usa o nome do workspace por padrão e aceita cores próprias", async () => {
    const { ctx } = await setup();
    const kit = await getBrandKit(ctx);
    expect(kit.name).toMatch(/^Loja/);
    const updated = done(
      await updateBrandKit(ctx, { primary_color: "#2563EB", cta: "Corre no link" }),
    );
    expect(updated).toMatchObject({ primary_color: "#2563EB", cta: "Corre no link" });
    await expect(updateBrandKit(ctx, { primary_color: "azul" })).rejects.toThrow();
  });

  it("gera o card nos formatos pedidos, com URLs assinadas que abrem a imagem", async () => {
    const { ctx, offer } = await setup();
    const dry = await generateCreative(ctx, { offer_id: offer.id }, { dryRun: true });
    expect(dry.status).toBe("dry_run");

    const cr = done(
      await generateCreative(ctx, { offer_id: offer.id, formats: ["wa_image", "story_9x16"] }),
    );
    expect(cr).toMatchObject({
      origin: "template",
      template: "card_preco",
      rendered_price: offer.price,
    });
    expect(cr.variants.map((v) => [v.format, v.width, v.height])).toEqual([
      ["wa_image", 1080, 1080],
      ["story_9x16", 1080, 1920],
    ]);
    const file = await fetchSigned(cr.variants[0]?.url ?? "");
    expect(file?.mime).toBe("image/png");
    expect(inspectImage(file?.data ?? Buffer.alloc(0))?.width).toBe(1080);
    const preview = await fetchSigned(cr.variants[0]?.preview_url ?? "");
    expect(inspectImage(preview?.data ?? Buffer.alloc(0))?.width).toBe(480);

    // Assinatura adulterada não abre.
    const bad = new URL(cr.variants[0]?.url ?? "");
    bad.searchParams.set("s", "x");
    expect(await fetchSigned(bad.toString())).toBeNull();

    expect((await listCreatives(ctx, { offer_id: offer.id })).items).toHaveLength(1);
    expect(
      (await validateCreative(ctx, { creative_id: cr.id, format: "feed_4x5" })).issues[0]?.code,
    ).toBe("missing_format");
  });
});

describe("upload e importação", () => {
  it("upload em duas etapas: link assinado, envio e conclusão com validação", async () => {
    const { ctx, offer } = await setup();
    const png = (await fakeFetchMedia("x")).data;
    const ticket = done(
      await requestUpload(ctx, { filename: "card.png", mime: "image/png", size_bytes: png.length }),
    );
    expect(ticket.curl).toContain("--data-binary");
    const u = new URL(ticket.put_url);
    const id = u.pathname.split("/").pop() ?? "";
    const e = Number(u.searchParams.get("e"));
    const s = u.searchParams.get("s") ?? "";

    await expect(receiveUpload(deps, id, e, "assinatura-falsa", png)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(receiveUpload(deps, id, e, s, Buffer.from("texto"))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(completeUpload(ctx, { upload_id: id })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await receiveUpload(deps, id, e, s, png)).toMatchObject({ ok: true, width: 480 });
    await expect(receiveUpload(deps, id, e, s, png)).rejects.toMatchObject({ code: "CONFLICT" });

    const cr = done(
      await completeUpload(ctx, {
        upload_id: id,
        offer_id: offer.id,
        ai_generated: true,
        tags: ["bf"],
      }),
    );
    expect(cr).toMatchObject({
      origin: "upload",
      ai_generated: true,
      tags: ["bf"],
      offer_id: offer.id,
    });
    expect(cr.variants[0]?.format).toBe("wa_image");
    expect(cr.variants[0]?.validation.map((v) => v.code)).toEqual(["low_resolution"]);
  });

  it("importa por URL e bloqueia endereços internos", async () => {
    const { ctx } = await setup();
    const cr = done(await importMediaFromUrl(ctx, { url: "https://cdn.exemplo.com/banner.png" }));
    expect(cr).toMatchObject({ origin: "import", title: "banner.png" });

    const safe = createSafeFetcher();
    await expect(safe("http://127.0.0.1:3001/v1/health")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(safe("http://10.0.0.5/x.png")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(safe("http://172.16.6.16:4010/instance/all")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(safe("ftp://exemplo.com/x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("criativo no envio", () => {
  async function connected(ctx: Ctx) {
    await deps.db.update(posts).set({ status: "canceled" }).where(eq(posts.status, "scheduled"));
    await deps.db
      .insert(limits)
      .values({ workspaceId: ctx.actor.workspaceId, key: "posts.jitter_seconds", value: 0 });
    const acc = done(await createMessagingAccount(ctx, { label: "N", provider: "fake" }));
    await getConnectionState(ctx, acc.id);
    return done(await syncGroups(ctx, acc.id)).channels[0];
  }

  it("gera o card na hora do envio e manda a URL assinada", async () => {
    const { ctx, offer } = await setup();
    const ch = await connected(ctx);
    done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [ch?.id ?? ""],
        creative_template: "card_preco",
        at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect((await runPublisher(deps))[0]?.status).toBe("sent");
    const sent = fakeMessagingControls.sent[0];
    expect(sent?.imageUrl).toMatch(/^http:\/\/api\.test\/media\//);
    const file = await fetchSigned(sent?.imageUrl ?? "");
    expect(inspectImage(file?.data ?? Buffer.alloc(0))).toMatchObject({
      width: 1080,
      height: 1080,
    });
    const [post] = (await listPosts(ctx, { status: "sent" })).items;
    expect(post).toBeTruthy();
  });

  it("criativo com preço antigo é refeito antes de enviar", async () => {
    const { ctx, offer, candidate } = await setup();
    const ch = await connected(ctx);
    const old = done(await generateCreative(ctx, { offer_id: offer.id }));
    // Preço caiu 10%: continua válido, mas o card antigo mostra o preço errado.
    fakeAffiliateControls.setPrice(
      candidate.external_id,
      Math.round(candidate.price * 0.9 * 100) / 100,
    );
    done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [ch?.id ?? ""],
        creative_id: old.id,
        at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect((await runPublisher(deps))[0]?.status).toBe("sent");
    const all = await listCreatives(ctx, { offer_id: offer.id });
    expect(all.items).toHaveLength(2);
    expect(fakeMessagingControls.sent[0]?.imageUrl).not.toContain(
      old.variants[0]?.url.split("?")[0]?.split("/").pop(),
    );
  });

  it("creative_id exige uma única oferta", async () => {
    const { ctx, offer } = await setup();
    await expect(
      schedulePosts(ctx, {
        offer_ids: [offer.id, offer.id],
        channel_ids: [],
        creative_id: offer.id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
