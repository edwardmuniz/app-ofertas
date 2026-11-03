import { z } from "zod";
import { httpUrl } from "./channels";
import { CUSTOM_SLUG } from "./links";

export const INVITE_STRATEGIES = ["fill_first", "round_robin"] as const;

export const InviteLink = z.object({
  id: z.string(),
  slug: z.string(),
  url: z.string().describe("Link público para divulgar (bio, anúncio, story)."),
  name: z.string(),
  segment_id: z.string(),
  segment_name: z.string(),
  strategy: z.enum(INVITE_STRATEGIES),
  reserve: z.number(),
  fallback_url: z.string().nullable(),
  active: z.boolean(),
  capacity: z.object({
    channels: z.number().describe("Grupos ativos com link de convite no segmento"),
    available_slots: z.number().describe("Vagas livres somadas (já descontada a reserva)"),
    current_channel: z
      .object({ id: z.string(), name: z.string() })
      .nullable()
      .describe("Grupo que recebe o próximo membro (estratégia fill_first)"),
  }),
  created_at: z.string(),
});
export type InviteLink = z.infer<typeof InviteLink>;

export const CreateInviteLinkInput = z.object({
  segment_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .regex(CUSTOM_SLUG, "Use 3 a 40 caracteres: letras, números, _ ou -.")
    .optional()
    .describe("Opcional. Ex.: tech → /entrar/tech"),
  strategy: z
    .enum(INVITE_STRATEGIES)
    .default("fill_first")
    .describe("fill_first: enche um grupo por vez. round_robin: alterna entre grupos com vaga."),
  reserve: z
    .number()
    .int()
    .min(0)
    .max(500)
    .default(10)
    .describe("Vagas mantidas livres em cada grupo."),
  fallback_url: httpUrl.optional().describe("Para onde mandar quando todos os grupos lotarem."),
});
export type CreateInviteLinkInput = z.input<typeof CreateInviteLinkInput>;

export const UpdateInviteLinkInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  segment_id: z.uuid().optional().describe("Troca os grupos que recebem as pessoas."),
  strategy: z.enum(INVITE_STRATEGIES).optional(),
  reserve: z.number().int().min(0).max(500).optional(),
  fallback_url: httpUrl.nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateInviteLinkInput = z.infer<typeof UpdateInviteLinkInput>;
