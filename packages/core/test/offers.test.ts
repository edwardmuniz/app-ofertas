import { FakeAffiliateConnector, fakeAffiliateControls } from "@ofertas/connectors";
import {
  affiliateAccounts,
  events,
  offers,
  pricePoints,
  savedSearches,
  trackedLinks,
} from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticateToken,
  type Ctx,
  connectAffiliateAccount,
  createOfferLink,
  createToken,
  type Deps,
  findSimilarOffers,
  getOffer,
  listOffers,
  resolveSession,
  runDueSavedSearches,
  saveOffer,
  searchOffers,
  setOfferStatus,
  updatePreferences,
  upsertSavedSearch,
  validateOffer,
} from "../src";
import { createOwner, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});
afterEach(() => fakeAffiliateControls.reset());

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

async function ownerCtx(): Promise<Ctx> {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão inválida");
  return { ...deps, actor: r.actor };
}

async function shopCtx(): Promise<Ctx> {
  const ctx = await ownerCtx();
  await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee teste", mode: "fake" });
  return ctx;
}

async function firstCandidate(ctx: Ctx, keyword = "air fryer") {
  const { items } = await searchOffers(ctx, { keyword, limit: 5 });
  const c = items[0];
  if (!c) throw new Error("busca vazia");
  return c;
}

describe("contas de afiliado", () => {
  it("sem conta, a busca explica o que fazer", async () => {
    const ctx = await ownerCtx();
    await expect(searchOffers(ctx, { keyword: "x" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("modo live exige credenciais e grava cifrado", async () => {
    const ctx = await ownerCtx();
    await expect(
      connectAffiliateAccount(ctx, { platform: "shopee", label: "x", mode: "live" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Conector simulado no lugar da Shopee real, para não sair na internet.
    const fakeCtx = { ...ctx, affiliateConnectors: () => new FakeAffiliateConnector() };
    const acc = done(
      await connectAffiliateAccount(fakeCtx, {
        platform: "shopee",
        label: "Real",
        mode: "live",
        credentials: { app_id: "123", secret: "super-secreto" },
      }),
    );
    const [row] = await deps.db
      .select()
      .from(affiliateAccounts)
      .where(eq(affiliateAccounts.id, acc.id));
    expect(row?.credentials?.startsWith("v1.")).toBe(true);
    expect(row?.credentials).not.toContain("super-secreto");
    expect(deps.secrets.decryptJson(row?.credentials ?? "")).toEqual({
      app_id: "123",
      secret: "super-secreto",
    });
  });

  it("agente não conecta contas (credenciais não passam por agentes)", async () => {
    const ctx = await ownerCtx();
    const t = await createToken(ctx, { name: "a", preset: "full" });
    const actor = await authenticateToken(deps, t.token, "mcp");
    if (!actor) throw new Error("token");
    await expect(
      connectAffiliateAccount({ ...deps, actor }, { platform: "shopee", label: "x", mode: "fake" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("busca e nota", () => {
  it("retorna candidatos com nota, grava produto e preço e respeita filtros", async () => {
    const ctx = await shopCtx();
    const res = await searchOffers(ctx, { keyword: "fone", min_discount: 30, limit: 10 });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => (i.discount_pct ?? 0) >= 30)).toBe(true);
    const scores = res.items.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const first = res.items[0];
    if (!first) throw new Error("vazio");
    const points = await deps.db
      .select()
      .from(pricePoints)
      .where(eq(pricePoints.productId, first.product_id));
    expect(points).toHaveLength(1);

    // Repetir a busca logo em seguida não duplica o preço.
    await searchOffers(ctx, { keyword: "fone", min_discount: 30, limit: 10 });
    const again = await deps.db
      .select()
      .from(pricePoints)
      .where(eq(pricePoints.productId, first.product_id));
    expect(again).toHaveLength(1);
  });

  it("nicho do negócio aumenta a nota", async () => {
    const ctx = await shopCtx();
    const before = await firstCandidate(ctx, "headset");
    await updatePreferences(ctx, { niches: ["games"] });
    const after = (await searchOffers(ctx, { keyword: "headset", limit: 5 })).items.find(
      (i) => i.product_id === before.product_id,
    );
    expect(after?.score).toBeGreaterThan(before.score);
  });

  it("detecta desconto falso e menor preço com histórico", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    if (!c.original_price) throw new Error("item sem desconto");
    const day = 86_400_000;
    await deps.db.insert(pricePoints).values(
      [10, 8, 5].map((d) => ({
        productId: c.product_id,
        price: c.price,
        source: "search" as const,
        capturedAt: new Date(Date.now() - d * day),
      })),
    );
    const again = (await searchOffers(ctx, { keyword: "air fryer", limit: 5 })).items.find(
      (i) => i.product_id === c.product_id,
    );
    expect(again?.flags).toContain("fake_discount");
    expect(again?.flags).toContain("lowest_30d");
    expect(again?.price_history.points).toBe(4);
  });

  it("falha da plataforma vira PROVIDER_ERROR e marca a conta", async () => {
    const ctx = await shopCtx();
    fakeAffiliateControls.failNext = "AUTH";
    await expect(searchOffers(ctx, { keyword: "x" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    const [acc] = await deps.db
      .select()
      .from(affiliateAccounts)
      .where(eq(affiliateAccounts.workspaceId, ctx.actor.workspaceId));
    expect(acc?.status).toBe("error");
    // Volta a funcionar e a conta se recupera.
    await searchOffers(ctx, { keyword: "fone" });
    const [ok] = await deps.db
      .select()
      .from(affiliateAccounts)
      .where(eq(affiliateAccounts.workspaceId, ctx.actor.workspaceId));
    expect(ok?.status).toBe("active");
  });
});

describe("curadoria", () => {
  it("salva (dry_run não grava), atualiza a mesma oferta e lista", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const dry = await saveOffer(ctx, { product_id: c.product_id }, { dryRun: true });
    expect(dry.status).toBe("dry_run");
    expect((await listOffers(ctx)).items).toHaveLength(0);

    const a = done(await saveOffer(ctx, { product_id: c.product_id, coupon_code: "BF10" }));
    expect(a).toMatchObject({ status: "approved", coupon_code: "BF10" });
    expect(a.flags).toContain("coupon_required");
    const b = done(await saveOffer(ctx, { product_id: c.product_id, notes: "destaque" }));
    expect(b.id).toBe(a.id);
    expect((await listOffers(ctx, { status: "approved" })).items).toHaveLength(1);

    const found = await searchOffers(ctx, { keyword: "air fryer", limit: 5 });
    expect(found.items.find((i) => i.product_id === c.product_id)?.offer_id).toBe(a.id);
  });

  it("não salva produto sem estoque", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    fakeAffiliateControls.setAvailable(c.external_id, false);
    await expect(saveOffer(ctx, { product_id: c.product_id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejeita com motivo e não aprova oferta expirada", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const offer = done(await saveOffer(ctx, { product_id: c.product_id }));
    const rejected = done(
      await setOfferStatus(ctx, { offer_id: offer.id, status: "rejected", reason: "marca ruim" }),
    );
    expect(rejected).toMatchObject({ status: "rejected", reject_reason: "marca ruim" });

    await deps.db.update(offers).set({ status: "expired" }).where(eq(offers.id, offer.id));
    await expect(
      setOfferStatus(ctx, { offer_id: offer.id, status: "approved" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("validação", () => {
  it("preço estável continua válido; alta acima de 5% expira e emite evento", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const offer = done(await saveOffer(ctx, { product_id: c.product_id }));

    const ok = done(await validateOffer(ctx, offer.id));
    expect(ok).toMatchObject({ ok: true, status: "approved", change_pct: 0 });

    fakeAffiliateControls.setPrice(c.external_id, c.price * 1.2);
    const dry = await validateOffer(ctx, offer.id, { dryRun: true });
    expect(dry.status).toBe("dry_run");
    expect((await getOffer(ctx, offer.id)).status).toBe("approved");

    const bad = done(await validateOffer(ctx, offer.id));
    expect(bad).toMatchObject({ ok: false, status: "expired", change_pct: 20 });
    expect(bad.reason).toContain("subiu");

    const detail = await getOffer(ctx, offer.id);
    expect(detail.status).toBe("expired");
    expect(detail.validations).toHaveLength(2);
    expect(detail.price_history.series.length).toBeGreaterThanOrEqual(1);

    const evts = await deps.db.select().from(events).where(eq(events.type, "offer.expired"));
    expect(evts.some((e) => (e.payload as { offer_id: string }).offer_id === offer.id)).toBe(true);
  });

  it("queda de preço mantém válida e atualiza o preço", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const offer = done(await saveOffer(ctx, { product_id: c.product_id }));
    fakeAffiliateControls.setPrice(c.external_id, Math.round(c.price * 0.8 * 100) / 100);
    const res = done(await validateOffer(ctx, offer.id));
    expect(res.ok).toBe(true);
    expect((await getOffer(ctx, offer.id)).price).toBeCloseTo(c.price * 0.8, 1);
  });
});

describe("similares e link pronto", () => {
  it("acha alternativas da mesma categoria sem repetir o produto", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const offer = done(await saveOffer(ctx, { product_id: c.product_id }));
    const sim = await findSimilarOffers(ctx, { offer_id: offer.id, limit: 3 });
    expect(sim.items.length).toBeGreaterThan(0);
    expect(sim.items.every((i) => i.product_id !== c.product_id)).toBe(true);
  });

  it("gera link de afiliado com sub-ids e link rastreado ligado à oferta", async () => {
    const ctx = await shopCtx();
    const c = await firstCandidate(ctx);
    const offer = done(await saveOffer(ctx, { product_id: c.product_id }));
    const link = done(
      await createOfferLink(ctx, { offer_id: offer.id, source: "wa", campaign: "black-friday" }),
    );
    const slug = link.short_url.split("/").pop() ?? "";
    expect(link.sub_ids).toEqual(["wa", slug, "blackfriday"]);
    expect(link.affiliate_url).toContain(`sub=wa-${slug}-blackfriday`);
    const [row] = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.id, link.link_id));
    expect(row).toMatchObject({
      offerId: offer.id,
      source: "wa",
      destinationUrl: link.affiliate_url,
    });
  });
});

describe("buscas salvas", () => {
  it("adiciona ofertas boas na curadoria sem duplicar e expira vencidas", async () => {
    const ctx = await shopCtx();
    const saved = done(
      await upsertSavedSearch(ctx, {
        name: "Cozinha boa",
        query: { keyword: "panelas", min_discount: 10 },
        min_score: 0,
      }),
    );
    const first = await runDueSavedSearches(deps);
    const mine = first.ran.find((r) => r.id === saved.id);
    expect(mine?.added).toBeGreaterThan(0);
    const created = (await listOffers(ctx, { status: "new", limit: 100 })).items;
    expect(created.length).toBe(mine?.added);

    // Ainda não venceu o intervalo: não roda de novo.
    expect((await runDueSavedSearches(deps)).ran.find((r) => r.id === saved.id)).toBeUndefined();

    // Forçando nova execução: nada duplicado.
    await deps.db
      .update(savedSearches)
      .set({ lastRunAt: null })
      .where(eq(savedSearches.id, saved.id));
    const second = await runDueSavedSearches(deps);
    expect(second.ran.find((r) => r.id === saved.id)?.added).toBe(0);

    // Oferta com prazo vencido expira.
    const target = created[0];
    if (!target) throw new Error("sem oferta");
    await deps.db
      .update(offers)
      .set({ validUntil: new Date(Date.now() - 1000) })
      .where(eq(offers.id, target.id));
    expect((await runDueSavedSearches(deps)).expired).toBeGreaterThanOrEqual(1);
    expect((await getOffer(ctx, target.id)).status).toBe("expired");
  });
});
