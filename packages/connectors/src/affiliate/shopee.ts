import { createHash } from "node:crypto";
import { SHOPEE_CATEGORY_PT, SHOPEE_TOP_CATEGORIES } from "./shopee-feed";
import {
  type AffiliateConnector,
  ConnectorError,
  type ProductOffer,
  type SearchQuery,
  type SearchResult,
  type SearchSort,
  sanitizeSubId,
} from "./types";

/** Nome em português da categoria principal do produto (o primeiro código da lista). */
function categoryNameOf(ids: number[] | null | undefined): string | null {
  const top = ids?.map(String).find((id) => SHOPEE_TOP_CATEGORIES[id]);
  if (!top) return null;
  const en = SHOPEE_TOP_CATEGORIES[top] ?? "";
  return SHOPEE_CATEGORY_PT[en] ?? en;
}

// Shopee Affiliate Open API (GraphQL). Endpoint, limite (8.000 chamadas/hora), campos e códigos
// de sortType conferidos na documentação oficial; busca testada com credenciais reais em 11/2026.
export const SHOPEE_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql";

/** sortType do productOfferV2. RELEVANCE_DESC (1) só vale com palavra-chave. */
const SORT_TYPE: Record<SearchSort, number> = {
  relevance: 1,
  sales: 2,
  price_desc: 3,
  price_asc: 4,
  commission: 5,
  // Sem ordenação por desconto na API: usa relevância e ordena depois.
  discount: 1,
};
/** Sem palavra-chave (só categoria), "relevância" vira "mais vendidos". */
const ITEM_SOLD_DESC = 2;

const OFFER_FIELDS = `itemId productName price priceMin priceMax priceDiscountRate
  commissionRate commission sales ratingStar imageUrl shopName productLink offerLink
  periodEndTime productCatIds`;

/** Tipos dos argumentos do productOfferV2. */
const SEARCH_ARGS = {
  keyword: "String",
  sortType: "Int",
  page: "Int",
  limit: "Int",
  productCatId: "Int",
  itemId: "Int64",
} as const;
type SearchVars = Partial<Record<keyof typeof SEARCH_ARGS, string | number>>;

/**
 * Monta a consulta só com os argumentos preenchidos. A Shopee responde
 * "graphql: got null for non-null" quando uma variável declarada vai vazia (visto em 11/2026).
 */
export function shopeeSearchQuery(vars: SearchVars): [string, Record<string, unknown>] {
  const keys = (Object.keys(SEARCH_ARGS) as (keyof typeof SEARCH_ARGS)[]).filter(
    (k) => vars[k] !== undefined && vars[k] !== "",
  );
  const decl = keys.map((k) => `$${k}: ${SEARCH_ARGS[k]}`).join(", ");
  const args = keys.map((k) => `${k}: $${k}`).join(", ");
  const query = `query Search(${decl}) {
  productOfferV2(${args}) {
    nodes { ${OFFER_FIELDS} }
    pageInfo { page limit hasNextPage }
  }
}`;
  return [query, Object.fromEntries(keys.map((k) => [k, vars[k]]))];
}

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
    categoryName: categoryNameOf(n.productCatIds),
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
        : // 10030: limite de requisições da Open API.
          String(first.extensions?.code) === "10030" || /limit|frequen/i.test(msg)
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
    const sort = SORT_TYPE[q.sort ?? "relevance"];
    const data = await this.gql<{
      productOfferV2: { nodes: ShopeeNode[]; pageInfo: { hasNextPage: boolean } };
    }>(
      ...shopeeSearchQuery({
        keyword: q.keyword?.trim(),
        sortType: sort === 1 && !q.keyword?.trim() ? ITEM_SOLD_DESC : sort,
        page: q.page ?? 1,
        limit: Math.min(q.limit ?? 20, 50),
        productCatId: q.categoryId ? Number(q.categoryId) : undefined,
      }),
    );
    return {
      items: data.productOfferV2.nodes.map(mapShopeeNode),
      hasMore: data.productOfferV2.pageInfo.hasNextPage,
    };
  }

  async lookup(externalId: string) {
    const data = await this.gql<{ productOfferV2: { nodes: ShopeeNode[] } }>(
      // Int64 vai como texto: como número a API responde "wrong type".
      ...shopeeSearchQuery({ itemId: String(externalId), limit: 1 }),
    );
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
