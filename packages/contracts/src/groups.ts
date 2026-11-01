import { z } from "zod";
import { Channel, httpUrl } from "./channels";

// ── Gestão de grupos do WhatsApp ────────────────────────────────

const phone = z
  .string()
  .transform((v) => v.replace(/\D/g, ""))
  .pipe(z.string().min(12, "Telefone com DDI e DDD, ex.: 5511999998888.").max(15));

/** Nome de grupo: o WhatsApp recusa acima de 25 caracteres. */
const groupName = z.string().trim().min(1).max(25, "O WhatsApp aceita até 25 caracteres no nome.");

export const TeamContact = z.object({
  id: z.string(),
  phone: z.string(),
  label: z.string(),
  created_at: z.string(),
});
export type TeamContact = z.infer<typeof TeamContact>;

export const UpsertTeamContactInput = z.object({
  phone: phone.describe("Telefone com DDI, só dígitos."),
  label: z.string().trim().min(1).max(60).describe("Ex.: Dono, Número reserva, Moderador."),
});
export type UpsertTeamContactInput = z.infer<typeof UpsertTeamContactInput>;

export const GroupAdmin = z.object({
  /** Telefone mascarado, exceto equipe e o próprio número */
  phone: z.string(),
  is_self: z.boolean(),
  team_label: z.string().nullable(),
});

export const GroupDetails = z.object({
  channel: Channel,
  admins: z.array(GroupAdmin),
  team_in_group: z
    .array(z.object({ phone: z.string(), label: z.string(), is_admin: z.boolean() }))
    .describe("Números da equipe que estão no grupo."),
  community: z.object({ id: z.string().nullable(), name: z.string().nullable() }).nullable(),
  linked_groups: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .describe("Para comunidades: grupos ligados."),
});
export type GroupDetails = z.infer<typeof GroupDetails>;

export const CreateGroupInput = z.object({
  account_id: z.uuid(),
  name: groupName,
  participants: z
    .array(phone)
    .min(1, "O WhatsApp exige ao menos 1 participante além do número.")
    .max(5)
    .describe("Telefones da equipe (cadastrados em números da equipe)."),
  description: z.string().max(2048).optional(),
  photo_url: httpUrl
    .optional()
    .describe(
      "URL pública de imagem (JPEG, PNG, GIF ou WebP); a plataforma converte para JPEG quadrado.",
    ),
  segment_ids: z.array(z.uuid()).max(50).optional(),
  admin_only: z.boolean().default(true).describe("Só admins enviam. Padrão: sim."),
  locked: z.boolean().default(true).describe("Só admins editam dados. Padrão: sim."),
  member_limit: z.number().int().min(1).max(100_000).optional(),
});
export type CreateGroupInput = z.input<typeof CreateGroupInput>;

export const CreateGroupResult = z.object({
  channel: Channel,
  /** Passos que falharam depois de criar o grupo (o grupo fica criado) */
  pending: z.array(z.object({ step: z.string(), error: z.string() })),
  failed_participants: z.array(z.string()),
});
export type CreateGroupResult = z.infer<typeof CreateGroupResult>;

export const UpdateGroupInput = z.object({
  name: groupName.optional(),
  description: z.string().max(2048).optional().describe("Vazio limpa a descrição."),
  photo_url: httpUrl
    .optional()
    .describe(
      "URL pública de imagem (JPEG, PNG, GIF ou WebP); a plataforma converte para JPEG quadrado.",
    ),
});
export type UpdateGroupInput = z.infer<typeof UpdateGroupInput>;

export const UpdateGroupSettingsInput = z.object({
  admin_only: z.boolean().optional().describe("Só admins enviam mensagens."),
  locked: z.boolean().optional().describe("Só admins editam nome, descrição e foto."),
  approval_required: z.boolean().optional().describe("Entrada precisa de aprovação."),
  admins_add_members: z.boolean().optional().describe("Só admins adicionam membros."),
});
export type UpdateGroupSettingsInput = z.infer<typeof UpdateGroupSettingsInput>;

export const PARTICIPANT_ACTIONS = ["add", "remove", "promote", "demote"] as const;

export const ManageParticipantsInput = z.object({
  action: z.enum(PARTICIPANT_ACTIONS),
  phones: z.array(phone).min(1).max(5),
});
export type ManageParticipantsInput = z.infer<typeof ManageParticipantsInput>;

export const ManageParticipantsResult = z.object({
  action: z.enum(PARTICIPANT_ACTIONS),
  /** Confirmados relendo o grupo */
  done: z.array(z.string()),
  failed: z.array(z.string()),
});
export type ManageParticipantsResult = z.infer<typeof ManageParticipantsResult>;

export const JoinGroupInput = z.object({
  invite_url: z
    .string()
    .trim()
    .regex(/^(https:\/\/chat\.whatsapp\.com\/)?[A-Za-z0-9]{10,}$/, "Link de convite inválido.")
    .describe("Link https://chat.whatsapp.com/... ou só o código."),
  segment_ids: z.array(z.uuid()).max(50).optional(),
});
export type JoinGroupInput = z.infer<typeof JoinGroupInput>;

export const JoinGroupResult = z.object({
  /** joined: entrou e importou; pending: entrada aguarda aprovação de um admin (ou já estava) */
  status: z.enum(["joined", "pending"]),
  channels: z.array(Channel),
});
export type JoinGroupResult = z.infer<typeof JoinGroupResult>;

export const CreateCommunityInput = z.object({
  account_id: z.uuid(),
  name: groupName,
  description: z.string().max(2048).optional(),
  segment_ids: z.array(z.uuid()).max(50).optional(),
});
export type CreateCommunityInput = z.infer<typeof CreateCommunityInput>;

export const LinkCommunityGroupsInput = z.object({
  channel_ids: z.array(z.uuid()).min(1).max(50),
  link: z.boolean().describe("true liga os grupos à comunidade; false desliga."),
});
export type LinkCommunityGroupsInput = z.infer<typeof LinkCommunityGroupsInput>;

export const LinkCommunityGroupsResult = z.object({
  done: z.array(z.string()),
  failed: z.array(z.string()),
});
