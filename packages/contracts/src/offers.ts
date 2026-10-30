import { z } from "zod";

export const PLATFORMS = ["shopee", "amazon", "mercadolivre", "magalu"] as const;
export const OFFER_STATUS = ["new", "approved", "rejected", "expired"] as const;
export const OFFER_SORTS = ["relevance", "sales", "price_asc", "price_desc", "commission"] as const;

export const QUALITY_FLAGS = [
  "fake_discount",
  "lowest_30d",
  "lowest_90d",
  "low_rating",
  "unavailable",
  "coupon_required",
] as const;

// ── Contas de afiliado ──────────────────────────────────────────

export const AffiliateAccount = z.object({
  id: z.string(),
  platform: z.enum(PLATFORMS),
  label: z.string(),
  mode: z.enum(["live", "fake"]),
  status: z.enum(["active", "error", "disabled"]),
  last_error: z.string().nullable(),
  capabilities: z.object({
    search: z.boolean(),
    lookup: z.boolean(),
    linkGeneration: z.boolean(),
    subIds: z.number(),
    conversionsReport: z.boolean(),
  }),
  created_at: z.string(),
});
export type AffiliateAccount = z.infer<typeof AffiliateAccount>;

export const ConnectAffiliateAccountInput = z.object({
  platform: z.enum(PLATFORMS),
  label: z.string().trim().min(1).max(80),
  mode: z
    .enum(["live", "fake"])
    .default("live")
    .describe("fake = catálogo simulado, para testar sem credenciais."),
  credentials: z
    .record(z.string(), z.string().max(500))
    .optional()
    .describe("Shopee: { app_id, secret }. Obrigatório no modo live."),
});
export type ConnectAffiliateAccountInput = z.input<typeof ConnectAffiliateAccountInput>;

// ── Busca ───────────────────────────────────────────────────────

export const SearchOffersInput = z.object({
  keyword: z.string().max(100).optional(),
  category_id: z.string().max(40).optional(),
  min_discount: z.coerce.number().int().min(0).max(95).optional().describe("Desconto mínimo em %."),
  price_min: z.coerce.number().min(0).optional(),
  price_max: z.coerce.number().min(0).optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  platforms: z.array(z.enum(PLATFORMS)).optional().describe("Padrão: todas as contas ativas."),
  sort: z.enum(OFFER_SORTS).default("relevance"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchOffersInput = z.input<typeof SearchOffersInput>;

const PriceSummary = z.object({
  min_30d: z.number().nullable(),
  median_30d: z.number().nullable(),
  min_90d: z.number().nullable(),
  points: z.number().describe("Quantas observações de preço existem"),
});

export const OfferCandidate = z.object({
  product_id: z.string(),
  offer_id: z.string().nullable().describe("Preenchido se o produto já está na curadoria."),
  offer_status: z.enum(OFFER_STATUS).nullable(),
  platform: z.enum(PLATFORMS),
  external_id: z.string(),
  title: z.string(),
  image_url: z.string().nullable(),
  url: z.string(),
  price: z.number(),
  original_price: z.number().nullable(),
  discount_pct: z.number().nullable(),
  commission_rate: z.number().nullable(),
  commission_value: z.number().nullable(),
  rating: z.number().nullable(),
  sold_count: z.number().nullable(),
  shop_name: z.string().nullable(),
  category: z.string().nullable(),
  score: z.number().describe("0 a 100: desconto real, comissão, avaliação, vendas e nicho."),
  flags: z.array(z.enum(QUALITY_FLAGS)),
  price_history: PriceSummary,
});
export type OfferCandidate = z.infer<typeof OfferCandidate>;

export const SearchOffersResult = z.object({
  items: z.array(OfferCandidate),
  errors: z
    .array(z.object({ platform: z.string(), message: z.string() }))
    .describe("Plataformas que falharam nesta busca."),
});
export type SearchOffersResult = z.infer<typeof SearchOffersResult>;

// ── Ofertas (curadoria) ─────────────────────────────────────────

export const Offer = z.object({
  id: z.string(),
  status: z.enum(OFFER_STATUS),
  product_id: z.string(),
  platform: z.enum(PLATFORMS),
  title: z.string(),
  image_url: z.string().nullable(),
  url: z.string(),
  affiliate_url: z.string().nullable(),
  price: z.number(),
  original_price: z.number().nullable(),
  discount_pct: z.number().nullable(),
  coupon_code: z.string().nullable(),
  coupon_description: z.string().nullable(),
  commission_rate: z.number().nullable(),
  commission_value: z.number().nullable(),
  rating: z.number().nullable(),
  sold_count: z.number().nullable(),
  category: z.string().nullable(),
  score: z.number(),
  flags: z.array(z.enum(QUALITY_FLAGS)),
  notes: z.string().nullable(),
  reject_reason: z.string().nullable(),
  valid_until: z.string().nullable(),
  last_validated_at: z.string().nullable(),
  created_at: z.string(),
});
export type Offer = z.infer<typeof Offer>;

export const OfferDetail = Offer.extend({
  price_history: PriceSummary.extend({
    series: z
      .array(z.object({ date: z.string(), min: z.number(), max: z.number() }))
      .describe("Menor e maior preço por dia (até 90 dias)."),
  }),
  validations: z.array(
    z.object({
      checked_at: z.string(),
      ok: z.boolean(),
      price_was: z.number(),
      price_now: z.number().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
export type OfferDetail = z.infer<typeof OfferDetail>;

export const SaveOfferInput = z.object({
  product_id: z.uuid().describe("product_id retornado por search_offers."),
  status: z
    .enum(["new", "approved"])
    .default("approved")
    .describe("approved = pronta para publicar; new = fica na fila de curadoria."),
  coupon_code: z.string().max(60).optional(),
  coupon_description: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
});
export type SaveOfferInput = z.input<typeof SaveOfferInput>;

export const UpdateOfferStatusInput = z.object({
  offer_id: z.uuid(),
  status: z.enum(["approved", "rejected"]),
  reason: z.string().max(300).optional().describe("Motivo da rejeição."),
});
export type UpdateOfferStatusInput = z.infer<typeof UpdateOfferStatusInput>;

export const ListOffersQuery = z.object({
  status: z.enum(OFFER_STATUS).optional(),
  platform: z.enum(PLATFORMS).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListOffersQuery = z.input<typeof ListOffersQuery>;

export const OfferPage = z.object({ items: z.array(Offer), next_cursor: z.string().nullable() });

export const ValidateOfferResult = z.object({
  offer_id: z.string(),
  ok: z.boolean(),
  status: z.enum(OFFER_STATUS),
  price_was: z.number(),
  price_now: z.number().nullable(),
  change_pct: z.number().nullable(),
  available: z.boolean().nullable(),
  reason: z.string().nullable(),
});
export type ValidateOfferResult = z.infer<typeof ValidateOfferResult>;

export const FindSimilarInput = z.object({
  offer_id: z.uuid().optional(),
  product_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type FindSimilarInput = z.input<typeof FindSimilarInput>;

export const CreateOfferLinkInput = z.object({
  offer_id: z.uuid(),
  source: z.string().max(40).describe("Onde será divulgado: wa, ig, story, bio, ads..."),
  channel_id: z.uuid().optional(),
  campaign: z.string().max(80).optional(),
});
export type CreateOfferLinkInput = z.infer<typeof CreateOfferLinkInput>;

export const OfferLink = z.object({
  offer_id: z.string(),
  affiliate_url: z.string(),
  link_id: z.string(),
  short_url: z.string(),
  sub_ids: z.array(z.string()),
});
export type OfferLink = z.infer<typeof OfferLink>;

// ── Buscas salvas (curadoria automática) ────────────────────────

export const SavedSearch = z.object({
  id: z.string(),
  name: z.string(),
  query: SearchOffersInput,
  interval_minutes: z.number(),
  min_score: z.number(),
  active: z.boolean(),
  last_run_at: z.string().nullable(),
  last_result: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
export type SavedSearch = z.infer<typeof SavedSearch>;

export const UpsertSavedSearchInput = z.object({
  id: z.uuid().optional().describe("Informe para editar; omita para criar."),
  name: z.string().trim().min(1).max(80).optional(),
  query: SearchOffersInput.optional(),
  interval_minutes: z.number().int().min(15).max(1440).optional().describe("Padrão: 60."),
  min_score: z.number().int().min(0).max(100).optional().describe("Padrão: 60."),
  active: z.boolean().optional(),
});
export type UpsertSavedSearchInput = z.input<typeof UpsertSavedSearchInput>;
