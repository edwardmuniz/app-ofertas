import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectorError,
  FakeAffiliateConnector,
  fakeAffiliateControls,
  mapShopeeNode,
  ShopeeConnector,
  shopeeSignature,
} from "../src";

afterEach(() => fakeAffiliateControls.reset());

describe("Shopee (real, com fetch simulado)", () => {
  function connector(respond: (body: unknown, headers: Headers) => Response) {
    const calls: { body: string; headers: Headers }[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ body: String(init.body), headers });
      return respond(JSON.parse(String(init.body)), headers);
    }) as unknown as typeof fetch;
    const c = new ShopeeConnector(
      { app_id: "123", secret: "s3cr3t" },
      { fetch: fetchMock, now: () => 1_700_000_000_000 },
    );
    return { c, calls };
  }

  it("assina a requisição com SHA256(appId + timestamp + payload + secret)", async () => {
    const { c, calls } = connector(() =>
      Response.json({ data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } } }),
    );
    await c.search({ keyword: "air fryer" });
    const call = calls[0];
    if (!call) throw new Error("sem chamada");
    const sig = shopeeSignature("123", 1_700_000_000, call.body, "s3cr3t");
    expect(call.headers.get("authorization")).toBe(
      `SHA256 Credential=123, Timestamp=1700000000, Signature=${sig}`,
    );
    expect(JSON.parse(call.body).variables).toMatchObject({ keyword: "air fryer", sortType: 1 });
  });

  it("sem palavra-chave, relevância vira mais vendidos (a API só ordena por relevância com palavra)", async () => {
    const { c, calls } = connector(() =>
      Response.json({ data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } } }),
    );
    await c.search({ categoryId: "100644" });
    await c.search({ categoryId: "100644", sort: "price_asc" });
    const vars = calls.map((x) => JSON.parse(x.body).variables);
    expect(vars[0]).toMatchObject({ productCatId: 100644, sortType: 2 });
    expect(vars[1]).toMatchObject({ sortType: 4 });
  });

  it("consulta por código só declara os argumentos usados (a Shopee recusa variáveis vazias)", async () => {
    const { c, calls } = connector(() =>
      Response.json({ data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } } }),
    );
    await c.lookup("22094198289");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.variables).toEqual({ itemId: 22094198289, limit: 1 });
    expect(body.query).toContain("query Search($limit: Int, $itemId: Int64)");
    expect(body.query).not.toContain("keyword");
  });

  it("normaliza o produto e deriva o preço original do desconto", () => {
    const p = mapShopeeNode({
      itemId: 22_001,
      productName: "Air Fryer",
      price: "300.00",
      priceDiscountRate: 40,
      commissionRate: "0.08",
      commission: "24.00",
      sales: 1500,
      ratingStar: "4.8",
      imageUrl: "https://img/x.jpg",
      productLink: "https://shopee.com.br/p/1",
      offerLink: "https://s.shopee.com.br/abc",
      periodEndTime: 1_800_000_000,
      productCatIds: [100637],
    });
    expect(p).toMatchObject({
      externalId: "22001",
      price: 300,
      originalPrice: 500,
      discountPct: 40,
      commissionRate: 0.08,
      commissionValue: 24,
      rating: 4.8,
      soldCount: 1500,
      affiliateUrl: "https://s.shopee.com.br/abc",
      categoryIds: ["100637"],
      categoryName: "Esportes e Lazer",
    });
  });

  it("converte erros de autenticação e limite", async () => {
    const auth = connector(() => Response.json({ errors: [{ message: "Invalid signature" }] }));
    await expect(auth.c.ping()).rejects.toMatchObject({ code: "AUTH" });
    const rl = connector(() => new Response("", { status: 429 }));
    await expect(rl.c.ping()).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("gera link curto com sub-ids limpos (máx. 5)", async () => {
    const { c, calls } = connector(() =>
      Response.json({ data: { generateShortLink: { shortLink: "https://s.shopee.com.br/xyz" } } }),
    );
    const link = await c.generateLink("https://shopee.com.br/p/1", [
      "wa",
      "g-3",
      "p_8",
      "a",
      "b",
      "c",
    ]);
    expect(link).toBe("https://s.shopee.com.br/xyz");
    expect(JSON.parse(calls[0]?.body ?? "{}").variables.subIds).toEqual([
      "wa",
      "g3",
      "p8",
      "a",
      "b",
    ]);
  });

  it("recusa credenciais vazias", () => {
    expect(() => new ShopeeConnector({ app_id: "", secret: "" })).toThrow(ConnectorError);
  });
});

describe("Shopee simulada", () => {
  const fake = new FakeAffiliateConnector();

  it("busca por termo sem acento e pagina", async () => {
    const r = await fake.search({ keyword: "panelas", limit: 5 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.title.toLowerCase().includes("panelas"))).toBe(true);
    const all = await fake.search({ limit: 50 });
    expect(all.hasMore).toBe(true);
  });

  it("é determinística e permite simular mudança de preço e estoque", async () => {
    const [first] = (await fake.search({ keyword: "air fryer", limit: 1 })).items;
    if (!first) throw new Error("catálogo vazio");
    expect((await fake.lookup(first.externalId))?.price).toBe(first.price);

    fakeAffiliateControls.setPrice(first.externalId, first.price * 2);
    fakeAffiliateControls.setAvailable(first.externalId, false);
    const after = await fake.lookup(first.externalId);
    expect(after?.price).toBe(first.price * 2);
    expect(after?.available).toBe(false);
  });

  it("simula falhas", async () => {
    fakeAffiliateControls.failNext = "UNAVAILABLE";
    await expect(fake.search({})).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(fake.search({})).resolves.toBeDefined();
  });
});
