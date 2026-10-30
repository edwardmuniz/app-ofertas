export const PLATFORMS = ["shopee", "amazon", "mercadolivre", "magalu"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Produto + condição comercial no momento da consulta, normalizado entre plataformas. */
export type ProductOffer = {
  platform: Platform;
  externalId: string;
  title: string;
  /** Página do produto (sem afiliação) */
  url: string;
  /** Link de afiliado pronto, quando a plataforma já devolve um */
  affiliateUrl: string | null;
  imageUrls: string[];
  price: number;
  /** Preço "de" informado pela plataforma (pode ser inflado; ver flags de qualidade) */
  originalPrice: number | null;
  discountPct: number | null;
  /** Fração: 0.07 = 7% */
  commissionRate: number | null;
  commissionValue: number | null;
  rating: number | null;
  soldCount: number | null;
  shopName: string | null;
  categoryIds: string[];
  categoryName: string | null;
  available: boolean;
  validUntil: Date | null;
};

export const SEARCH_SORTS = [
  "relevance",
  "sales",
  "price_asc",
  "price_desc",
  "commission",
] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export type SearchQuery = {
  keyword?: string;
  categoryId?: string;
  sort?: SearchSort;
  page?: number;
  limit?: number;
};

export type SearchResult = { items: ProductOffer[]; hasMore: boolean };

export type ConnectorCapabilities = {
  search: boolean;
  lookup: boolean;
  linkGeneration: boolean;
  /** Quantos sub-ids o link de afiliado aceita (0 = nenhum) */
  subIds: number;
  conversionsReport: boolean;
};

export interface AffiliateConnector {
  readonly platform: Platform;
  readonly capabilities: ConnectorCapabilities;
  /** Testa as credenciais. Lança ConnectorError se falhar. */
  ping(): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult>;
  lookup(externalId: string): Promise<ProductOffer | null>;
  generateLink(productUrl: string, subIds: string[]): Promise<string>;
}

export type ConnectorErrorCode = "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "INVALID" | "UNSUPPORTED";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly platform: Platform;

  constructor(platform: Platform, code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.platform = platform;
    this.code = code;
  }
}

export const isConnectorError = (e: unknown): e is ConnectorError => e instanceof ConnectorError;

/** Sub-ids aceitos pelas plataformas: só letras e números, curtos. */
export const sanitizeSubId = (v: string) => v.replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
