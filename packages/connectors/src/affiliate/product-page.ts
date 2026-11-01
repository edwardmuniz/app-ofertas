import type { Platform } from "./types";

/** O que dá para tirar da página de um produto (tudo opcional: cada loja entrega uma parte). */
export type ProductPageData = {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  originalPrice: number | null;
  shopName: string | null;
};

const HOSTS: [RegExp, Platform][] = [
  [/(^|\.)shopee\.com\.br$|(^|\.)shope\.ee$/, "shopee"],
  [/(^|\.)mercadolivre\.com(\.br)?$|(^|\.)mercadolibre\.com$|(^|\.)meli\.la$/, "mercadolivre"],
  [
    /(^|\.)amazon\.com\.br$|(^|\.)amzn\.to$|(^|\.)a\.co$|(^|\.)link\.amazon$|(^|\.)amzlinks\.in$/,
    "amazon",
  ],
  [
    /(^|\.)magazineluiza\.com\.br$|(^|\.)magalu\.com(\.br)?$|(^|\.)divulgador\.magalu\.com$/,
    "magalu",
  ],
];

/** Plataforma pelo endereço (aceita links curtos de afiliado). */
export function platformOfUrl(raw: string): Platform | null {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
}

/** Id do produto na plataforma, a partir da URL da página do produto. */
export function productIdOfUrl(platform: Platform, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = decodeURIComponent(url.pathname);
  switch (platform) {
    case "shopee":
      return (
        path.match(/-i\.\d+\.(\d+)/)?.[1] ??
        path.match(/\/product\/\d+\/(\d+)/)?.[1] ??
        url.searchParams.get("itemId") ??
        null
      );
    case "mercadolivre": {
      const m = `${path}${url.hash}`.match(/MLB-?(\d+)/i);
      return m ? `MLB${m[1]}` : null;
    }
    case "amazon":
      return (
        path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null
      );
    case "magalu":
      return path.match(/\/p\/([a-z0-9]+)\/?/i)?.[1] ?? null;
  }
}

/** Link curto/de afiliado (em vez da página comum do produto). */
export function looksLikeAffiliateUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return (
      /^(s\.shopee\.com\.br|shope\.ee|meli\.la|amzn\.to|a\.co|link\.amazon|(r\.)?amzlinks\.in|divulgador\.magalu\.com)$/.test(
        host,
      ) ||
      url.pathname.startsWith("/sec/") ||
      url.searchParams.has("tag") ||
      url.searchParams.has("mpid") ||
      [...url.searchParams.keys()].some(
        (k) => k.startsWith("utm_") && /an_|afil/i.test(url.searchParams.get(k) ?? ""),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Página intermediária de link curto (ex.: link.amazon → amzlinks.in) que não redireciona para
 * robôs, mas traz o endereço da loja dentro dela (`btn_url=` ou `<base href>`).
 */
export function embeddedStoreUrl(html: string): string | null {
  const candidates: string[] = [];
  for (const m of html.matchAll(/[?&](?:amp;)?(?:btn_url|url|u)=([^&"'\s>]+)/gi)) {
    try {
      candidates.push(decodeURIComponent(m[1] ?? ""));
    } catch {
      // ignora valor malformado
    }
  }
  const base = html.match(/<base[^>]+href=["']([^"']+)["']/i)?.[1];
  if (base) candidates.push(base.replace(/&amp;/g, "&"));
  for (const c of candidates) {
    const platform = platformOfUrl(c);
    if (platform && productIdOfUrl(platform, c)) return c;
  }
  return null;
}

/** Título a partir do trecho legível da URL (Shopee: "Nome-Do-Produto-i.123.456"). */
export function titleFromUrl(raw: string): string | null {
  try {
    const seg = decodeURIComponent(new URL(raw).pathname.split("/").filter(Boolean)[0] ?? "");
    const slug = seg
      .replace(/-i\.\d+\.\d+$/, "")
      .replace(/^MLB-?\d+-/i, "")
      .replace(/-_JM$/i, "")
      .replace(/-MLB-?\d+.*$/i, "");
    if (!/[a-zà-ú]/i.test(slug) || !slug.includes("-")) return null;
    const title = slug.replace(/[-_]+/g, " ").trim();
    return title.length >= 6 ? title : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ordm: "º",
  ordf: "ª",
  deg: "°",
  reg: "®",
  trade: "™",
  copy: "©",
  ndash: "–",
  mdash: "—",
};
const ACCENT: Record<string, string> = {
  acute: "\u0301",
  grave: "\u0300",
  tilde: "\u0303",
  circ: "\u0302",
  uml: "\u0308",
};
/** Decodifica entidades HTML, inclusive acentos nomeados (&iacute; &ccedil; &atilde;…). */
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n: string) => {
      if (ENTITIES[n.toLowerCase()]) return ENTITIES[n.toLowerCase()] as string;
      if (n === "ccedil") return "ç";
      if (n === "Ccedil") return "Ç";
      const acc = n.match(/^([a-zA-Z])(acute|grave|tilde|circ|uml)$/);
      return acc ? `${acc[1]}${ACCENT[acc[2] as string]}`.normalize("NFC") : m;
    })
    .trim();

/** Tira o nome da loja do fim do título ("… | Amazon.com.br", "… - Mercado Livre"). */
const cleanTitle = (t: string | null) =>
  t
    ? t
        .replace(
          /\s*[|:\-–]\s*(Amazon\.com\.br|Mercado Livre|Magazine Luiza|Magalu|Shopee Brasil|Shopee)\s*$/i,
          "",
        )
        .replace(/^Amazon\.com\.br\s*:\s*/i, "")
        .trim() || null
    : null;

/** Converte "R$ 1.299,90", "1299.90" ou 1299.9 em número. */
export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function metaTags(html: string) {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag
      .match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    const value = content?.[1] ?? content?.[2];
    if (key && value && !out.has(key)) out.set(key, decode(value));
  }
  return out;
}

type JsonNode = Record<string, unknown>;

function findProductLd(html: string): JsonNode | null {
  const blocks = html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(raw ?? "");
    } catch {
      continue;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node && typeof node === "object") {
        const n = node as JsonNode;
        const type = n["@type"];
        if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return n;
        if (n["@graph"]) stack.push(n["@graph"]);
      }
    }
  }
  return null;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? decode(v) : null);

/** Lê título, foto, preço e loja de Open Graph, JSON-LD (schema.org/Product) e metatags de preço. */
export function parseProductPage(html: string, pageUrl: string): ProductPageData {
  const meta = metaTags(html);
  const ld = findProductLd(html);
  const offer = first(ld?.offers) as JsonNode | undefined;
  const ldImage = first(ld?.image);
  const brand = first(ld?.brand) as JsonNode | string | undefined;
  const seller = (offer?.seller ?? null) as JsonNode | null;

  let imageUrl =
    str(typeof ldImage === "object" && ldImage ? (ldImage as JsonNode).url : ldImage) ??
    meta.get("og:image:secure_url") ??
    meta.get("og:image") ??
    meta.get("twitter:image") ??
    null;
  if (imageUrl) {
    try {
      imageUrl = new URL(imageUrl, pageUrl).toString();
    } catch {
      imageUrl = null;
    }
  }
  // Logo da loja no lugar da foto (o Mercado Livre devolve a logo quando bloqueia a leitura).
  if (imageUrl && /\/frontend-assets\/|_logo_/i.test(imageUrl)) imageUrl = null;

  const title = cleanTitle(
    str(ld?.name) ??
      meta.get("og:title") ??
      meta.get("twitter:title") ??
      str(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]) ??
      null,
  );

  const price =
    parsePrice(offer?.price) ??
    parsePrice(offer?.lowPrice) ??
    parsePrice(meta.get("product:price:amount")) ??
    parsePrice(meta.get("og:price:amount")) ??
    parsePrice(meta.get("price")) ??
    null;
  const originalPrice =
    parsePrice(meta.get("product:original_price:amount")) ??
    parsePrice((offer?.priceSpecification as JsonNode | undefined)?.price) ??
    null;

  return {
    title,
    imageUrl,
    price,
    originalPrice: originalPrice && price && originalPrice > price ? originalPrice : null,
    shopName:
      str(seller?.name) ??
      (typeof brand === "string" ? str(brand) : str(brand?.name)) ??
      meta.get("og:site_name") ??
      null,
  };
}

/** Títulos genéricos (página inicial/anti-robô) que não servem como nome do produto. */
export function isGenericTitle(title: string | null) {
  if (!title) return true;
  return (
    /^(shopee|mercado livre|amazon|magazine luiza|magalu)\b.*(ofertas|compre|melhores|frete)/i.test(
      title,
    ) || /^(shopee|amazon\.com\.br|mercado livre|magalu)$/i.test(title.trim())
  );
}
