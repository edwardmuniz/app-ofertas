import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, inspectImage, renderStudioFrames, type StudioScript } from "../src";

// PNG 1×1 vermelho.
const DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const script: StudioScript = {
  hook: "3 achadinhos de cozinha até R$ 100",
  subhook: "Amazon e Shopee",
  outro: "Entre no grupo e receba ofertas assim todo dia",
  handle: "go.ofzap.com.br/@achadinhos",
  items: [
    {
      title: "Air Fryer 4L",
      price: "R$ 249,00",
      originalPrice: "R$ 399,00",
      discountPct: 38,
      pixPrice: "R$ 229,00",
      installments: null,
      platform: "Amazon",
      images: [DOT, DOT],
    },
    {
      title: "Panela elétrica de arroz",
      price: "R$ 89,90",
      originalPrice: null,
      discountPct: null,
      pixPrice: null,
      installments: "3x de R$ 29,97 sem juros",
      platform: "Shopee",
      images: [],
    },
  ],
};

describe("estúdio", () => {
  it("carrossel: uma imagem por produto, em 1080×1350", async () => {
    const frames = await renderStudioFrames(script, DEFAULT_BRAND, "carousel");
    expect(frames).toHaveLength(4);
    expect(inspectImage(frames[1]?.png ?? Buffer.alloc(0))).toMatchObject({
      width: 1080,
      height: 1350,
    });
  });
});
