import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// parse.js é um script comum (roda na página): carrega num contexto isolado e usa as funções.
const ctx = {};
runInNewContext(readFileSync(new URL("../parse.js", import.meta.url), "utf8"), ctx);
const {
  ofzMoney,
  ofzInstallments,
  ofzOtherMethods,
  ofzPixPrice,
  ofzCoupon,
  ofzAffiliateLink,
  ofzStore,
} = ctx;

describe("leitura das páginas", () => {
  it("valores em reais", () => {
    expect(ofzMoney("R$ 1.234,56")).toBe(1234.56);
    expect(ofzMoney("R$62,90")).toBe(62.9);
    expect(ofzMoney("153.90")).toBe(153.9);
    expect(ofzMoney("R$ 1.000")).toBe(1000);
    expect(ofzMoney("")).toBeNull();
  });

  it("Pix e outros meios do Mercado Livre, parcelas", () => {
    expect(ofzOtherMethods("R$ 35,72 43% OFF no Pix ou R$ 44,65 em outros meios")).toBe(44.65);
    expect(ofzPixPrice("R$ 197,60 no Pix")).toBe(197.6);
    expect(ofzInstallments("em 12x R$ 20,18 sem juros")).toEqual({
      count: 12,
      value: 20.18,
      interest_free: true,
    });
    expect(ofzInstallments("5x de R$ 30,78 sem juros")?.count).toBe(5);
  });

  it("cupom com e sem código", () => {
    expect(ofzCoupon("R$ 32,59 27% OFF no Pix com Cupom 20% OFF com cupom")).toEqual({
      code: null,
      description: "Cupom de 20% OFF: ative na página antes de comprar",
    });
    expect(ofzCoupon("Use o cupom SUPERVANTAGEM e ganhe 30% OFF")).toEqual({
      code: "SUPERVANTAGEM",
      description: "",
    });
    expect(ofzCoupon("Aplicar cupom de 10 %")?.description).toContain("10%");
    expect(ofzCoupon("20% OFF com Saldo no Mercado Pago")).toBeNull();
    expect(ofzCoupon("Frete grátis")).toBeNull();
  });

  it("link de afiliado e loja", () => {
    expect(ofzAffiliateLink("Copie: https://meli.la/1AbC23x pronto")).toBe(
      "https://meli.la/1AbC23x",
    );
    expect(ofzAffiliateLink("https://amzn.to/3xyz")).toBe("https://amzn.to/3xyz");
    expect(ofzAffiliateLink("https://www.mercadolivre.com.br/p/MLB123")).toBeNull();
    expect(ofzStore("produto.mercadolivre.com.br")).toBe("mercadolivre");
    expect(ofzStore("www.amazon.com.br")).toBe("amazon");
    expect(ofzStore("example.com")).toBeNull();
  });
});
