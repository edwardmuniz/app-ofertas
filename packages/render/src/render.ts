import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { imageSize } from "image-size";
import satori from "satori";
import {
  type BrandKit,
  CREATIVE_FORMATS,
  CREATIVE_TEMPLATES,
  type CreativeData,
  type CreativeFormat,
  type CreativeTemplateKey,
  type TemplateParams,
} from "./templates";

const require = createRequire(import.meta.url);
const font = (weight: 400 | 700 | 800) =>
  readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`));

let fonts: { name: string; data: Buffer; weight: 400 | 700 | 800; style: "normal" }[] | null = null;
export const loadFonts = () => {
  fonts ??= ([400, 700, 800] as const).map((weight) => ({
    name: "Inter",
    data: font(weight),
    weight,
    style: "normal" as const,
  }));
  return fonts;
};

export type RenderedImage = { png: Buffer; width: number; height: number };

/** Renderiza um template num formato. Devolve o PNG em tamanho cheio e uma prévia pequena. */
export async function renderCreative(input: {
  template: CreativeTemplateKey;
  format: CreativeFormat;
  data: CreativeData;
  brand: BrandKit;
  params?: TemplateParams;
  previewWidth?: number;
}): Promise<{ full: RenderedImage; preview: RenderedImage }> {
  const { width, height } = CREATIVE_FORMATS[input.format];
  const tree = CREATIVE_TEMPLATES[input.template].render(
    input.data,
    input.brand,
    input.params ?? {},
    width,
    height,
  );
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width,
    height,
    fonts: loadFonts(),
  });
  const toPng = (w: number) => {
    const out = new Resvg(svg, { fitTo: { mode: "width", value: w } }).render();
    return { png: Buffer.from(out.asPng()), width: out.width, height: out.height };
  };
  return { full: toPng(width), preview: toPng(input.previewWidth ?? 480) };
}

export const SUPPORTED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];

const TYPE_TO_MIME: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Lê tipo e dimensões pelo conteúdo (não confia na extensão nem no content-type). */
export function inspectImage(
  data: Buffer,
): { mime: ImageMime; width: number; height: number } | null {
  try {
    const info = imageSize(data);
    const mime = info.type ? TYPE_TO_MIME[info.type] : undefined;
    if (!mime || !info.width || !info.height) return null;
    return { mime, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

export type ValidationIssue = { code: string; message: string; hint: string };

const MAX_BYTES = 10 * 1024 * 1024;

/** Valida uma imagem para um formato de destino. */
export function validateImage(
  meta: { mime: string; width: number; height: number; size: number },
  format: CreativeFormat,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const target = CREATIVE_FORMATS[format];
  if (!(SUPPORTED_IMAGE_MIME as readonly string[]).includes(meta.mime)) {
    issues.push({
      code: "unsupported_type",
      message: `Tipo ${meta.mime} não suportado.`,
      hint: "Use PNG, JPEG ou WebP.",
    });
  }
  if (meta.size > MAX_BYTES) {
    issues.push({
      code: "too_large",
      message: "Arquivo maior que 10 MB.",
      hint: "Comprima a imagem.",
    });
  }
  if (meta.width < 600) {
    issues.push({
      code: "low_resolution",
      message: `Largura de ${meta.width}px.`,
      hint: "Use pelo menos 1080px de largura.",
    });
  }
  const ratio = meta.width / meta.height;
  const want = target.width / target.height;
  if (Math.abs(ratio - want) / want > 0.03) {
    issues.push({
      code: "aspect_ratio",
      message: `Proporção ${meta.width}x${meta.height} não bate com ${target.label}.`,
      hint: `Recorte para ${target.width}x${target.height}.`,
    });
  }
  return issues;
}

/** Formato mais próximo pela proporção. */
export function detectFormat(width: number, height: number): CreativeFormat {
  const ratio = width / height;
  let best: CreativeFormat = "wa_image";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const [key, f] of Object.entries(CREATIVE_FORMATS) as [
    CreativeFormat,
    { width: number; height: number },
  ][]) {
    const diff = Math.abs(ratio - f.width / f.height);
    if (diff < bestDiff) {
      best = key;
      bestDiff = diff;
    }
  }
  return best;
}
