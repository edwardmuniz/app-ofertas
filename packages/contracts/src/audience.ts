import { z } from "zod";

// Audiência orgânica (spec 18): vitrine pública do workspace e medição por origem.

/** Origens sugeridas para os links da vitrine (o parâmetro ?src aceita qualquer texto curto). */
export const AUDIENCE_SOURCES = [
  { source: "tiktok", label: "TikTok" },
  { source: "instagram", label: "Instagram" },
  { source: "youtube", label: "YouTube Shorts" },
  { source: "pinterest", label: "Pinterest" },
  { source: "whatsapp", label: "Status do WhatsApp" },
] as const;

export const STOREFRONT_SLUG = /^[a-z0-9][a-z0-9_-]{2,29}$/;

const hex = z
  .string()
  // Sem transform: o schema também serializa respostas (encode). Maiúsculas no core.
  .regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor hexadecimal, ex.: #EA580C.");
const httpUrl = z
  .url()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), "Use um endereço http(s).");

export const StorefrontDesign = z.object({
  accent_color: hex.default("#25D366").describe("Cor dos botões de grupo e destaques."),
  background_color: hex.default("#F5F5F4"),
  text_color: hex.default("#1C1917"),
  cover_url: httpUrl.nullable().default(null).describe("Imagem de capa (banner) no topo."),
  join_label: z.string().trim().min(2).max(40).default("Entrar no grupo"),
  links: z
    .array(z.object({ label: z.string().trim().min(1).max(40), url: httpUrl }))
    .max(6)
    .default([])
    .describe("Botões extras: Instagram, TikTok, outro grupo..."),
  featured_offer_ids: z
    .array(z.uuid())
    .max(6)
    .default([])
    .describe("Ofertas fixadas no topo (seção Destaques), enquanto aprovadas."),
  offers_mode: z
    .enum(["auto", "featured_only"])
    .default("auto")
    .describe(
      "auto = destaques + melhores aprovadas dos últimos 7 dias; featured_only = só destaques.",
    ),
  offers_title: z.string().trim().min(2).max(60).default("Ofertas de hoje"),
  group_by_category: z.boolean().default(false).describe("Separar as ofertas por categoria."),
  max_offers: z.number().int().min(4).max(48).default(24),
  footer_note: z
    .string()
    .trim()
    .max(300)
    .default(
      "Preços e estoque podem mudar a qualquer momento. Como afiliados, podemos receber comissão pelas compras feitas pelos links.",
    ),
});
export type StorefrontDesign = z.infer<typeof StorefrontDesign>;

export const Storefront = z.object({
  slug: z.string(),
  url: z.string().describe("Endereço público da vitrine."),
  title: z.string(),
  tagline: z.string().nullable(),
  avatar_url: z.string().nullable(),
  invite_link_ids: z.array(z.string()).describe("Convites rotativos exibidos como botões."),
  design: StorefrontDesign,
  active: z.boolean(),
  source_links: z
    .array(z.object({ source: z.string(), label: z.string(), url: z.string() }))
    .describe("Link da vitrine para cada rede (para a bio), já com ?src."),
});
export type Storefront = z.infer<typeof Storefront>;

export const UpdateStorefrontInput = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(STOREFRONT_SLUG, "Use de 3 a 30 letras minúsculas, números, - ou _.")
    .optional()
    .describe("Endereço: /@slug. Obrigatório na primeira vez."),
  title: z.string().trim().min(2).max(60).optional().describe("Nome da marca."),
  tagline: z.string().trim().max(160).nullable().optional().describe("Frase abaixo do nome."),
  avatar_url: z.url().max(2000).nullable().optional().describe("Foto ou logo."),
  invite_link_ids: z.array(z.uuid()).max(6).optional(),
  design: StorefrontDesign.partial()
    .optional()
    .describe("Personalização (só os campos enviados mudam)."),
  active: z.boolean().optional(),
});
export type UpdateStorefrontInput = z.infer<typeof UpdateStorefrontInput>;

const SourceRow = z.object({
  source: z.string().describe('Valor de ?src ("direto" sem origem).'),
  views: z.number().describe("Visitas na vitrine."),
  invite_clicks: z.number().describe("Cliques em Entrar no grupo (vitrine ou convite direto)."),
  offer_clicks: z.number().describe("Cliques em ofertas da vitrine."),
  view_to_invite: z.number().nullable().describe("Cliques no grupo ÷ visitas."),
});

export const AudienceStats = z.object({
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  sources: z.array(SourceRow),
  totals: z.object({
    views: z.number(),
    invite_clicks: z.number(),
    offer_clicks: z.number(),
    joins: z.number().describe("Entradas nos grupos (avisos do WhatsApp)."),
    leaves: z.number(),
    net: z.number(),
    invite_to_join: z
      .number()
      .nullable()
      .describe("Entradas ÷ cliques no grupo (geral: o WhatsApp não diz o link usado)."),
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      views: z.number(),
      invite_clicks: z.number(),
      joins: z.number(),
      leaves: z.number(),
    }),
  ),
});
export type AudienceStats = z.infer<typeof AudienceStats>;
