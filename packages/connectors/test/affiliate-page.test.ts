import { describe, expect, it } from "vitest";
import {
  embeddedStoreUrl,
  looksLikeAffiliateUrl,
  parsePrice,
  parseProductPage,
  platformOfUrl,
  productIdOfUrl,
  titleFromUrl,
} from "../src/affiliate/product-page";

describe("página de produto", () => {
  it("reconhece loja e id do produto pelo endereço", () => {
    expect(platformOfUrl("https://s.shopee.com.br/AbC")).toBe("shopee");
    expect(platformOfUrl("https://exemplo.com")).toBeNull();
    expect(productIdOfUrl("shopee", "https://shopee.com.br/Nome-i.12.345")).toBe("345");
    expect(productIdOfUrl("shopee", "https://shopee.com.br/product/12/345")).toBe("345");
    expect(
      productIdOfUrl("mercadolivre", "https://produto.mercadolivre.com.br/MLB-123-fone-_JM"),
    ).toBe("MLB123");
    // Produto de vendedor (/up/MLBU...) não se confunde com o anúncio MLB de mesmo número.
    expect(
      productIdOfUrl(
        "mercadolivre",
        "https://www.mercadolivre.com.br/fone/up/MLBU3165237239?pdp_filters=deal%3AMLB1717788#polycard",
      ),
    ).toBe("MLBU3165237239");
    expect(
      productIdOfUrl("mercadolivre", "https://www.mercadolivre.com.br/fone/p/MLB15209590"),
    ).toBe("MLB15209590");
    expect(productIdOfUrl("amazon", "https://www.amazon.com.br/x/dp/b09xs7jwhh?th=1")).toBe(
      "B09XS7JWHH",
    );
    expect(titleFromUrl("https://shopee.com.br/Fone-de-Ouvido-Sem-Fio-i.1.2")).toBe(
      "Fone de Ouvido Sem Fio",
    );
    expect(titleFromUrl("https://produto.mercadolivre.com.br/MLB-123-fone-de-ouvido-_JM")).toBe(
      "fone de ouvido",
    );
    expect(looksLikeAffiliateUrl("https://s.shopee.com.br/AbC")).toBe(true);
    expect(looksLikeAffiliateUrl("https://www.amazon.com.br/dp/B0?tag=meu-20")).toBe(true);
    expect(looksLikeAffiliateUrl("https://shopee.com.br/Nome-i.1.2")).toBe(false);
  });

  it("lê JSON-LD, Open Graph e entidades HTML", () => {
    const html = `<html><head>
      <meta property="og:title" content="Fone Sony | Cancelamento de ru&iacute;do | Amazon.com.br">
      <meta property="og:image" content="/img/fone.jpg">
      <script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Fone Sony WH-1000XM5",
        "offers":{"@type":"Offer","price":"1550.00","seller":{"name":"Loja X"}}}]}</script>
    </head></html>`;
    expect(parseProductPage(html, "https://www.amazon.com.br/dp/B1")).toEqual({
      title: "Fone Sony WH-1000XM5",
      imageUrl: "https://www.amazon.com.br/img/fone.jpg",
      price: 1550,
      originalPrice: null,
      shopName: "Loja X",
    });
    const og = parseProductPage(
      '<meta property="og:title" content="Fone Sony | Cancelamento de ru&iacute;do | Amazon.com.br">',
      "https://www.amazon.com.br/dp/B1",
    );
    expect(og.title).toBe("Fone Sony | Cancelamento de ruído");
    expect(parsePrice("R$ 1.299,90")).toBe(1299.9);
    expect(parsePrice("1.299")).toBe(1299);
  });
});

describe("link.amazon (página intermediária)", () => {
  it("reconhece o domínio e acha o link da loja dentro da página", () => {
    expect(platformOfUrl("https://link.amazon/B0f8ECDL1")).toBe("amazon");
    expect(looksLikeAffiliateUrl("https://link.amazon/B0f8ECDL1")).toBe(true);
    const html = `<html><head><base href="https://r.amzlinks.in?btn_ref=org-1&amp;btn_url=https%3A%2F%2Fwww.amazon.com.br%2FApple-iPhone-16%2Fdp%2FB0DJFRYWK8%3FlinkCode%3Dsl2%26tag%3Doutro-20"><title>Apple iPhone 16</title></head><body></body></html>`;
    expect(embeddedStoreUrl(html)).toBe(
      "https://www.amazon.com.br/Apple-iPhone-16/dp/B0DJFRYWK8?linkCode=sl2&tag=outro-20",
    );
    expect(embeddedStoreUrl("<html><title>nada</title></html>")).toBeNull();
  });
});
