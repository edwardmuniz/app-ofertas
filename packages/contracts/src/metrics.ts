import { z } from "zod";

const isoDate = z.iso.datetime({ offset: true });

// ── Período ─────────────────────────────────────────────────────

export const METRIC_PERIODS = ["today", "yesterday", "7d", "30d", "custom"] as const;

export const MetricsPeriodQuery = z.object({
  period: z
    .enum(METRIC_PERIODS)
    .default("7d")
    .describe("today/yesterday no fuso do workspace; 7d/30d terminam agora; custom usa from/to."),
  from: isoDate.optional().describe("Início (só com period=custom)."),
  to: isoDate.optional().describe("Fim (só com period=custom)."),
});
export type MetricsPeriodQuery = z.input<typeof MetricsPeriodQuery>;

const Period = z.object({ from: z.string(), to: z.string(), label: z.string() });

/** Variação percentual em relação ao período anterior (null sem base de comparação). */
const Change = z.number().nullable();

// ── Resumo ──────────────────────────────────────────────────────

export const PerformanceSummary = z.object({
  period: Period,
  previous_period: Period,
  timezone: z.string(),
  audience: z.object({
    members_total: z.number().describe("Soma dos membros dos grupos ativos (agora)."),
    channels_active: z.number(),
    joins: z.number(),
    leaves: z.number(),
    net_growth: z.number(),
    joins_change_pct: Change,
  }),
  publishing: z.object({
    posts_sent: z.number(),
    posts_failed: z.number(),
    scheduled_next_24h: z.number(),
    posts_sent_change_pct: Change,
  }),
  clicks: z.object({
    offer_clicks: z.number().describe("Cliques humanos em links de oferta."),
    invite_clicks: z.number().describe("Cliques humanos em links de convite."),
    bot_clicks: z.number(),
    clicks_per_post: z.number().nullable(),
    offer_clicks_change_pct: Change,
  }),
  top_channels: z.array(
    z.object({
      channel_id: z.string(),
      name: z.string(),
      members: z.number(),
      posts_sent: z.number(),
      clicks: z.number(),
      clicks_per_post: z.number().nullable(),
    }),
  ),
  top_offers: z.array(
    z.object({
      offer_id: z.string(),
      title: z.string(),
      platform: z.string(),
      posts_sent: z.number(),
      clicks: z.number(),
    }),
  ),
  best_hours: z.array(
    z.object({
      weekday: z.number().describe("0 = domingo"),
      hour: z.number(),
      posts: z.number(),
      clicks_per_post: z.number(),
    }),
  ),
  revenue: z
    .null()
    .describe("Comissões e lucro chegam no módulo Financeiro (fase 9). Por enquanto null."),
  alerts: z.array(z.object({ severity: z.string(), message: z.string() })),
  insights: z.array(z.string()).describe("Observações automáticas para orientar a ação."),
  data_freshness: z
    .string()
    .describe("Cliques consolidados até este horário (atualiza a cada 5 min)."),
});
export type PerformanceSummary = z.infer<typeof PerformanceSummary>;

// ── Funil ───────────────────────────────────────────────────────

export const FUNNEL_STAGES = [
  "invite_clicks",
  "joins",
  "retained",
  "offer_clicks",
  "orders",
] as const;

export const Funnel = z.object({
  period: Period,
  stages: z.array(
    z.object({
      key: z.enum(FUNNEL_STAGES),
      label: z.string(),
      value: z.number().nullable().describe("null = etapa ainda não medida."),
      previous: z.number().nullable(),
      change_pct: Change,
      rate: z.number().nullable().describe("Conversão em relação à etapa anterior (0–1)."),
      benchmark: z.number().nullable().describe("Taxa de referência interna."),
      note: z.string().nullable(),
    }),
  ),
  bottleneck: z
    .object({ key: z.enum(FUNNEL_STAGES), label: z.string(), hint: z.string() })
    .nullable()
    .describe("Etapa mais abaixo da referência."),
});
export type Funnel = z.infer<typeof Funnel>;

// ── Detalhamento ────────────────────────────────────────────────

export const MetricsBreakdownQuery = MetricsPeriodQuery.extend({
  view: z
    .enum(["channels", "offers", "hours"])
    .describe("Quebra por grupo, por oferta ou por horário."),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MetricsBreakdownQuery = z.input<typeof MetricsBreakdownQuery>;

export const ChannelMetrics = z.object({
  channel_id: z.string(),
  name: z.string(),
  status: z.string(),
  members: z.number(),
  member_limit: z.number(),
  joins: z.number(),
  leaves: z.number(),
  posts_sent: z.number(),
  clicks: z.number(),
  clicks_per_post: z.number().nullable(),
  clicks_per_100_members: z
    .number()
    .nullable()
    .describe("Cliques por envio a cada 100 membros (tipo CTR)."),
  leaves_per_post: z.number().nullable(),
});

export const OfferMetrics = z.object({
  offer_id: z.string(),
  title: z.string(),
  platform: z.string(),
  status: z.string(),
  price: z.number(),
  discount_pct: z.number().nullable(),
  posts_sent: z.number(),
  clicks: z.number(),
  clicks_per_post: z.number().nullable(),
});

export const HourCell = z.object({
  weekday: z.number().describe("0 = domingo"),
  hour: z.number(),
  posts: z.number(),
  clicks: z.number(),
  clicks_per_post: z.number().nullable(),
});

export const MetricsBreakdown = z.object({
  period: Period,
  view: z.enum(["channels", "offers", "hours"]),
  channels: z.array(ChannelMetrics).optional(),
  offers: z.array(OfferMetrics).optional(),
  hours: z
    .array(HourCell)
    .optional()
    .describe("Cliques atribuídos ao horário do envio (dia da semana × hora local)."),
});
export type MetricsBreakdown = z.infer<typeof MetricsBreakdown>;

// ── Alertas e status ────────────────────────────────────────────

export const ALERT_KINDS = [
  "messaging_down",
  "queue_stalled",
  "posts_failing",
  "group_admin_lost",
  "group_unavailable",
] as const;

export const Alert = z.object({
  id: z.string(),
  kind: z.enum(ALERT_KINDS),
  subject: z.string(),
  severity: z.enum(["warning", "critical"]),
  status: z.enum(["open", "resolved"]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
  opened_at: z.string(),
  last_seen_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Alert = z.infer<typeof Alert>;

export const ListAlertsQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAlertsQuery = z.input<typeof ListAlertsQuery>;

export const SystemStatus = z.object({
  ok: z.boolean().describe("false quando há alerta crítico ou o worker parou."),
  worker: z.object({
    ok: z.boolean(),
    last_seen_at: z.string().nullable(),
  }),
  queue: z.object({
    scheduled: z.number(),
    overdue: z.number().describe("Posts com horário vencido há mais de 10 min."),
    failed_last_hour: z.number(),
  }),
  messaging: z.array(z.object({ id: z.string(), label: z.string(), status: z.string() })),
  alerts: z.array(Alert),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/** Status público mínimo para monitores externos (UptimeRobot, Healthchecks...). */
export const PublicStatus = z.object({
  ok: z.boolean(),
  db: z.boolean(),
  worker: z.boolean(),
  worker_last_seen_at: z.string().nullable(),
});
export type PublicStatus = z.infer<typeof PublicStatus>;

// ── Calendário sazonal ──────────────────────────────────────────

export const SeasonalCalendarQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(400)
    .default(120)
    .describe("Quantos dias à frente olhar."),
});
export type SeasonalCalendarQuery = z.input<typeof SeasonalCalendarQuery>;

export const SeasonalEvent = z.object({
  key: z.string(),
  name: z.string(),
  date: z.string().describe("YYYY-MM-DD"),
  end_date: z.string().nullable(),
  importance: z.enum(["high", "medium", "low"]),
  days_until: z.number(),
  prep_start: z.string().describe("Quando começar a preparar (YYYY-MM-DD)."),
  phase: z.enum(["future", "prepare", "live"]),
  focus: z.array(z.string()).describe("Categorias que costumam vender mais."),
  checklist: z.array(z.string()),
});
export type SeasonalEvent = z.infer<typeof SeasonalEvent>;

export const SeasonalCalendar = z.object({
  today: z.string(),
  events: z.array(SeasonalEvent),
});
export type SeasonalCalendar = z.infer<typeof SeasonalCalendar>;
