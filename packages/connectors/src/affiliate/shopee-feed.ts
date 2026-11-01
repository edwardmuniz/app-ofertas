import type { ProductOffer } from "./types";

/**
 * Link de comissão da Shopee para qualquer página de produto, conforme o guia de links curtos:
 * s.shopee.com.br/an_redir?origin_link=<página>&affiliate_id=<id>&sub_id=<v1>-<v2>-…
 * Até 5 sub-ids (só letras e números), que voltam no relatório como utm_content.
 */
export function shopeeAffiliateLink(
  productUrl: string,
  affiliateId: string,
  subIds: string[] = [],
) {
  // O feed já traz a página embrulhada em an_redir: usa a página original.
  let origin = productUrl;
  try {
    const u = new URL(productUrl);
    origin = u.searchParams.get("origin_link") ?? productUrl;
  } catch {
    // mantém como veio
  }
  const subs = subIds
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 5);
  const params = [
    `origin_link=${encodeURIComponent(origin)}`,
    `affiliate_id=${encodeURIComponent(affiliateId)}`,
    ...(subs.length ? [`sub_id=${subs.join("-")}`] : []),
  ];
  return `https://s.shopee.com.br/an_redir?${params.join("&")}`;
}

/** ID de afiliado: só dígitos (aparece como utm_source=an_<id> nos seus links). */
export const isShopeeAffiliateId = (v: string) => /^\d{5,20}$/.test(v.trim());

/**
 * Lê CSV em fluxo (o feed tem centenas de MB): campos entre aspas podem ter vírgulas,
 * quebras de linha e aspas duplicadas. Devolve cada linha como objeto pelo cabeçalho.
 */
export async function* readCsvRecords(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Record<string, string>> {
  const decoder = new TextDecoder("utf-8");
  let header: string[] | null = null;
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  let first = true;

  const emit = function* (): Generator<Record<string, string>> {
    row.push(field);
    field = "";
    const done = row;
    row = [];
    if (!header) {
      header = done.map((h) => h.trim());
      return;
    }
    if (done.length === 1 && done[0] === "") return;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      rec[h] = done[i] ?? "";
    });
    yield rec;
  };

  for await (const chunk of chunks) {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (first) {
      text = text.replace(/^﻿/, "");
      first = false;
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string;
      if (pendingQuote) {
        pendingQuote = false;
        if (c === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (c === '"') pendingQuote = true;
        else field += c;
        continue;
      }
      if (c === '"' && field === "") quoted = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        if (field.endsWith("\r")) field = field.slice(0, -1);
        yield* emit();
      } else field += c;
    }
  }
  const tail = decoder.decode();
  if (tail) field += tail;
  if (pendingQuote) quoted = false;
  if (field !== "" || row.length) yield* emit();
}

const num = (v: string | undefined) => {
  const n = Number((v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Linha do feed da Shopee → produto. null = linha inválida (sem id, título ou preço). */
export function shopeeFeedItem(r: Record<string, string>): ProductOffer | null {
  const externalId = (r.itemid ?? "").trim();
  const title = (r.title ?? "").trim();
  const listPrice = num(r.price);
  const sale = num(r.sale_price) ?? listPrice;
  if (!externalId || !title || !sale || sale <= 0) return null;
  const original = listPrice && listPrice > sale ? listPrice : null;
  const discount =
    num(r.discount_percentage) ?? (original ? Math.round((1 - sale / original) * 100) : null);
  const url = (r.product_link ?? "").trim() || `https://shopee.com.br/product/0/${externalId}`;
  const images = [r.image_link, r.image_link_2, r.image_link_3]
    .map((v) => (v ?? "").trim())
    .filter((v) => v.startsWith("http"));
  const cats = [r.global_category1, r.global_category2, r.global_category3]
    .map((v) => (v ?? "").trim())
    .filter((v) => v && v !== "Others");
  const rating = num(r.item_rating);
  return {
    platform: "shopee",
    externalId,
    title,
    url,
    affiliateUrl: null,
    imageUrls: images,
    price: sale,
    originalPrice: original,
    discountPct: discount && discount > 0 ? Math.round(discount) : null,
    commissionRate: null,
    commissionValue: null,
    rating: rating && rating > 0 ? rating : null,
    soldCount: null,
    shopName: (r.shop_name ?? "").trim() || null,
    categoryIds: [r.global_catid1, r.global_catid2, r.global_catid3]
      .map((v) => (v ?? "").trim())
      .filter(Boolean),
    categoryName: cats.at(-1) ?? null,
    available: true,
    validUntil: null,
  };
}

/** Nomes em português das categorias principais da Shopee (o feed vem em inglês). */
export const SHOPEE_CATEGORY_PT: Record<string, string> = {
  "Home & Living": "Casa e Decoração",
  "Home Appliances": "Eletrodomésticos",
  "Mobile & Gadgets": "Celulares e Acessórios",
  "Computers & Accessories": "Computadores e Acessórios",
  Audio: "Áudio",
  "Cameras & Drones": "Câmeras e Drones",
  "Gaming & Consoles": "Games e Consoles",
  "Women Clothes": "Roupas Femininas",
  "Men Clothes": "Roupas Masculinas",
  "Women Shoes": "Calçados Femininos",
  "Men Shoes": "Calçados Masculinos",
  "Women Bags": "Bolsas Femininas",
  "Men Bags": "Bolsas Masculinas",
  "Fashion Accessories": "Acessórios de Moda",
  Watches: "Relógios",
  Jewellery: "Joias",
  Health: "Saúde",
  Beauty: "Beleza",
  "Baby & Kids Fashion": "Moda Infantil",
  "Mom & Baby": "Mães e Bebês",
  "Toys, Kids & Babies": "Brinquedos",
  "Toys & Hobbies": "Brinquedos e Hobbies",
  "Sports & Outdoors": "Esportes e Lazer",
  Automobiles: "Automotivo",
  Motorcycles: "Motos",
  "Spare Parts and Accessories for Vehicles": "Peças e Acessórios para Veículos",
  "Food & Beverages": "Alimentos e Bebidas",
  Pets: "Pets",
  Stationery: "Papelaria",
  "Books & Magazines": "Livros e Revistas",
  "Hobbies & Collections": "Hobbies e Coleções",
  "Tools & Home Improvement": "Ferramentas e Construção",
  "Travel & Luggage": "Viagem e Bagagem",
  "Muslim Fashion": "Moda Modesta",
  "Tickets, Vouchers & Services": "Vales e Serviços",
};
