import { z } from "zod";

export const CHANNEL_TYPES = [
  "wa_group",
  "wa_community",
  "wa_channel",
  "ig_account",
  "telegram",
] as const;
export const CHANNEL_STATUS = ["active", "paused", "archived"] as const;

export const httpUrl = z.url({ protocol: /^https?$/, error: "Informe uma URL http(s) válida." });

export const Channel = z.object({
  id: z.string(),
  type: z.enum(CHANNEL_TYPES),
  name: z.string(),
  invite_url: z.string().nullable(),
  member_count: z.number(),
  member_limit: z.number(),
  status: z.enum(CHANNEL_STATUS),
  segment_ids: z.array(z.string()),
  external_id: z.string().nullable().describe("JID do grupo no WhatsApp"),
  messaging_account_id: z.string().nullable(),
  admin_only: z.boolean().nullable(),
  number_is_admin: z
    .boolean()
    .nullable()
    .describe("O número ligado é admin do grupo. Sem isso não publica em grupo 'só admins'."),
  description: z.string().nullable(),
  locked: z.boolean().nullable().describe("Só admins editam nome, descrição e foto."),
  approval_required: z.boolean().nullable().describe("Entrada precisa de aprovação."),
  admins_add_members: z.boolean().nullable().describe("Só admins adicionam membros."),
  provider_state: z
    .enum(["ok", "deleted", "suspended"])
    .describe("Estado no WhatsApp: apagado ou suspenso pausa o canal."),
  community_jid: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  created_at: z.string(),
});
export type Channel = z.infer<typeof Channel>;

/** Edição de um grupo já na plataforma (grupos entram pela importação ou criação no WhatsApp). */
export const UpdateChannelInput = z.object({
  status: z
    .enum(CHANNEL_STATUS)
    .optional()
    .describe("'paused' para de publicar; 'archived' remove da plataforma; 'active' volta."),
  member_limit: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe("Limite usado pelos links de convite para saber se o grupo lotou. Padrão: 1024."),
  segment_ids: z
    .array(z.uuid())
    .max(50)
    .optional()
    .describe("Substitui a lista de segmentos do canal."),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

export const ListChannelsQuery = z.object({
  include_archived: z
    .preprocess((v) => v === true || v === "true", z.boolean())
    .optional()
    .describe("Inclui canais arquivados (removidos). Padrão: false."),
});
export type ListChannelsQuery = z.infer<typeof ListChannelsQuery>;

export const Segment = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  channel_count: z.number(),
  created_at: z.string(),
});
export type Segment = z.infer<typeof Segment>;

export const UpsertSegmentInput = z.object({
  id: z.uuid().optional().describe("Informe para editar; omita para criar."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("Obrigatório ao criar. Ex.: casa, tech."),
  description: z.string().max(500).nullable().optional(),
});
export type UpsertSegmentInput = z.infer<typeof UpsertSegmentInput>;
