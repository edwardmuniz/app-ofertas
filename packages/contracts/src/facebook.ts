import { z } from "zod";

const fbId = z
  .string()
  .regex(/^\d{5,25}$/, "Use o id numérico do Facebook.")
  .describe("Id numérico no Facebook.");

/** Id de grupo na URL do Facebook: numérico ou nome (vanity). */
const fbGroupId = z
  .string()
  .regex(/^[A-Za-z0-9.]{3,60}$/, "Use o id ou o nome do grupo como aparece no endereço.")
  .describe("Id ou nome (vanity) do grupo na URL do Facebook.");

export const FacebookAccount = z.object({
  id: z.string(),
  fb_user_id: z.string(),
  name: z.string().nullable(),
  online: z.boolean().describe("A extensão falou com a plataforma nos últimos 10 min."),
  last_seen_at: z.string().nullable(),
  paused_until: z.string().nullable(),
  pause_reason: z.string().nullable(),
  group_count: z.number(),
  posts_today: z.number(),
  queued_jobs: z.number(),
  created_at: z.string(),
});
export type FacebookAccount = z.infer<typeof FacebookAccount>;

/** Termos para abrir a busca visível de grupos no Facebook. */
export const DiscoverFacebookGroupsInput = z.object({
  niche: z.string().trim().min(2).max(80),
  location: z.string().trim().max(80).optional(),
});
export type DiscoverFacebookGroupsInput = z.infer<typeof DiscoverFacebookGroupsInput>;

export const PrepareFacebookJoinInput = z.object({
  fb_user_id: fbId,
  group_id: fbGroupId,
  name: z.string().trim().min(1).max(200),
});
export type PrepareFacebookJoinInput = z.infer<typeof PrepareFacebookJoinInput>;

export const FacebookGroupSearch = z.object({
  query: z.string(),
  url: z.url(),
});
export const DiscoverFacebookGroupsResult = z.object({
  searches: z.array(FacebookGroupSearch),
});

/** Enviado pela extensão a cada minuto. */
export const FacebookHeartbeatInput = z.object({
  fb_user_id: fbId,
  name: z.string().trim().max(200).nullable().optional(),
});
export type FacebookHeartbeatInput = z.infer<typeof FacebookHeartbeatInput>;

export const FacebookHeartbeatResult = z.object({
  account_id: z.string(),
  paused_until: z.string().nullable(),
  pause_reason: z.string().nullable(),
});

export const AddFacebookGroupInput = z.object({
  fb_user_id: fbId.describe("Perfil que vai publicar no grupo."),
  group_id: fbGroupId,
  name: z.string().trim().min(1).max(200),
  url: z.url({ protocol: /^https$/ }).optional(),
  member_count: z.number().int().min(0).optional(),
  segment_ids: z.array(z.uuid()).max(50).optional(),
});
export type AddFacebookGroupInput = z.infer<typeof AddFacebookGroupInput>;

export const ClaimBrowserJobInput = z.object({ fb_user_id: fbId });
export type ClaimBrowserJobInput = z.infer<typeof ClaimBrowserJobInput>;

/** O que a extensão leu da página do grupo (só texto visível) para classificar a política. */
export const FacebookGroupCollected = z.object({
  rules_text: z
    .string()
    .max(8000)
    .optional()
    .describe("Regras e descrição (Sobre) do grupo, como texto."),
  post_texts: z
    .array(z.string().max(1000))
    .max(40)
    .optional()
    .describe("Texto dos últimos posts visíveis do feed (para ver se membros divulgam links)."),
});
export type FacebookGroupCollected = z.infer<typeof FacebookGroupCollected>;

/** A extensão analisa um grupo aberto: coleta o texto visível e o servidor classifica a política. */
export const AnalyzeFacebookGroupInput = z.object({
  fb_user_id: fbId.describe("Perfil que está no grupo."),
  group_id: fbGroupId,
  name: z.string().trim().min(1).max(200),
  member_count: z.number().int().min(0).optional(),
  collected: FacebookGroupCollected,
});
export type AnalyzeFacebookGroupInput = z.infer<typeof AnalyzeFacebookGroupInput>;

/** Correção da política por pessoa ou agente. */
export const SetGroupPostingPolicyInput = z.object({
  posting_policy: z.enum(["allowed", "approval", "restricted", "forbidden", "unknown"]),
  notes: z.string().max(500).nullable().optional(),
});
export type SetGroupPostingPolicyInput = z.infer<typeof SetGroupPostingPolicyInput>;

/** Trabalho entregue à extensão. */
export const BrowserJob = z.object({
  id: z.string(),
  type: z.enum(["post"]),
  group_id: z.string(),
  text: z.string(),
  /** Baixar com GET /v1/facebook/jobs/:id/image (com o token) */
  has_image: z.boolean(),
  auto_publish: z.boolean(),
  lease_until: z.string(),
});
export type BrowserJob = z.infer<typeof BrowserJob>;

export const BROWSER_JOB_ERRORS = ["blocked", "not_member", "other"] as const;

export const BrowserJobResultInput = z.object({
  ok: z.boolean(),
  post_id: z.string().max(100).nullable().optional(),
  post_url: z
    .url({ protocol: /^https$/ })
    .nullable()
    .optional(),
  /** O grupo exige aprovação do admin: o post ficou pendente */
  pending: z.boolean().optional(),
  error_kind: z
    .enum(BROWSER_JOB_ERRORS)
    .optional()
    .describe("blocked: aviso de bloqueio do Facebook; not_member: o perfil não está no grupo."),
  error: z.string().max(1000).optional(),
  /** Trecho da resposta do Facebook, para diagnóstico */
  raw: z.string().max(4000).optional(),
});
export type BrowserJobResultInput = z.infer<typeof BrowserJobResultInput>;
