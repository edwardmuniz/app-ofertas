import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, detectFormat, inspectImage, renderCreative, validateImage } from "../src";

const data = {
  title: "Air Fryer Mondial 4L Digital com Timer e Desligamento Automático",
  price: "R$ 299,90",
  originalPrice: "R$ 499,90",
  discountPct: 40,
  coupon: "BF10",
  badge: "MENOR PREÇO 90 DIAS",
  platform: "Shopee",
  image: null,
};

describe("render", () => {
  it("gera PNG nas dimensões de cada formato, com prévia pequena", async () => {
    for (const [format, w, h] of [
      ["wa_image", 1080, 1080],
      ["feed_4x5", 1080, 1350],
      ["story_9x16", 1080, 1920],
    ] as const) {
      const out = await renderCreative({
        template: "card_preco",
        format,
        data,
        brand: DEFAULT_BRAND,
      });
      const meta = inspectImage(out.full.png);
      expect(meta).toEqual({ mime: "image/png", width: w, height: h });
      expect(out.preview.width).toBe(480);
      if (!meta) throw new Error("imagem inválida");
      expect(validateImage({ ...meta, size: out.full.png.length }, format)).toEqual([]);
      if (process.env.SAVE_RENDERS)
        writeFileSync(join(tmpdir(), `card_preco_${format}.png`), out.full.png);
    }
  });

  it("renderiza o template de cupom", async () => {
    const out = await renderCreative({
      template: "cupom_destaque",
      format: "feed_4x5",
      data,
      brand: DEFAULT_BRAND,
    });
    expect(inspectImage(out.full.png)?.height).toBe(1350);
  });

  it("valida proporção e resolução, e detecta o formato", () => {
    const issues = validateImage(
      { mime: "image/png", width: 500, height: 900, size: 1000 },
      "wa_image",
    );
    expect(issues.map((i) => i.code).sort()).toEqual(["aspect_ratio", "low_resolution"]);
    expect(detectFormat(1080, 1920)).toBe("story_9x16");
    expect(detectFormat(1200, 1500)).toBe("feed_4x5");
    expect(inspectImage(Buffer.from("não é imagem"))).toBeNull();
  });
});
