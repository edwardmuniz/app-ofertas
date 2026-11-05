import { describe, expect, it } from "vitest";
import {
  AMAZON_TOKEN_URL,
  AmazonConnector,
  amazonAffiliateLink,
  amazonCouponOf,
  amazonSearchUrl,
  asinOfUrl,
  ConnectorError,
  defaultAffiliateConnectorFactory,
  FakeAffiliateConnector,
  isAmazonTag,
  mapCreatorsItem,
  type PageReader,
  parseAmazonPage,
  parseAmazonSearch,
} from "../src";

/** Trechos reais da página de produto da Amazon (pedida como o WhatsApp pede), resumidos. */
const PAGE = `<html><head>
<meta property="og:title" content="soundcore P20i da Anker, Fone de Ouvido Bluetooth 5.3"/>
<meta property="og:image" content="https://m.media-amazon.com/images/I/arte_com_nota.jpg"/>
</head><body>
<div id="wayfinding-breadcrumbs_feature_div"><ul><li><span class="a-list-item"><a class="a-link-normal" href="/Eletronicos-e-Tecnologia/b?ie=UTF8&amp;node=16209062011">Eletrônicos e Tecnologia</a></span></li></ul></div>
<span id="productTitle" class="a-size-medium">        soundcore P20i da Anker, Fone de Ouvido Bluetooth 5.3       </span>
<span id="acrPopover" class="reviewCountTextLinkedHistogram" title="4,6 de 5 estrelas"></span>
<span id="acrCustomerReviewText" aria-label="117.192 Análises" class="a-size-small">(117.192)</span>
<img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/51G+D9DlGxL._AC_SL1500_.jpg">
<span class="a-price apex-pricetopay-value"><span class="a-offscreen">R$146,20</span></span>
<span class="a-size-base a-color-base"> no Pix ou NuPay </span> <span class="a-size-base"> ou em até </span> <span class="a-size-base a-text-bold"> 5x de R$ 30,78 sem juros<br/></span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">R$ 153,90</span></span>
<span class="basisPrice"><span class="apex-basisprice-label">De:</span> <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">R$249,00</span></span></span></div>
<div id="availability" class="a-section"> <span class="a-size-medium a-color-success primary-availability-message"> Em estoque </span></div>
<script>{"priceAmount":153.90,"currencySymbol":"R$"}</script>
</body></html>`;

/** Card da página de resultados da Amazon (trecho real, resumido). */
const card = (asin: string, title: string, price: string, extra = "") =>
  `<div role="listitem" data-asin="${asin}" data-index="4" data-component-type="s-search-result" class="s-result-item">` +
  `<img class="s-image" src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" alt="${title}"/>` +
  `<h2 aria-label="${title}" class="a-size-base-plus"><span>${title}</span></h2>` +
  `<span class="a-icon-alt">4,7 de 5 estrelas</span><a aria-label="9.875 classificações" href="#">(9,8 mil)</a>` +
  `<span class="a-size-base a-color-secondary">Mais de 1 mil compras no mês passado</span>` +
  `<span class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></span>${extra}</div>`;
const RESULTS = `<html><body><div data-asin="" class="s-result-item"></div>
${card(
  "B0BZJDLT6Z",
  "MONDIAL Fritadeira Air Fryer Forno Oven 12L &amp; Inox",
  "R$ 521,09",
  '<span class="a-offscreen">De: R$ 599,00</span><span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">R$ 599,00</span></span>' +
    '<span class="a-size-base a-color-secondary">em até 10x de </span><span class="a-price a-text-price"><span class="a-offscreen">R$ 52,19</span></span><span> sem juros</span>',
)}
${card("B093MK3Z12", "Air Fryer 4L", "R$ 249,00")}
${card("B0DTVLLSD9", "Sem preço (só outras opções)", "")}
<a class="s-pagination-item s-pagination-next s-pagination-button" href="/s?k=air+fryer&page=2">Próximo</a>
</body></html>`;

const pages =
  (map: Record<string, { status?: number; html: string }>): PageReader =>
  async (url) => {
    const p = map[url];
    if (!p) throw new Error(`sem página: ${url}`);
    return { url, status: p.status ?? 200, html: p.html };
  };

describe("Amazon: cupom", () => {
  it("lê o cupom de marcar e o código promocional", () => {
    expect(amazonCouponOf(" Aplicar cupom de 10 % ")).toEqual({
      code: null,
      description: "Cupom de 10%: marque “Aplicar cupom” na página antes de comprar",
    });
    expect(amazonCouponOf("Economize R$ 20,00 com cupom")?.description).toContain("R$ 20,00");
    expect(amazonCouponOf("Economize 15% com o código PROMO15 na finalização")).toEqual({
      code: "PROMO15",
      description: "15% de desconto",
    });
    expect(amazonCouponOf("Frete grátis em pedidos acima de R$ 99")).toBeNull();
  });

  it("só considera o cupom do anúncio principal, não o de outros produtos da página", () => {
    expect(parseAmazonPage(PAGE).coupon).toBeNull();
    const carousel = PAGE.replace(
      "</body>",
      '<div class="a-carousel"><span>Economize 5% com cupom</span></div></body>',
    );
    expect(parseAmazonPage(carousel).coupon).toBeNull();
    const withCoupon = PAGE.replace(
      "</body>",
      '<div id="promoPriceBlockMessage_feature_div"><label id="couponTextpctch1" for="checkboxpct">Aplicar cupom de 10% </label></div></body>',
    );
    expect(parseAmazonPage(withCoupon).coupon).toMatchObject({ code: null });
  });

  it("lê o cupom no card da busca", () => {
    const html = `<html><body>${card(
      "B0BZJDLT6Z",
      "Air Fryer",
      "R$ 300,00",
      '<span class="s-coupon-unclipped"><span class="s-coupon-highlight-color">Economize 10%</span><span class="a-letter-space"></span>com cupom</span>',
    )}${card("B093MK3Z12", "Air Fryer 4L", "R$ 249,00")}</body></html>`;
    const items = parseAmazonSearch(html).items;
    expect(items[0]?.coupon?.description).toContain("10%");
    expect(items[1]?.coupon).toBeNull();
  });
});

describe("Amazon: links", () => {
  it("reconhece tag e ASIN", () => {
    expect(isAmazonTag("minhaloja-20")).toBe(true);
    expect(isAmazonTag("minha loja")).toBe(false);
    expect(asinOfUrl("https://www.amazon.com.br/Fone-Anker/dp/B0BTYCJXBK/ref=sr_1_1?k=fone")).toBe(
      "B0BTYCJXBK",
    );
    expect(asinOfUrl("https://www.amazon.com.br/gp/product/b0btycjxbk")).toBe("B0BTYCJXBK");
    expect(asinOfUrl("https://www.amazon.com.br/s?k=fone")).toBeNull();
  });

  it("monta o link oficial com a tag (troca a tag de outra pessoa)", () => {
    expect(
      amazonAffiliateLink(
        "https://www.amazon.com.br/Fone-Anker/dp/B0BTYCJXBK?tag=outro-20&th=1",
        "minhaloja-20",
      ),
    ).toBe("https://www.amazon.com.br/dp/B0BTYCJXBK?tag=minhaloja-20");
  });
});

describe("Amazon: leitura da página", () => {
  it("lê título, foto em alta, preço, preço De, nota, estoque e categoria", () => {
    const d = parseAmazonPage(PAGE);
    expect(d).toMatchObject({
      title: "soundcore P20i da Anker, Fone de Ouvido Bluetooth 5.3",
      imageUrl: "https://m.media-amazon.com/images/I/51G+D9DlGxL._AC_SL1500_.jpg",
      price: 153.9,
      originalPrice: 249,
      rating: 4.6,
      reviews: 117192,
      available: true,
      categoryId: "16209062011",
      categoryName: "Eletrônicos e Tecnologia",
      pixPrice: 146.2,
      installments: { count: 5, value: 30.78, interestFree: true },
      blocked: false,
    });
  });

  it("indisponível e captcha", () => {
    const off = PAGE.replace("Em estoque", "Não disponível.").replace(/"priceAmount":[0-9.]+,/, "");
    expect(parseAmazonPage(off).available).toBe(false);
    // Só vendedores parceiros, sem anúncio principal.
    const noBuyBox = PAGE.replace(/"priceAmount":[0-9.]+,/, "")
      .replace(/<div id="corePrice[\s\S]*?<\/div>/, "")
      .replace("Em estoque", "")
      .concat('<span id="buybox-see-all-buying-choices">Ver todas as opções de compra</span>');
    expect(parseAmazonPage(noBuyBox)).toMatchObject({ price: null, available: false });
    expect(
      parseAmazonPage("<html><form action='/errors/validateCaptcha'>Digite os caracteres</form>")
        .blocked,
    ).toBe(true);
  });
});

describe("Amazon só com a tag", () => {
  const url = "https://www.amazon.com.br/dp/B0BTYCJXBK";

  it("consulta pela página e gera link com a tag, sem sub-ids", async () => {
    const c = new AmazonConnector(
      { partner_tag: "minhaloja-20" },
      { fetchPage: pages({ [url]: { html: PAGE } }) },
    );
    expect(c.capabilities).toMatchObject({ search: true, lookup: true, subIds: 0 });
    const item = await c.lookup("B0BTYCJXBK");
    expect(item).toMatchObject({
      platform: "amazon",
      externalId: "B0BTYCJXBK",
      price: 153.9,
      originalPrice: 249,
      discountPct: 38,
      available: true,
      url,
      affiliateUrl: `${url}?tag=minhaloja-20`,
    });
    expect(await c.generateLink(url, ["wa", "abc"])).toBe(`${url}?tag=minhaloja-20`);
  });

  it("busca pela página de resultados, com a tag em cada link", async () => {
    const searchUrl = "https://www.amazon.com.br/s?k=air+fryer";
    const c = new AmazonConnector(
      { partner_tag: "minhaloja-20" },
      { fetchPage: pages({ [searchUrl]: { html: RESULTS } }) },
    );
    const r = await c.search({ keyword: "air fryer" });
    expect(r.hasMore).toBe(true);
    expect(r.items.map((i) => i.externalId)).toEqual(["B0BZJDLT6Z", "B093MK3Z12"]);
    expect(r.items[0]).toMatchObject({
      title: "MONDIAL Fritadeira Air Fryer Forno Oven 12L & Inox",
      price: 521.09,
      originalPrice: 599,
      discountPct: 13,
      rating: 4.7,
      soldCount: 1000,
      imageUrls: ["https://m.media-amazon.com/images/I/B0BZJDLT6Z.jpg"],
      affiliateUrl: "https://www.amazon.com.br/dp/B0BZJDLT6Z?tag=minhaloja-20",
      installments: { count: 10, value: 52.19, interestFree: true },
    });
    expect(r.items[1]).toMatchObject({
      originalPrice: null,
      discountPct: null,
      installments: null,
    });

    const robot = new AmazonConnector(
      { partner_tag: "minhaloja-20" },
      { fetchPage: pages({ [searchUrl]: { html: "<form action='/errors/validateCaptcha'>" } }) },
    );
    await expect(robot.search({ keyword: "air fryer" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    // Sem leitor de páginas (não deve acontecer no servidor) não há busca.
    expect(new AmazonConnector({ partner_tag: "minhaloja-20" }).capabilities.search).toBe(false);
  });

  it("URL da busca: departamento, faixa de preço em centavos, ordem e página", () => {
    expect(
      amazonSearchUrl({
        keyword: "air fryer",
        priceMin: 200,
        priceMax: 400,
        sort: "sales",
        page: 2,
      }),
    ).toBe(
      "https://www.amazon.com.br/s?k=air+fryer&rh=p_36%3A20000-40000&s=exact-aware-popularity-rank&page=2",
    );
    expect(amazonSearchUrl({ categoryId: "16209062011" })).toBe(
      "https://www.amazon.com.br/s?rh=n%3A16209062011",
    );
    expect(amazonSearchUrl({})).toBe("https://www.amazon.com.br/s?k=ofertas");
    expect(parseAmazonSearch("<html></html>")).toMatchObject({ items: [], blocked: false });
  });

  it("página 404 = produto não existe; captcha não expira a oferta (vira erro)", async () => {
    const gone = new AmazonConnector(
      { partner_tag: "minhaloja-20" },
      { fetchPage: pages({ [url]: { status: 404, html: "" } }) },
    );
    expect(await gone.lookup("B0BTYCJXBK")).toBeNull();
    const robot = new AmazonConnector(
      { partner_tag: "minhaloja-20" },
      { fetchPage: pages({ [url]: { html: "<p>captcha</p>" } }) },
    );
    await expect(robot.lookup("B0BTYCJXBK")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("tag inválida não conecta", () => {
    expect(() => new AmazonConnector({ partner_tag: "errada" })).toThrow(ConnectorError);
    expect(() =>
      defaultAffiliateConnectorFactory({
        platform: "amazon",
        mode: "live",
        credentials: { partner_tag: "" },
      }),
    ).toThrow(/Tag de associado/);
  });
});

describe("Amazon com a Creators API (fetch simulado)", () => {
  const ITEM = {
    asin: "B0BTYCJXBK",
    detailPageURL: "https://www.amazon.com.br/dp/B0BTYCJXBK?tag=minhaloja-20&linkCode=ogi&th=1",
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/x.jpg" } } },
    itemInfo: { title: { displayValue: "Fone Anker" } },
    browseNodeInfo: { browseNodes: [{ id: "16209062011", displayName: "Eletrônicos" }] },
    offersV2: {
      listings: [
        {
          isBuyBoxWinner: true,
          price: {
            money: { amount: 153.9 },
            savingBasis: { money: { amount: 249 } },
            savings: { percentage: 38 },
          },
          availability: { type: "IN_STOCK" },
          merchantInfo: { name: "Amazon.com.br" },
        },
      ],
    },
  };

  function connector(respond: (url: string, body: Record<string, unknown>) => Response) {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, headers: new Headers(init.headers) });
      return respond(url, body);
    }) as unknown as typeof fetch;
    const c = new AmazonConnector(
      { partner_tag: "minhaloja-20", credential_id: "id1", credential_secret: "s1" },
      { fetch: fetchMock, now: () => 1_700_000_000_000 },
    );
    return { c, calls };
  }
  const token = () => Response.json({ access_token: "Atc|tok", expires_in: 3600 });

  it("pede token uma vez e busca com filtros em centavos", async () => {
    const { c, calls } = connector((url) =>
      url === AMAZON_TOKEN_URL
        ? token()
        : Response.json({ searchResult: { items: [ITEM], totalResultCount: 25 } }),
    );
    expect(c.capabilities.search).toBe(true);
    const res = await c.search({
      keyword: "fone",
      minDiscount: 30,
      priceMin: 50,
      priceMax: 200.5,
      sort: "price_asc",
      limit: 20,
    });
    await c.search({ keyword: "fone" });
    expect(calls.filter((x) => x.url === AMAZON_TOKEN_URL)).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      grant_type: "client_credentials",
      client_id: "id1",
      scope: "creatorsapi::default",
    });
    const search = calls[1];
    expect(search?.url).toBe("https://creatorsapi.amazon/catalog/v1/searchItems");
    expect(search?.headers.get("authorization")).toBe("Bearer Atc|tok");
    expect(search?.headers.get("x-marketplace")).toBe("www.amazon.com.br");
    expect(search?.body).toMatchObject({
      keywords: "fone",
      partnerTag: "minhaloja-20",
      marketplace: "www.amazon.com.br",
      itemCount: 10,
      minSavingPercent: 30,
      minPrice: 5000,
      maxPrice: 20050,
      sortBy: "Price:LowToHigh",
    });
    expect(res.hasMore).toBe(true);
    expect(res.items[0]).toMatchObject({
      externalId: "B0BTYCJXBK",
      title: "Fone Anker",
      price: 153.9,
      originalPrice: 249,
      discountPct: 38,
      shopName: "Amazon.com.br",
      categoryIds: ["16209062011"],
      affiliateUrl: ITEM.detailPageURL,
    });
  });

  it("consulta por ASIN aceita as duas chaves da resposta", async () => {
    const { c } = connector((url) =>
      url === AMAZON_TOKEN_URL ? token() : Response.json({ itemResults: { items: [ITEM] } }),
    );
    expect((await c.lookup("B0BTYCJXBK"))?.price).toBe(153.9);
  });

  it("erros: credencial recusada = AUTH, 429 = RATE_LIMIT", async () => {
    const bad = connector(() =>
      Response.json({ error_description: "bad client" }, { status: 401 }),
    );
    await expect(bad.c.ping()).rejects.toMatchObject({ code: "AUTH" });
    const limited = connector((url) =>
      url === AMAZON_TOKEN_URL ? token() : new Response("", { status: 429 }),
    );
    await expect(limited.c.search({ keyword: "x" })).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });

  it("item sem oferta (sem preço) fica de fora", () => {
    expect(mapCreatorsItem({ asin: "B000000001" })).toBeNull();
  });
});

describe("Amazon simulada", () => {
  it("usa ASIN e links da Amazon", async () => {
    const c = new FakeAffiliateConnector("amazon");
    const { items } = await c.search({ keyword: "fone" });
    const first = items[0];
    expect(first?.externalId).toMatch(/^B0[0-9A-Z]{8}$/);
    expect(first?.url).toBe(`https://www.amazon.com.br/dp/${first?.externalId}`);
    expect((await c.lookup(first?.externalId ?? ""))?.title).toBe(first?.title);
    expect(c.capabilities.subIds).toBe(0);
  });
});
