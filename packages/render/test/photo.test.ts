import { imageSize } from "image-size";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, renderCreative, toSquareJpeg } from "../src";

describe("foto de grupo", () => {
  it("converte PNG retangular em JPEG quadrado", async () => {
    const png = (
      await renderCreative({
        template: "card_preco",
        format: "story_9x16",
        data: {
          title: "Foto",
          price: "R$ 1",
          originalPrice: null,
          discountPct: null,
          coupon: null,
          badge: null,
          platform: "",
          image: null,
        },
        brand: DEFAULT_BRAND,
      })
    ).preview.png;
    expect(imageSize(png).type).toBe("png");

    const jpg = toSquareJpeg(png, 320);
    expect(imageSize(jpg)).toMatchObject({ type: "jpg", width: 320, height: 320 });
  });

  it("recusa o que não é imagem", () => {
    expect(() => toSquareJpeg(Buffer.from("<html>nada</html>"))).toThrow(/não suportado/);
  });
});
