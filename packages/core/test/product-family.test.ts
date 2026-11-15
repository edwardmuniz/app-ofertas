import { describe, expect, it } from "vitest";
import { productFamilyKey } from "../src/product-family";

describe("productFamilyKey", () => {
  it("junta o mesmo produto em outra cor", () => {
    const base = "Garrafa Térmica 800ml Aço Inox 304 com 2 Formas de Beber para Viagem e Esporte";
    const rosa = productFamilyKey("amazon", `${base} (Rosa Claro)`);
    expect(rosa).not.toBeNull();
    expect(productFamilyKey("amazon", `${base} (Amarelo)`)).toBe(rosa);
    expect(productFamilyKey("amazon", `${base} (Azul)`)).toBe(rosa);
    expect(productFamilyKey("amazon", "Garrafa Térmica Inox 800ml com Alça - Rosa Escuro")).toBe(
      productFamilyKey("amazon", "Garrafa Térmica Inox 800ml com Alça - Preta"),
    );
  });

  it("separa produtos diferentes, plataformas diferentes e títulos curtos demais", () => {
    expect(productFamilyKey("amazon", "Garrafa Térmica Inox 800ml")).not.toBe(
      productFamilyKey("amazon", "Garrafa Térmica Inox 500ml"),
    );
    expect(productFamilyKey("amazon", "Garrafa Térmica Inox 800ml")).not.toBe(
      productFamilyKey("shopee", "Garrafa Térmica Inox 800ml"),
    );
    expect(productFamilyKey("shopee", "Fone Azul")).toBeNull();
  });
});
