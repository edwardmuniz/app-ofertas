import { Resvg } from "@resvg/resvg-js";
import { imageSize } from "image-size";
import jpeg from "jpeg-js";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Converte qualquer imagem (PNG, JPEG, GIF, WebP) em JPEG quadrado, cortado no centro.
 * O WhatsApp só aceita foto de grupo em JPEG ("the given data is not a valid image").
 * Usa o resvg (já usado nos criativos) para ler e recortar e o jpeg-js para codificar.
 */
export function toSquareJpeg(data: Buffer, size = 640, quality = 85): Buffer {
  let type: string | undefined;
  try {
    type = imageSize(data).type;
  } catch {
    type = undefined;
  }
  const mime = type ? MIME[type] : undefined;
  if (!mime) throw new Error("Formato de imagem não suportado (use JPEG, PNG, GIF ou WebP).");
  const href = `data:${mime};base64,${data.toString("base64")}`;
  // Fundo branco: JPEG não tem transparência.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><image width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" xlink:href="${href}"/></svg>`;
  const out = new Resvg(svg).render();
  return jpeg.encode(
    { data: Buffer.from(out.pixels), width: out.width, height: out.height },
    quality,
  ).data;
}
