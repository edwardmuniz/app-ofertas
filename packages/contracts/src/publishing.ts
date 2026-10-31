import { z } from "zod";
import { Channel } from "./channels";
import { PLATFORMS } from "./offers";

const hhmmRange = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const isoDate = z.iso.datetime({ offset: true });

// ── Contas de WhatsApp ──────────────────────────────────────────

export const MESSAGING_STATUS = ["pending", "connected", "disconnected", "logged_out"] as const;

export const MessagingAccount = z.object({
  id: z.string(),
  provider: z.enum(["evolution_go", "fake"]),
  label: z.string(),
  phone: z.string().nullable(),
  own_jid: z.string().nullable(),
  status: z.enum(MESSAGING_STATUS),
  last_event_at: z.string().nullable(),
  last_error: z.string().nullable(),
  connected_at: z.string().nullable(),
  channel_count: z.number(),
  created_at: z.string(),
});
export type MessagingAccount = z.infer<typeof MessagingAccount>;

export const CreateMessagingAccountInput = z.object({
  label: z.string().trim().min(1).max(80),
  provider: z
    .enum(["evolution_go", "fake"])
    .default("evolution_go")
    .describe("fake = WhatsApp simulado, para testar sem número."),
});
export type CreateMessagingAccountInput = z.input<typeof CreateMessagingAccountInput>;

export const ConnectionState = z.object({
  account: MessagingAccount,
  qr_image: z.string().nullable().describe("Data URL do QR code (quando ainda não conectado)."),
});
export type ConnectionState = z.infer<typeof ConnectionState>;

export const SyncGroupsResult = z.object({
  created: z.number(),
  updated: z.number(),
  invite_errors: z.number().describe("Grupos sem link de convite (o número precisa ser admin)."),
  channels: z.array(Channel),
});
export type SyncGroupsResult = z.infer<typeof SyncGroupsResult>;

// ── Modelos de mensagem ─────────────────────────────────────────

export const TEMPLATE_VARIABLES = [
  "titulo",
  "preco",
  "preco_original",
  "desconto",
  "cupom",
  "link",
  "plataforma",
  "loja",
  "selo",
] as const;

export const MessageTemplate = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
});
export type MessageTemplate = z.infer<typeof MessageTemplate>;

export const UpsertMessageTemplateInput = z.object({
  id: z.uuid().optional().describe("Informe para editar; omita para criar."),
  name: z.string().trim().min(1).max(60).optional(),
  body: z
    .string()
    .min(1)
    .max(3000)
    .optional()
    .describe(
      "Variáveis: {{titulo}} {{preco}} {{preco_original}} {{desconto}} {{cupom}} {{link}} {{plataforma}} {{loja}} {{selo}}. Linhas com variável vazia somem. Separe variações com uma linha contendo só ---.",
    ),
  is_default: z.boolean().optional().describe("Usar como padrão do workspace."),
});
export type UpsertMessageTemplateInput = z.infer<typeof UpsertMessageTemplateInput>;

// ── Publicações ─────────────────────────────────────────────────

export const POST_STATUS = [
  "scheduled",
  "sending",
  "sent",
  "failed",
  "skipped",
  "canceled",
  "deleted",
] as const;

export const SchedulePostsInput = z.object({
  offer_ids: z.array(z.uuid()).max(50).optional().describe("Ofertas aprovadas a publicar."),
  text: z.string().min(1).max(4000).optional().describe("Mensagem livre, sem oferta."),
  channel_ids: z.array(z.uuid()).max(100).optional(),
  segment_ids: z
    .array(z.uuid())
    .max(20)
    .optional()
    .describe("Publica em todos os grupos do segmento."),
  at: isoDate.optional().describe("Quando começar (padrão: agora). Respeita as janelas de envio."),
  spacing_minutes: z
    .number()
    .int()
    .min(1)
    .max(240)
    .optional()
    .describe("Intervalo entre posts no mesmo grupo (padrão: 10)."),
  template_id: z.uuid().optional(),
  with_image: z.boolean().default(true).describe("Enviar a foto do produto com a legenda."),
});
export type SchedulePostsInput = z.input<typeof SchedulePostsInput>;

export const PlannedPost = z.object({
  channel_id: z.string(),
  channel_name: z.string(),
  offer_id: z.string().nullable(),
  title: z.string().nullable(),
  scheduled_at: z.string(),
  body: z.string(),
});

export const SkippedPost = z.object({
  channel_id: z.string().nullable(),
  offer_id: z.string().nullable(),
  reason: z.string(),
});

export const Post = z.object({
  id: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  offer_id: z.string().nullable(),
  title: z.string().nullable(),
  status: z.enum(POST_STATUS),
  scheduled_at: z.string(),
  sent_at: z.string().nullable(),
  body: z.string().nullable(),
  short_url: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number(),
  rule_id: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type Post = z.infer<typeof Post>;

export const ScheduleResult = z.object({
  scheduled: z.array(Post),
  skipped: z.array(SkippedPost),
});

export const PreviewPostInput = z.object({
  offer_id: z.uuid().optional(),
  text: z.string().max(4000).optional(),
  template_id: z.uuid().optional(),
});
export type PreviewPostInput = z.infer<typeof PreviewPostInput>;

export const PostPreview = z.object({
  body: z.string(),
  image_url: z.string().nullable(),
});

export const ListPostsQuery = z.object({
  status: z.enum(POST_STATUS).optional(),
  channel_id: z.uuid().optional(),
  offer_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListPostsQuery = z.input<typeof ListPostsQuery>;

export const PostPage = z.object({ items: z.array(Post), next_cursor: z.string().nullable() });

// ── Regras de automação ─────────────────────────────────────────

export const RuleFilters = z.object({
  min_score: z.number().int().min(0).max(100).optional(),
  min_discount: z.number().int().min(0).max(95).optional(),
  keywords: z
    .array(z.string().max(40))
    .max(20)
    .optional()
    .describe("Publica só ofertas cujo título ou categoria contém alguma destas palavras."),
  platforms: z.array(z.enum(PLATFORMS)).optional(),
});

export const AutomationRule = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  filters: RuleFilters,
  segment_ids: z.array(z.string()),
  windows: z.array(z.string()),
  max_per_day: z.number(),
  min_interval_minutes: z.number(),
  template_id: z.string().nullable(),
  last_run_at: z.string().nullable(),
  created_at: z.string(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

export const UpsertAutomationRuleInput = z.object({
  id: z.uuid().optional().describe("Informe para editar; omita para criar."),
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  filters: RuleFilters.optional(),
  segment_ids: z.array(z.uuid()).min(1).max(20).optional().describe("Obrigatório ao criar."),
  windows: z
    .array(z.string().regex(hhmmRange, "Use HH:MM-HH:MM"))
    .max(10)
    .optional()
    .describe("Janelas de envio. Vazio = usa as preferências do workspace."),
  max_per_day: z.number().int().min(1).max(100).optional().describe("Por grupo. Padrão: 10."),
  min_interval_minutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .optional()
    .describe("Intervalo mínimo entre posts da regra no mesmo grupo. Padrão: 30."),
  template_id: z.uuid().nullable().optional(),
});
export type UpsertAutomationRuleInput = z.infer<typeof UpsertAutomationRuleInput>;
