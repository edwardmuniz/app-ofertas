import { createHash } from "node:crypto";
import {
  type AffiliateConnector,
  ConnectorError,
  type ProductOffer,
  type SearchQuery,
  type SearchResult,
  type SearchSort,
  sanitizeSubId,
} from "./types";

// Shopee Affiliate Open API (GraphQL).
// [VERIFICAR com credenciais reais] endpoint, códigos de sortType, campos e formato dos erros.
export const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

const SORT_TYPE: Record<SearchSort, number> = {
  relevance: 1,
  sales: 2,
  price_desc: 3,
  price_asc: 4,
  commission: 5,
  // Sem ordenação por desconto na API: usa relevância e ordena depois.
  discount: 1,
};

const OFFER_FIELDS = `itemId productName price priceMin priceMax priceDiscountRate
  commissionRate commission sales ratingStar imageUrl shopName productLink offerLink
  periodEndTime productCatIds`;

const SEARCH_QUERY = `query Search($keyword: String, $sortType: Int, $page: Int, $limit: Int, $productCatId: Int, $itemId: Int64) {
  productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit, productCatId: $productCatId, itemId: $itemId) {
    nodes { ${OFFER_FIELDS} }
    pageInfo { page limit hasNextPage }
  }
}`;

const SHORT_LINK_MUTATION = `mutation ShortLink($originUrl: String!, $subIds: [String]) {
  generateShortLink(input: { originUrl: $originUrl, subIds: $subIds }) { shortLink }
}`;

type ShopeeNode = {
  itemId: number | string;
  productName: string;
  price?: string | null;
  priceMin?: string | null;
  priceDiscountRate?: number | null;
  commissionRate?: string | null;
  commission?: string | null;
  sales?: number | null;
  ratingStar?: string | null;
  imageUrl?: string | null;
  shopName?: string | null;
  productLink: string;
  offerLink?: string | null;
  periodEndTime?: number | null;
  productCatIds?: number[] | null;
};

export type ShopeeCredentials = { app_id: string; secret: string };

/** Assinatura exigida pela API: SHA256(appId + timestamp + payload + secret). */
export function shopeeSignature(appId: string, timestamp: number, payload: string, secret: string) {
  return createHash("sha256").update(`${appId}${timestamp}${payload}${secret}`).digest("hex");
}

const num = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function mapShopeeNode(n: ShopeeNode): ProductOffer {
  const price = num(n.price) ?? num(n.priceMin) ?? 0;
  const discount = num(n.priceDiscountRate);
  // A API não traz o preço "de"; derivamos do percentual de desconto.
  const original =
    discount && discount > 0 && discount < 100
      ? Math.round((price / (1 - discount / 100)) * 100) / 100
      : null;
  return {
    platform: "shopee",
    externalId: String(n.itemId),
    title: n.productName,
    url: n.productLink,
    affiliateUrl: n.offerLink ?? null,
    imageUrls: n.imageUrl ? [n.imageUrl] : [],
    price,
    originalPrice: original,
    discountPct: discount,
    commissionRate: num(n.commissionRate),
    commissionValue: num(n.commission),
    rating: num(n.ratingStar),
    soldCount: num(n.sales),
    shopName: n.shopName ?? null,
    categoryIds: (n.productCatIds ?? []).map(String),
    categoryName: null,
    available: true,
    validUntil: n.periodEndTime ? new Date(n.periodEndTime * 1000) : null,
  };
}

export class ShopeeConnector implements AffiliateConnector {
  readonly platform = "shopee" as const;
  readonly capabilities = {
    search: true,
    lookup: true,
    linkGeneration: true,
    subIds: 5,
    // Relatório de conversões entra na fase Financeiro (fetchConversions ainda não existe).
    conversionsReport: false,
  };

  constructor(
    private readonly creds: ShopeeCredentials,
    private readonly opts: { fetch?: typeof fetch; endpoint?: string; now?: () => number } = {},
  ) {
    if (!creds.app_id || !creds.secret) {
      throw new ConnectorError(
        "shopee",
        "AUTH",
        "Credenciais da Shopee incompletas (app_id e secret).",
      );
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ query, variables });
    const ts = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    const signature = shopeeSignature(this.creds.app_id, ts, payload, this.creds.secret);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(this.opts.endpoint ?? SHOPEE_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `SHA256 Credential=${this.creds.app_id}, Timestamp=${ts}, Signature=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ConnectorError("shopee", "UNAVAILABLE", `Shopee indisponível: ${String(err)}`);
    }
    if (res.status === 429)
      throw new ConnectorError("shopee", "RATE_LIMIT", "Limite de requisições da Shopee atingido.");
    if (res.status >= 500)
      throw new ConnectorError("shopee", "UNAVAILABLE", `Shopee respondeu ${res.status}.`);

    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string; extensions?: { code?: number | string } }[];
    } | null;
    const first = body?.errors?.[0];
    if (first) {
      const msg = first.message ?? "erro desconhecido";
      const code = /auth|signature|credential|permission|invalid app/i.test(msg)
        ? "AUTH"
        : /limit|frequen/i.test(msg)
          ? "RATE_LIMIT"
          : "INVALID";
      throw new ConnectorError("shopee", code, `Shopee: ${msg}`);
    }
    if (!res.ok || !body?.data) {
      throw new ConnectorError(
        "shopee",
        res.status === 401 || res.status === 403 ? "AUTH" : "INVALID",
        `Shopee respondeu ${res.status}.`,
      );
    }
    return body.data;
  }

  async ping() {
    await this.search({ keyword: "fone", limit: 1 });
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const data = await this.gql<{
      productOfferV2: { nodes: ShopeeNode[]; pageInfo: { hasNextPage: boolean } };
    }>(SEARCH_QUERY, {
      keyword: q.keyword,
      sortType: SORT_TYPE[q.sort ?? "relevance"],
      page: q.page ?? 1,
      limit: Math.min(q.limit ?? 20, 50),
      productCatId: q.categoryId ? Number(q.categoryId) : undefined,
    });
    return {
      items: data.productOfferV2.nodes.map(mapShopeeNode),
      hasMore: data.productOfferV2.pageInfo.hasNextPage,
    };
  }

  async lookup(externalId: string) {
    const data = await this.gql<{ productOfferV2: { nodes: ShopeeNode[] } }>(SEARCH_QUERY, {
      itemId: Number(externalId),
      limit: 1,
    });
    const node = data.productOfferV2.nodes[0];
    return node ? mapShopeeNode(node) : null;
  }

  async generateLink(productUrl: string, subIds: string[]) {
    const data = await this.gql<{ generateShortLink: { shortLink: string } }>(SHORT_LINK_MUTATION, {
      originUrl: productUrl,
      subIds: subIds.map(sanitizeSubId).filter(Boolean).slice(0, 5),
    });
    return data.generateShortLink.shortLink;
  }
}
