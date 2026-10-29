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
  created_at: z.string(),
});
export type Channel = z.infer<typeof Channel>;

export const UpsertChannelInput = z.object({
  id: z.uuid().optional().describe("Informe para editar um canal existente; omita para criar."),
  type: z.enum(CHANNEL_TYPES).optional().describe("Padrão: wa_group."),
  name: z.string().trim().min(1).max(120).optional().describe("Obrigatório ao criar."),
  invite_url: httpUrl
    .nullable()
    .optional()
    .describe("Link de convite do grupo (https://chat.whatsapp.com/...)."),
  member_count: z.number().int().min(0).optional(),
  member_limit: z.number().int().min(1).max(100_000).optional().describe("Padrão: 1024."),
  status: z.enum(CHANNEL_STATUS).optional(),
  segment_ids: z
    .array(z.uuid())
    .max(50)
    .optional()
    .describe("Substitui a lista de segmentos do canal."),
});
export type UpsertChannelInput = z.infer<typeof UpsertChannelInput>;

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
