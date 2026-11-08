import { z } from "zod";
import { CHANNEL_STATUS, Channel } from "./channels";
import { CREATIVE_TEMPLATES } from "./creatives";
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

export const SyncGroupsInput = z.object({
  group_jids: z
    .array(z.string().min(1))
    .max(1000)
    .optional()
    .describe(
      "Grupos a importar (JIDs vindos do dry_run). Sem esta lista, só atualiza os grupos já importados.",
    ),
  segment_ids: z
    .array(z.uuid())
    .max(50)
    .optional()
    .describe("Segmentos adicionados aos grupos escolhidos (os que eles já têm são mantidos)."),
});
export type SyncGroupsInput = z.infer<typeof SyncGroupsInput>;

export const AvailableGroup = z.object({
  jid: z.string(),
  name: z.string(),
  participant_count: z.number(),
  admin_only: z.boolean().nullable(),
  number_is_admin: z.boolean().nullable(),
  channel_id: z.string().nullable().describe("Canal correspondente, se o grupo já foi importado."),
  channel_status: z.enum(CHANNEL_STATUS).nullable(),
  linked: z
    .boolean()
    .describe(
      "O canal já está ligado a este número. Falso com channel_id: o canal ficou sem número (ex.: número removido) e pode ser religado escolhendo o grupo.",
    ),
});
export type AvailableGroup = z.infer<typeof AvailableGroup>;

/** Prévia (dry_run) da importação: o que o número tem e o que vai mudar. */
export const SyncGroupsPreview = z.object({
  groups: z.array(AvailableGroup),
  left: z
    .array(z.object({ channel_id: z.string(), name: z.string() }))
    .describe("Canais ligados ao número cujo grupo ele não está mais."),
  selected: z.array(z.string()),
  to_create: z.number(),
  to_update: z.number(),
});
export type SyncGroupsPreview = z.infer<typeof SyncGroupsPreview>;

export const SyncGroupsResult = z.object({
  created: z.number(),
  updated: z.number(),
  invite_errors: z.number().describe("Grupos sem link de convite (o número precisa ser admin)."),
  no_invite: z.array(z.string()).describe("Nomes dos grupos que ficaram sem link de convite."),
  channels: z.array(Channel),
});
export type SyncGroupsResult = z.infer<typeof SyncGroupsResult>;

export const RemoveMessagingAccountResult = z.object({
  removed: z.literal(true),
  channels_kept: z.number().describe("Grupos que continuam como canais, sem número ligado."),
  scheduled_posts_canceled: z.number(),
});
export type RemoveMessagingAccountResult = z.infer<typeof RemoveMessagingAccountResult>;

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
  coupon_ids: z
    .array(z.uuid())
    .max(20)
    .optional()
    .describe("Cupons da loja inteira (list_store_coupons) a divulgar, cada um num post."),
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
  with_image: z.boolean().default(true).describe("Enviar imagem com a legenda."),
  creative_template: z
    .enum(CREATIVE_TEMPLATES)
    .optional()
    .describe("Gera o card na hora do envio (preço sempre atualizado). Sem isto: foto do produto."),
  creative_id: z.uuid().optional().describe("Usa um criativo pronto (só com uma oferta)."),
});
export type SchedulePostsInput = z.input<typeof SchedulePostsInput>;

export const PlannedPost = z.object({
  channel_id: z.string(),
  channel_name: z.string(),
  offer_id: z.string().nullable(),
  coupon_id: z.string().nullable(),
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
  coupon_id: z.string().nullable(),
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
  coupon_id: z.uuid().optional(),
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
  from: isoDate.optional().describe("Envio (ou agendamento) a partir de (ISO)."),
  to: isoDate.optional().describe("Envio (ou agendamento) antes de (ISO)."),
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
  creative_template: z.string().nullable(),
  last_run_at: z.string().nullable(),
  created_at: z.string(),
  stats: z
    .object({
      state: z
        .enum(["running", "off_hours", "limit", "no_offers", "no_groups", "paused"])
        .describe(
          "running: publicando; off_hours: fora do horário; limit: todos os grupos bateram o máximo do dia; no_offers: nenhuma oferta aprovada nos filtros; no_groups: nenhum grupo ativo nos segmentos; paused: pausada.",
        ),
      next_at: z
        .string()
        .nullable()
        .describe("Quando sai o próximo envio (estimativa; o worker roda a cada minuto)."),
      today: z
        .number()
        .describe("Ofertas da regra hoje (enviadas + agendadas), somando os grupos."),
      sent_today: z.number(),
      failed_today: z.number(),
      scheduled: z.number().describe("Agendadas pela regra que ainda não saíram."),
      available: z
        .number()
        .describe("Ofertas aprovadas nos filtros que ainda podem sair (sem repetir em 7 dias)."),
      sent_7d: z.number(),
      sent_total: z.number(),
      groups: z.number().describe("Grupos ativos nos segmentos da regra."),
      groups_at_limit: z.number().describe("Grupos que já bateram o máximo do dia."),
    })
    .describe("Contadores do dia no fuso do workspace."),
});
export type AutomationRule = z.infer<typeof AutomationRule>;
export type RuleFilters = z.infer<typeof RuleFilters>;

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
    .min(1)
    .max(720)
    .optional()
    .describe("Intervalo mínimo entre posts da regra no mesmo grupo. Padrão: 30."),
  template_id: z.uuid().nullable().optional(),
  creative_template: z
    .enum(CREATIVE_TEMPLATES)
    .nullable()
    .optional()
    .describe("Card gerado para cada envio. null = foto do produto."),
});
export type UpsertAutomationRuleInput = z.infer<typeof UpsertAutomationRuleInput>;
