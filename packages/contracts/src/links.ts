import { z } from "zod";
import { httpUrl } from "./channels";

/** Slug personalizado: letras, números, _ e -, de 3 a 40 caracteres. */
export const CUSTOM_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}$/;
const slug = z
  .string()
  .regex(CUSTOM_SLUG, "Use 3 a 40 caracteres: letras, números, _ ou -.")
  .describe("Opcional. Sem slug, um código curto é gerado.");

const isoDate = z.iso.datetime({ offset: true });

export const TrackedLink = z.object({
  id: z.string(),
  slug: z.string(),
  short_url: z.string(),
  destination_url: z.string(),
  fallback_url: z.string().nullable(),
  active: z.boolean(),
  expires_at: z.string().nullable(),
  title: z.string().nullable(),
  source: z.string().nullable(),
  campaign: z.string().nullable(),
  channel_id: z.string().nullable(),
  sub_ids: z.record(z.string(), z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TrackedLink = z.infer<typeof TrackedLink>;

export const CreateTrackedLinkInput = z.object({
  destination_url: httpUrl.describe("Para onde o link leva (ex.: link de afiliado)."),
  slug: slug.optional(),
  title: z.string().max(200).optional(),
  source: z.string().max(40).optional().describe("Origem do tráfego: wa, ig, ads, bio, story..."),
  campaign: z.string().max(80).optional(),
  channel_id: z.uuid().optional().describe("Canal onde o link será publicado."),
  fallback_url: httpUrl.optional().describe("Destino quando o link estiver inativo ou expirado."),
  expires_at: isoDate.optional(),
  sub_ids: z.record(z.string().max(20), z.string().max(80)).optional(),
});
export type CreateTrackedLinkInput = z.infer<typeof CreateTrackedLinkInput>;

export const UpdateTrackedLinkInput = z.object({
  id: z.uuid(),
  destination_url: httpUrl
    .optional()
    .describe("Novo destino. O link curto continua o mesmo (ex.: trocar oferta expirada)."),
  fallback_url: httpUrl.nullable().optional(),
  active: z.boolean().optional().describe("false desativa o link (vai para o fallback)."),
  expires_at: isoDate.nullable().optional(),
  title: z.string().max(200).nullable().optional(),
});
export type UpdateTrackedLinkInput = z.infer<typeof UpdateTrackedLinkInput>;

export const ListTrackedLinksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  q: z.string().max(100).optional().describe("Busca no título ou slug."),
  channel_id: z.uuid().optional(),
  campaign: z.string().max(80).optional(),
  source: z.string().max(40).optional(),
  active: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .optional(),
});
export type ListTrackedLinksQuery = z.infer<typeof ListTrackedLinksQuery>;

export const TrackedLinkPage = z.object({
  items: z.array(TrackedLink),
  next_cursor: z.string().nullable(),
});

export const STATS_GROUP_BY = ["none", "day", "link", "invite", "channel", "source"] as const;

export const LinkStatsQuery = z.object({
  link_id: z.uuid().optional(),
  invite_link_id: z.uuid().optional(),
  channel_id: z.uuid().optional(),
  campaign: z.string().max(80).optional(),
  source: z.string().max(40).optional(),
  from: isoDate.optional().describe("Início do período (padrão: 7 dias atrás)."),
  to: isoDate.optional().describe("Fim do período (padrão: agora)."),
  group_by: z.enum(STATS_GROUP_BY).default("day"),
});
export type LinkStatsQuery = z.infer<typeof LinkStatsQuery>;

const Counts = z.object({
  human: z.number().describe("Cliques de pessoas"),
  unique: z.number().describe("Pessoas distintas (por IP anonimizado)"),
  bot: z.number().describe("Acessos de robôs/prévias (não contam como clique)"),
});

export const LinkStats = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  totals: Counts,
  rows: z.array(Counts.extend({ key: z.string().nullable(), label: z.string().nullable() })),
});
export type LinkStats = z.infer<typeof LinkStats>;
