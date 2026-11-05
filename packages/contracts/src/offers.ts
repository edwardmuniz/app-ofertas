import { z } from "zod";

export const PLATFORMS = ["shopee", "amazon", "mercadolivre", "magalu"] as const;
export const OFFER_STATUS = ["new", "approved", "rejected", "expired"] as const;
export const OFFER_SORTS = [
  "relevance",
  "sales",
  "price_asc",
  "price_desc",
  "commission",
  "discount",
] as const;

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
  mode: z.enum(["live", "fake", "feed"]),
  status: z.enum(["active", "error", "disabled"]),
  last_error: z.string().nullable(),
  capabilities: z.object({
    search: z.boolean(),
    lookup: z.boolean(),
    linkGeneration: z.boolean(),
    subIds: z.number(),
    conversionsReport: z.boolean(),
  }),
  feed: z
    .object({
      synced_at: z.string().nullable().describe("Última importação concluída."),
      items: z.number().describe("Produtos com desconto no catálogo."),
      read: z.number().describe("Linhas lidas na última importação."),
      running: z.boolean(),
      progress: z
        .object({
          file: z.number().describe("Arquivo atual (1 = primeiro)."),
          files: z.number(),
          bytes: z.number().describe("Bytes lidos do arquivo atual."),
          total: z.number().nullable().describe("Tamanho do arquivo atual, se conhecido."),
        })
        .nullable()
        .describe("Andamento da importação em curso."),
      error: z.string().nullable(),
    })
    .nullable()
    .describe("Só no modo feed."),
  created_at: z.string(),
});
export type AffiliateAccount = z.infer<typeof AffiliateAccount>;

export const ConnectAffiliateAccountInput = z.object({
  platform: z.enum(PLATFORMS),
  label: z.string().trim().min(1).max(80),
  mode: z
    .enum(["live", "fake", "feed"])
    .default("live")
    .describe(
      "fake = catálogo simulado; feed = feed de produtos (CSV) da loja, importado todo dia.",
    ),
  credentials: z
    .record(z.string(), z.string().max(4000))
    .optional()
    .describe(
      "Shopee live: { app_id, secret }. Shopee feed: { affiliate_id, feed_urls (um link por linha) }. Amazon live: { partner_tag, credential_id?, credential_secret? } (Creators API opcional; sem ela a busca lê a página de resultados).",
    ),
});
export type ConnectAffiliateAccountInput = z.input<typeof ConnectAffiliateAccountInput>;

export const UpdateAffiliateAccountInput = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  credentials: z
    .record(z.string(), z.string().max(4000))
    .optional()
    .describe("Só os campos que mudam; em branco mantém o atual. As novas são testadas."),
});
export type UpdateAffiliateAccountInput = z.infer<typeof UpdateAffiliateAccountInput>;

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
  page: z.coerce.number().int().min(1).max(50).default(1).describe("Página (1 = primeira)."),
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
  has_more: z.boolean().describe("Há mais resultados: peça page + 1."),
});
export type SearchOffersResult = z.infer<typeof SearchOffersResult>;

// ── Ofertas (curadoria) ─────────────────────────────────────────

export const OfferCopy = z.object({
  headline: z.string().describe("Chamada (vai em negrito no topo da mensagem)."),
  body: z.string().describe("1 ou 2 frases sobre o produto."),
  extra: z.string().nullable().describe("Fechamento: urgência, condição ou dica."),
  source: z.enum(["ai", "agent", "human"]),
  updated_at: z.string(),
});
export type OfferCopy = z.infer<typeof OfferCopy>;

export const SetOfferCopyInput = z.object({
  copy: z
    .object({
      headline: z.string().trim().min(3).max(90),
      body: z.string().trim().min(3).max(320),
      extra: z.string().trim().max(200).nullable().optional(),
    })
    .nullable()
    .describe(
      "Texto da mensagem desta oferta. null volta ao modelo padrão. Não escreva preço, parcelas, cupom nem link: o sistema coloca, sempre atualizados.",
    ),
});
export type SetOfferCopyInput = z.infer<typeof SetOfferCopyInput>;

export const GenerateOfferCopyInput = z.object({
  hint: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Pedido extra para a IA, ex.: 'foque em quem joga'."),
});
export type GenerateOfferCopyInput = z.infer<typeof GenerateOfferCopyInput>;

export const Offer = z.object({
  id: z.string(),
  status: z.enum(OFFER_STATUS),
  origin: z
    .enum(["platform", "link"])
    .describe("platform = veio da API da loja; link = criada a partir de um link colado."),
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
  coupon_valid_until: z.string().nullable().describe("Até quando o cupom vale."),
  coupon_source: z
    .enum(["manual", "store"])
    .nullable()
    .describe(
      "manual = definido à mão ou pelo agente; store = lido da página da loja e atualizado a cada conferência.",
    ),
  coupon_active: z
    .boolean()
    .describe("Tem cupom e ele está na validade: sai na mensagem e no card."),
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
  pix_price: z.number().nullable().describe("Preço no Pix, quando a loja mostra (Amazon)."),
  installments: z
    .object({ count: z.number(), value: z.number(), interest_free: z.boolean() })
    .nullable()
    .describe("Parcelamento anunciado pela loja."),
  copy: OfferCopy.nullable().describe(
    "Texto próprio da mensagem. Com ele, o envio usa o formato chamada + descrição + preço + fechamento.",
  ),
  sent: z
    .object({
      posts: z.number().describe("Mensagens enviadas com esta oferta."),
      channels: z.number().describe("Em quantos grupos ou canais."),
      last_at: z.string().nullable().describe("Último envio."),
    })
    .optional()
    .describe("Envios da oferta (vem em list_offers)."),
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
  coupon_valid_until: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Até quando o cupom vale (ISO 8601). Depois disso ele some da mensagem."),
  notes: z.string().max(1000).optional(),
});
export type SaveOfferInput = z.input<typeof SaveOfferInput>;

export const UpdateOfferPricesInput = z.object({
  price: z.number().positive().max(1_000_000).optional().describe("Preço atual (R$)."),
  original_price: z
    .number()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe('Preço "De" (R$). null = a loja não mostra preço riscado (remove desconto falso).'),
  pix_price: z.number().positive().max(1_000_000).nullable().optional(),
  installments: z
    .object({
      count: z.number().int().min(2).max(48),
      value: z.number().positive().max(1_000_000),
      interest_free: z.boolean().default(true),
    })
    .nullable()
    .optional(),
});
export type UpdateOfferPricesInput = z.input<typeof UpdateOfferPricesInput>;

export const SetOfferCouponInput = z.object({
  coupon_code: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .nullable()
    .describe("Código do cupom, ex.: BLACK20. null = tirar o cupom da oferta."),
  coupon_description: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe("Regra curta, ex.: R$ 20 OFF acima de R$ 99. Sai abaixo do código na mensagem."),
  coupon_valid_until: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe("Até quando vale (ISO 8601). Vencido, some da mensagem sozinho. null = sem prazo."),
});
export type SetOfferCouponInput = z.input<typeof SetOfferCouponInput>;

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
  sent: z
    .enum(["yes", "no"])
    .optional()
    .describe("yes = já enviada em algum grupo ou canal; no = ainda não enviada."),
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

// ── Oferta por link ─────────────────────────────────────────────

export const OfferFromLinkInput = z.object({
  url: z
    .url()
    .max(2000)
    .describe("Link do produto, de preferência o link de afiliado (ex.: s.shopee.com.br/…)."),
});
export type OfferFromLinkInput = z.infer<typeof OfferFromLinkInput>;

export const OfferLinkPreview = z.object({
  platform: z.enum(PLATFORMS),
  external_id: z.string().describe("Id do produto na loja (ou derivado do link)."),
  product_url: z.string(),
  affiliate_url: z.string().describe("Destino dos links curtos: o próprio link colado."),
  is_affiliate_link: z
    .boolean()
    .describe(
      "false = parece link comum da loja (sem comissão). Gere o link de afiliado no portal.",
    ),
  source: z
    .enum(["platform", "page"])
    .describe("platform = dados da API da loja (conta real); page = lidos da página."),
  title: z.string().nullable(),
  image_url: z.string().nullable(),
  price: z.number().nullable(),
  original_price: z.number().nullable(),
  pix_price: z.number().nullable().describe("Preço no Pix, quando a página mostra (Amazon)."),
  installments: z
    .object({ count: z.number(), value: z.number(), interest_free: z.boolean() })
    .nullable(),
  shop_name: z.string().nullable(),
  missing: z
    .array(z.enum(["title", "image", "price"]))
    .describe("O que não foi encontrado e precisa ser informado."),
  existing_offer_id: z.string().nullable().describe("Oferta aberta do mesmo produto, se houver."),
});
export type OfferLinkPreview = z.infer<typeof OfferLinkPreview>;

export const ImportOfferFromLinkInput = z.object({
  url: z.url().max(2000).describe("O link colado (de preferência o de afiliado)."),
  product_url: z
    .url()
    .max(2000)
    .optional()
    .describe(
      "Página do produto na loja, quando o link de afiliado não mostra qual é o produto (ex.: meli.la). Evita oferta duplicada.",
    ),
  title: z.string().trim().min(3).max(300),
  image_url: z.url().max(2000).nullable().optional().describe("Foto do produto."),
  price: z.number().positive().max(1_000_000).describe("Preço atual (R$)."),
  original_price: z
    .number()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe('Preço "de" (R$), se houver.'),
  pix_price: z
    .number()
    .positive()
    .max(1_000_000)
    .nullable()
    .optional()
    .describe("Preço no Pix (R$), se a loja mostrar um menor que o preço normal."),
  installments: z
    .object({
      count: z.number().int().min(2).max(48),
      value: z.number().positive().max(1_000_000),
      interest_free: z.boolean().default(true),
    })
    .nullable()
    .optional()
    .describe("Parcelamento anunciado, ex.: 10x de R$ 52,19 sem juros."),
  coupon_code: z.string().max(60).optional(),
  coupon_description: z.string().max(200).optional(),
  coupon_valid_until: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Até quando o cupom vale (ISO 8601). Depois disso ele some da mensagem."),
  notes: z.string().max(1000).optional(),
  status: z
    .enum(["new", "approved"])
    .default("approved")
    .describe("approved = pronta para publicar; new = fica na curadoria."),
});
export type ImportOfferFromLinkInput = z.input<typeof ImportOfferFromLinkInput>;

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
  share_url: z
    .string()
    .describe(
      "Link para publicar. Igual ao short_url, exceto na Amazon (proíbe encurtador): link de afiliado direto.",
    ),
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

export const OfferCategory = z.object({
  id: z.string().describe("Use em search_offers.category_id."),
  name: z.string(),
  platform: z.enum(PLATFORMS),
  count: z.number().nullable().describe("Produtos no catálogo (feed); null se desconhecido."),
});
export type OfferCategory = z.infer<typeof OfferCategory>;
