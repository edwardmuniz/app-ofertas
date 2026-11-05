import { parsePrice } from "./product-page";
import {
  type AffiliateConnector,
  ConnectorError,
  type Installments,
  type PageReader,
  type ProductOffer,
  type SearchQuery,
  type SearchResult,
  type SearchSort,
  type StoreCoupon,
} from "./types";

// Amazon (Associados Amazon.com.br).
// - Só com a tag de associado: link de afiliado montado com `?tag=`; busca pela página de
//   resultados da Amazon e preço lido da página do produto.
// - Com credenciais da Creators API (sucessora da PA-API 5, desligada em 2026): busca e consulta
//   pela API. Acesso exige 10 vendas qualificadas em 30 dias.

export const AMAZON_HOST = "https://www.amazon.com.br";
export const CREATORS_API = "https://creatorsapi.amazon";
/** Token da Creators API para contas da região América do Norte (inclui o Brasil, versão 3.1). */
export const AMAZON_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const MARKETPLACE = "www.amazon.com.br";

/** Tags de associado do Brasil terminam em -20 (ex.: minhaloja-20). */
export const isAmazonTag = (tag: string) => /^[a-z0-9][a-z0-9-]{1,60}-\d{2}$/i.test(tag.trim());

/** ASIN do produto a partir da URL (/dp/, /gp/product/, /gp/aw/d/). */
export function asinOfUrl(raw: string): string | null {
  try {
    const path = decodeURIComponent(new URL(raw).pathname);
    return (
      path
        .match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]
        ?.toUpperCase() ?? null
    );
  } catch {
    return /^[A-Z0-9]{10}$/i.test(raw) ? raw.toUpperCase() : null;
  }
}

export const amazonProductUrl = (asin: string) => `${AMAZON_HOST}/dp/${asin}`;

/**
 * Link de afiliado no formato oficial: página do produto com `?tag=`. A Amazon não aceita
 * encurtador que esconda o destino, por isso o link vai direto (sem o redirecionador próprio).
 */
export function amazonAffiliateLink(productUrl: string, tag: string): string {
  const asin = asinOfUrl(productUrl);
  if (asin) return `${amazonProductUrl(asin)}?tag=${encodeURIComponent(tag.trim())}`;
  const url = new URL(productUrl);
  url.searchParams.set("tag", tag.trim());
  return url.toString();
}

// ── Leitura da página do produto ────────────────────────────────

export type AmazonPageData = {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  originalPrice: number | null;
  rating: number | null;
  reviews: number | null;
  /** null = a página não diz */
  available: boolean | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Preço no Pix (menor que o preço normal) */
  pixPrice: number | null;
  installments: Installments | null;
  /** Cupom do anúncio principal ("Aplicar cupom de 10%"). */
  coupon: StoreCoupon | null;
  /** Página anti-robô (captcha): não dá para concluir nada. */
  blocked: boolean;
};

/** Preço "no Pix": o último preço exibido antes do texto "no Pix". */
function pixPriceOf(html: string, price: number | null): number | null {
  const at = html.search(/>\s*no Pix/);
  if (at < 0) return null;
  const before = html.slice(Math.max(0, at - 6000), at);
  const all = [...before.matchAll(/class="a-offscreen">\s*(R\$\s*[\d.,]+)/g)];
  const pix = parsePrice(all.at(-1)?.[1] ?? null);
  return pix && (!price || pix < price) ? pix : null;
}

/** Parcelamento ("5x de R$ 30,78 sem juros"), preferindo a oferta sem juros. */
function installmentsOf(html: string): Installments | null {
  const free = html.match(/(\d{1,2})x de R\$\s*([\d.,]+)\s*sem juros/);
  const any = free ?? html.match(/em até\s*<\/span>\s*<span[^>]*>\s*(\d{1,2})x de R\$\s*([\d.,]+)/);
  const count = Number(any?.[1]);
  const value = parsePrice(any?.[2] ?? null);
  if (!any || !value || count < 2) return null;
  return { count, value, interestFree: Boolean(free) };
}

/** Texto visível do trecho de HTML (sem tags, espaços juntados). */
const textOf = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

const couponValue = (v: string) =>
  v
    .replace(/\s+/g, " ")
    .replace(/(\d)\s*%/, "$1%")
    .trim();

/**
 * Cupom anunciado no texto: "Aplicar cupom de 10%", "Economize R$ 20,00 com cupom" (cupom de
 * marcar na página, sem código) ou "com o código PROMO10" (código promocional).
 */
export function amazonCouponOf(text: string): StoreCoupon | null {
  const code = text.match(/c[óo]digo(?:\s+promocional)?\s*:?\s+([A-Z0-9]{4,20})\b/)?.[1];
  const value =
    text.match(/Aplicar\s+cupom\s+de\s+(R\$\s*[\d.,]+|\d{1,2}\s*%)/i)?.[1] ??
    text.match(
      /Economize\s+(R\$\s*[\d.,]+|\d{1,2}\s*%)\s+com\s+(?:o\s+)?(?:cupom|c[óo]digo)/i,
    )?.[1] ??
    null;
  if (code) {
    return {
      code,
      description: value ? `${couponValue(value)} de desconto` : "Código promocional",
    };
  }
  if (!value) return null;
  return {
    code: null,
    description: `Cupom de ${couponValue(value)}: marque “Aplicar cupom” na página antes de comprar`,
  };
}

/** Cupom do anúncio principal (bloco de preço e promoções, não os carrosséis de outros produtos). */
function pageCouponOf(html: string): StoreCoupon | null {
  const at = html.search(
    /id="(?:promoPriceBlockMessage_feature_div|couponText|couponBadge|vpcButton|applicable_promotion_list_sec)/,
  );
  if (at < 0) return null;
  return amazonCouponOf(textOf(html.slice(at, at + 5000)));
}

const clean = (s: string | undefined | null) =>
  s
    ? s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim() || null
    : null;

export function parseAmazonPage(html: string): AmazonPageData {
  const title =
    clean(html.match(/<span[^>]*id="productTitle"[^>]*>([^<]+)/)?.[1]) ??
    clean(html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)?.[1]);
  const blocked = !title && /captcha|validateCaptcha|opfcaptcha|Digite os caracteres/i.test(html);

  // Foto em alta (a og:image da Amazon é uma arte com a nota por cima).
  const imageUrl =
    html.match(/data-old-hires="(https:[^"]+)"/)?.[1] ??
    html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ??
    html.match(/"large":"(https:[^"]+)"/)?.[1] ??
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/)?.[1] ??
    null;

  // Preço do anúncio principal (dados da página), com o texto visível como reserva.
  const price =
    parsePrice(Number(html.match(/"priceAmount":([0-9]+(?:\.[0-9]+)?)/)?.[1])) ??
    parsePrice(
      html.match(/id="corePrice[^"]*"[\s\S]{0,3000}?class="a-offscreen">([^<]+)/)?.[1] ?? null,
    );
  const basis = html.match(/basisPrice"[\s\S]{0,800}?class="a-offscreen">([^<]+)/)?.[1];
  const originalPrice = parsePrice(basis ?? null);

  const ratingText = html.match(/id="acrPopover"[^>]*title="([0-9]+,[0-9]+|[0-9]+) de 5/)?.[1];
  const reviewsText = html.match(/id="acrCustomerReviewText"[^>]*>\(?([0-9.]+)/)?.[1];

  const availability = clean(
    html.match(/id="availability"[\s\S]{0,600}?<span[^>]*>([^<]+)</)?.[1]?.replace(/<[^>]+>/g, ""),
  );
  let available: boolean | null = null;
  if (availability) {
    if (/indispon|não disponível|nao disponivel|esgotado/i.test(availability)) available = false;
    else if (/estoque|dispon|envio|unidade|restam/i.test(availability)) available = true;
  }
  // Sem anúncio principal (só "Ver todas as opções de compra"): não há preço fixo para divulgar.
  if (!price && html.includes("buybox-see-all-buying-choices")) {
    available = false;
  }
  if (available === null && price) available = true;

  const crumb = html.match(
    /wayfinding-breadcrumbs[\s\S]{0,600}?href="[^"]*node=(\d+)[^"]*"[^>]*>([^<]+)</,
  );

  return {
    title,
    imageUrl,
    price,
    originalPrice: originalPrice && price && originalPrice > price ? originalPrice : null,
    rating: ratingText ? Number(ratingText.replace(",", ".")) : null,
    reviews: reviewsText ? Number(reviewsText.replace(/\./g, "")) : null,
    available,
    categoryId: crumb?.[1] ?? null,
    categoryName: clean(crumb?.[2]),
    pixPrice: pixPriceOf(html, price),
    installments: price ? installmentsOf(html) : null,
    coupon: pageCouponOf(html),
    blocked,
  };
}

/** Galeria de fotos em alta da página do produto (na ordem da página, sem repetir). */
export function amazonImages(html: string, max = 8): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/"hiRes":"(https:[^"]+)"/g)) {
    const url = m[1];
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

const discountOf = (price: number, original: number | null) =>
  original && original > price ? Math.round((1 - price / original) * 100) : null;

// ── Busca pela página de resultados (sem a Creators API) ────────

export type AmazonSearchItem = {
  asin: string;
  title: string;
  imageUrl: string | null;
  price: number;
  originalPrice: number | null;
  rating: number | null;
  reviews: number | null;
  /** "Mais de 1 mil compras no mês passado" → 1000 */
  boughtLastMonth: number | null;
  installments: Installments | null;
  coupon: StoreCoupon | null;
};

/** Ordenação na própria Amazon (desconto e comissão são ordenados depois, no sistema). */
const PAGE_SORT: Partial<Record<SearchSort, string>> = {
  sales: "exact-aware-popularity-rank",
  price_asc: "price-asc-rank",
  price_desc: "price-desc-rank",
};

/** URL da busca: palavra-chave, departamento (nó), faixa de preço (centavos) e página. */
export function amazonSearchUrl(q: SearchQuery): string {
  const url = new URL("/s", AMAZON_HOST);
  url.searchParams.set("k", q.keyword?.trim() || (q.categoryId ? "" : "ofertas"));
  if (!url.searchParams.get("k")) url.searchParams.delete("k");
  const refine: string[] = [];
  if (q.categoryId) refine.push(`n:${q.categoryId}`);
  if (q.priceMin || q.priceMax) {
    const min = q.priceMin ? Math.round(q.priceMin * 100) : "";
    const max = q.priceMax ? Math.round(q.priceMax * 100) : "";
    refine.push(`p_36:${min}-${max}`);
  }
  if (refine.length) url.searchParams.set("rh", refine.join(","));
  const sort = PAGE_SORT[q.sort ?? "relevance"];
  if (sort) url.searchParams.set("s", sort);
  if (q.page && q.page > 1) url.searchParams.set("page", String(Math.min(q.page, 20)));
  return url.toString();
}

/** Foto sem o sufixo de tamanho (._AC_UL320_): a Amazon devolve a original. */
const fullImage = (src: string | undefined) =>
  src ? src.replace(/\._[^/]*_\.(jpg|jpeg|png|webp)$/i, ".$1") : null;

const countOf = (raw: string | undefined, thousand: boolean) => {
  if (!raw) return null;
  const n = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(thousand ? n * 1000 : n) : null;
};

export function parseAmazonSearch(html: string): {
  items: AmazonSearchItem[];
  hasMore: boolean;
  blocked: boolean;
} {
  const card = /<div[^>]*data-asin="[A-Z0-9]{10}"[^>]*data-component-type="s-search-result"/;
  const blocks = html
    .split(new RegExp(`(?=${card.source})`))
    .filter((b) => card.test(b.slice(0, 600)) && b.startsWith("<div"));
  const seen = new Set<string>();
  const items: AmazonSearchItem[] = [];
  for (const b of blocks) {
    const asin = b.match(/data-asin="([A-Z0-9]{10})"/)?.[1];
    if (!asin || seen.has(asin)) continue;
    // O título é o maior h2 (alguns cards têm a marca num h2 separado).
    const titles = [...b.matchAll(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/g)]
      .map((m) => clean(m[1]))
      .filter((t): t is string => Boolean(t));
    const title = titles.sort((x, y) => y.length - x.length)[0];
    // Preço de venda: `a-price` exato (o "De" e a parcela usam `a-price a-text-price`).
    const price = parsePrice(
      b.match(/class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]+)/)?.[1] ?? null,
    );
    if (!title || !price) continue;
    seen.add(asin);
    const original = parsePrice(
      b.match(/data-a-strike="true"[^>]*>\s*<span class="a-offscreen">([^<]+)/)?.[1] ?? null,
    );
    const inst = b.match(/(\d{1,2})x de\s*<\/span>[\s\S]{0,250}?class="a-offscreen">([^<]+)</);
    const instValue = parsePrice(inst?.[2] ?? null);
    const instCount = Number(inst?.[1]);
    const bought = b.match(/Mais de ([\d.,]+)[\s ]*(mil)?[\s ]*compras/);
    const rating = b.match(/a-icon-alt">([0-9]+(?:,[0-9])?) de 5/)?.[1];
    items.push({
      asin,
      title,
      imageUrl: fullImage(b.match(/<img[^>]*class="s-image"[^>]*src="([^"]+)"/)?.[1]),
      price,
      originalPrice: original && original > price ? original : null,
      rating: rating ? Number(rating.replace(",", ".")) : null,
      reviews: countOf(b.match(/aria-label="([\d.]+) classifica/)?.[1], false),
      boughtLastMonth: countOf(bought?.[1], Boolean(bought?.[2])),
      installments:
        inst && instValue && instCount >= 2
          ? {
              count: instCount,
              value: instValue,
              interestFree: /sem juros/.test(b.slice(inst.index, (inst.index ?? 0) + 600)),
            }
          : null,
      coupon: amazonCouponOf(textOf(b)),
    });
  }
  const next = html.match(/<[^>]*s-pagination-next[^>]*>/)?.[0];
  const blocked =
    blocks.length === 0 && /captcha|validateCaptcha|opfcaptcha|Digite os caracteres/i.test(html);
  return { items, hasMore: Boolean(next && !/disabled/.test(next)), blocked };
}

// ── Creators API ────────────────────────────────────────────────

type Money = { amount?: number; displayAmount?: string };
type CreatorsItem = {
  asin: string;
  detailPageURL?: string;
  images?: { primary?: { large?: { url?: string }; medium?: { url?: string } } };
  itemInfo?: { title?: { displayValue?: string } };
  browseNodeInfo?: { browseNodes?: { id?: string; displayName?: string }[] };
  offersV2?: {
    listings?: {
      isBuyBoxWinner?: boolean;
      price?: {
        money?: Money;
        savingBasis?: { money?: Money };
        savings?: { money?: Money; percentage?: number };
      };
      availability?: { type?: string };
      merchantInfo?: { name?: string };
      dealDetails?: { endTime?: string };
    }[];
  };
};

const RESOURCES = [
  "itemInfo.title",
  "images.primary.large",
  "offersV2.listings.price",
  "offersV2.listings.availability",
  "offersV2.listings.merchantInfo",
  "offersV2.listings.isBuyBoxWinner",
  "offersV2.listings.dealDetails",
  "browseNodeInfo.browseNodes",
];

const SORT_BY: Partial<Record<SearchSort, string>> = {
  relevance: "Relevance",
  sales: "Featured",
  price_asc: "Price:LowToHigh",
  price_desc: "Price:HighToLow",
};

export function mapCreatorsItem(i: CreatorsItem): ProductOffer | null {
  const listings = i.offersV2?.listings ?? [];
  const listing = listings.find((l) => l.isBuyBoxWinner) ?? listings[0];
  const price = listing?.price?.money?.amount;
  if (!price) return null;
  const original = listing?.price?.savingBasis?.money?.amount ?? null;
  const node = i.browseNodeInfo?.browseNodes?.[0];
  const end = listing?.dealDetails?.endTime ? new Date(listing.dealDetails.endTime) : null;
  return {
    platform: "amazon",
    externalId: i.asin,
    title: i.itemInfo?.title?.displayValue ?? i.asin,
    url: amazonProductUrl(i.asin),
    // O link da API já traz a tag e não pode ser alterado (regra da Amazon).
    affiliateUrl: i.detailPageURL ?? null,
    imageUrls: [i.images?.primary?.large?.url ?? i.images?.primary?.medium?.url].filter(
      (u): u is string => Boolean(u),
    ),
    price,
    originalPrice: original && original > price ? original : null,
    discountPct: listing?.price?.savings?.percentage ?? discountOf(price, original),
    // A Amazon não informa comissão por item (tabela por categoria no portal).
    commissionRate: null,
    commissionValue: null,
    rating: null,
    soldCount: null,
    shopName: listing?.merchantInfo?.name ?? null,
    categoryIds: node?.id ? [node.id] : [],
    categoryName: node?.displayName ?? null,
    available: !/OUT_OF_STOCK|UNAVAILABLE/i.test(listing?.availability?.type ?? ""),
    validUntil: end && !Number.isNaN(end.getTime()) ? end : null,
  };
}

export type AmazonCredentials = {
  partner_tag: string;
  credential_id?: string;
  credential_secret?: string;
};

type AmazonOptions = {
  fetch?: typeof fetch;
  fetchPage?: PageReader;
  now?: () => number;
};

export class AmazonConnector implements AffiliateConnector {
  readonly platform = "amazon" as const;
  readonly capabilities;
  private readonly tag: string;
  private readonly api: { id: string; secret: string } | null;
  private token: { value: string; until: number } | null = null;

  constructor(
    creds: AmazonCredentials,
    private readonly opts: AmazonOptions = {},
  ) {
    this.tag = (creds.partner_tag ?? "").trim();
    if (!isAmazonTag(this.tag)) {
      throw new ConnectorError(
        "amazon",
        "AUTH",
        "Tag de associado inválida (ex.: minhaloja-20). Veja em Associados › Gerenciar IDs de rastreamento.",
      );
    }
    const id = creds.credential_id?.trim();
    const secret = creds.credential_secret?.trim();
    this.api = id && secret ? { id, secret } : null;
    this.capabilities = {
      // Sem a API, a busca lê a página de resultados da Amazon.
      search: this.api !== null || Boolean(opts.fetchPage),
      lookup: true,
      linkGeneration: true,
      // A Amazon não tem sub-ids: cada canal pode ter uma tag própria no portal.
      subIds: 0,
      conversionsReport: false,
    };
  }

  private async accessToken() {
    const at = this.opts.now?.() ?? Date.now();
    if (this.token && this.token.until > at) return this.token.value;
    const res = await this.request(AMAZON_TOKEN_URL, {
      grant_type: "client_credentials",
      client_id: this.api?.id,
      client_secret: this.api?.secret,
      scope: "creatorsapi::default",
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    } | null;
    if (!res.ok || !body?.access_token) {
      throw new ConnectorError(
        "amazon",
        res.status === 400 || res.status === 401 ? "AUTH" : "UNAVAILABLE",
        `Amazon recusou as credenciais da Creators API${body?.error_description ? `: ${body.error_description}` : ""}.`,
      );
    }
    // Renova um minuto antes de vencer.
    this.token = {
      value: body.access_token,
      until: at + ((body.expires_in ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  private async request(url: string, body: unknown, token?: string) {
    try {
      return await (this.opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}`, "x-marketplace": MARKETPLACE } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ConnectorError("amazon", "UNAVAILABLE", `Amazon indisponível: ${String(err)}`);
    }
  }

  // [VERIFICAR com credenciais reais] caminho de searchItems e a chave da lista em getItems
  // (a documentação mostra `itemsResult` e `itemResults`).
  private async call<T>(operation: "searchItems" | "getItems", body: Record<string, unknown>) {
    const token = await this.accessToken();
    const res = await this.request(
      `${CREATORS_API}/catalog/v1/${operation}`,
      { ...body, partnerTag: this.tag, marketplace: MARKETPLACE, resources: RESOURCES },
      token,
    );
    if (res.status === 429) {
      throw new ConnectorError("amazon", "RATE_LIMIT", "Limite de requisições da Amazon atingido.");
    }
    if (res.status >= 500) {
      throw new ConnectorError("amazon", "UNAVAILABLE", `Amazon respondeu ${res.status}.`);
    }
    const data = (await res.json().catch(() => null)) as
      | (T & { errors?: { code?: string; message?: string }[] })
      | null;
    if (!res.ok) {
      const e = data?.errors?.[0];
      throw new ConnectorError(
        "amazon",
        res.status === 401 || res.status === 403 ? "AUTH" : "INVALID",
        `Amazon: ${e?.message ?? `respondeu ${res.status}`}`,
      );
    }
    return data as T & { errors?: { code?: string; message?: string }[] };
  }

  async ping() {
    // Sem API, a tag foi conferida no construtor (não há como testá-la sem uma venda).
    if (this.api) await this.accessToken();
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    if (!this.api) return this.searchPage(q);
    const itemCount = Math.min(q.limit ?? 10, 10);
    const itemPage = Math.min(q.page ?? 1, 10);
    const data = await this.call<{
      searchResult?: { items?: CreatorsItem[]; totalResultCount?: number };
    }>("searchItems", {
      keywords: q.keyword || "ofertas",
      ...(q.categoryId ? { browseNodeId: q.categoryId } : {}),
      itemCount,
      itemPage,
      sortBy: SORT_BY[q.sort ?? "relevance"] ?? "Relevance",
      ...(q.minDiscount ? { minSavingPercent: Math.min(99, Math.round(q.minDiscount)) } : {}),
      ...(q.priceMin ? { minPrice: Math.round(q.priceMin * 100) } : {}),
      ...(q.priceMax ? { maxPrice: Math.round(q.priceMax * 100) } : {}),
      ...(q.minRating ? { minReviewsRating: Math.min(4, Math.floor(q.minRating)) } : {}),
    });
    const raw = data.searchResult?.items ?? [];
    const items = raw.map(mapCreatorsItem).filter((i): i is ProductOffer => i !== null);
    const total = data.searchResult?.totalResultCount ?? 0;
    return { items, hasMore: itemPage < 10 && itemPage * itemCount < total };
  }

  async lookup(externalId: string): Promise<ProductOffer | null> {
    const asin = asinOfUrl(externalId);
    if (!asin) return null;
    if (this.api) {
      const data = await this.call<{
        itemsResult?: { items?: CreatorsItem[] };
        itemResults?: { items?: CreatorsItem[] };
      }>("getItems", { itemIds: [asin], itemIdType: "ASIN" });
      const found = (data.itemsResult?.items ?? data.itemResults?.items ?? []).find(
        (i) => i.asin === asin,
      );
      return found ? mapCreatorsItem(found) : null;
    }
    return this.lookupPage(asin);
  }

  /** Sem API: uma página de resultados da Amazon (cerca de 48 produtos). */
  private async searchPage(q: SearchQuery): Promise<SearchResult> {
    const page = await this.readPage(amazonSearchUrl(q));
    const r = parseAmazonSearch(page.html);
    if (r.blocked) {
      throw new ConnectorError(
        "amazon",
        "UNAVAILABLE",
        "A Amazon pediu verificação de robô; tente de novo em instantes.",
      );
    }
    const items = r.items.slice(0, q.limit ?? 48).map((i): ProductOffer => {
      const url = amazonProductUrl(i.asin);
      return {
        platform: "amazon",
        externalId: i.asin,
        title: i.title,
        url,
        affiliateUrl: amazonAffiliateLink(url, this.tag),
        imageUrls: i.imageUrl ? [i.imageUrl] : [],
        price: i.price,
        originalPrice: i.originalPrice,
        discountPct: discountOf(i.price, i.originalPrice),
        commissionRate: null,
        commissionValue: null,
        rating: i.rating,
        soldCount: i.boughtLastMonth,
        shopName: null,
        categoryIds: q.categoryId ? [q.categoryId] : [],
        categoryName: null,
        available: true,
        validUntil: null,
        // O Pix só aparece na página do produto (lido ao salvar e antes de cada envio).
        pixPrice: null,
        installments: i.installments,
        coupon: i.coupon,
      };
    });
    return { items, hasMore: r.hasMore || r.items.length > items.length };
  }

  private async readPage(url: string) {
    if (!this.opts.fetchPage) {
      throw new ConnectorError("amazon", "UNSUPPORTED", "Leitura de página indisponível.");
    }
    let page: Awaited<ReturnType<PageReader>>;
    try {
      page = await this.opts.fetchPage(url);
    } catch (err) {
      throw new ConnectorError(
        "amazon",
        "UNAVAILABLE",
        `Página da Amazon não abriu: ${String(err)}`,
      );
    }
    if (page.status >= 400 && page.status !== 404) {
      throw new ConnectorError("amazon", "UNAVAILABLE", `Amazon respondeu ${page.status}.`);
    }
    return page;
  }

  /** Sem API: lê a página do produto. Falha de leitura vira erro (a oferta não expira por isso). */
  private async lookupPage(asin: string): Promise<ProductOffer | null> {
    const page = await this.readPage(amazonProductUrl(asin));
    if (page.status === 404) return null;
    const d = parseAmazonPage(page.html);
    if (d.blocked || !d.title) {
      throw new ConnectorError(
        "amazon",
        "UNAVAILABLE",
        "A Amazon pediu verificação de robô; tente de novo em instantes.",
      );
    }
    if (d.available === false) {
      return this.offerFromPage(asin, d, 0, false);
    }
    if (!d.price) {
      throw new ConnectorError("amazon", "UNAVAILABLE", "Não deu para ler o preço na Amazon.");
    }
    return this.offerFromPage(asin, d, d.price, true);
  }

  private offerFromPage(
    asin: string,
    d: AmazonPageData,
    price: number,
    available: boolean,
  ): ProductOffer {
    return {
      platform: "amazon",
      externalId: asin,
      title: d.title ?? asin,
      url: amazonProductUrl(asin),
      affiliateUrl: amazonAffiliateLink(amazonProductUrl(asin), this.tag),
      imageUrls: d.imageUrl ? [d.imageUrl] : [],
      price,
      originalPrice: d.originalPrice,
      discountPct: discountOf(price, d.originalPrice),
      commissionRate: null,
      commissionValue: null,
      rating: d.rating,
      soldCount: null,
      shopName: null,
      categoryIds: d.categoryId ? [d.categoryId] : [],
      categoryName: d.categoryName,
      available,
      validUntil: null,
      pixPrice: d.pixPrice,
      installments: d.installments,
      coupon: d.coupon,
    };
  }

  async generateLink(productUrl: string, _subIds: string[]) {
    return amazonAffiliateLink(productUrl, this.tag);
  }
}
