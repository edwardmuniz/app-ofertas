import { z } from "zod";

const hhmmRange = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** Preferências do negócio. Lidas por humanos e agentes para manter o padrão da operação. */
export const Preferences = z.object({
  tone_of_voice: z.string().max(1000).optional().describe("Tom de voz das mensagens e criativos."),
  niches: z.array(z.string().max(60)).max(50).optional().describe("Nichos foco, ex.: casa, tech."),
  posting_windows: z
    .array(z.string().regex(hhmmRange, "Use o formato HH:MM-HH:MM"))
    .max(20)
    .optional()
    .describe("Janelas de envio no fuso do workspace, ex.: 08:00-12:00."),
  forbidden: z
    .array(z.string().max(200))
    .max(100)
    .optional()
    .describe("O que nunca publicar (categorias, marcas, termos)."),
  notes: z.string().max(5000).optional().describe("Outras orientações livres."),
  auto_copy: z
    .boolean()
    .optional()
    .describe(
      "Gerar com IA o texto das ofertas aprovadas que ainda não têm texto (em segundo plano). Não substitui texto escrito por pessoas ou agentes. Padrão: false.",
    ),
  creative_cards: z
    .boolean()
    .optional()
    .describe(
      "Gerar cards (criativos) nos envios. false = envia só a foto do produto, mesmo em regras e posts que pediram card. Padrão: true.",
    ),
  alert_webhook_url: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable()
    .optional()
    .describe(
      "URL que recebe os alertas (POST JSON com text/content). Funciona com Slack, Discord e ntfy.",
    ),
});
export type Preferences = z.infer<typeof Preferences>;

export const MODULE_STATUS = ["available", "planned"] as const;

export const WorkspaceOverview = z.object({
  workspace: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  counts: z.object({
    members: z.number(),
    active_tokens: z.number(),
    pending_approvals: z.number(),
    actions_last_24h: z.number(),
  }),
  modules: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      status: z.enum(MODULE_STATUS),
      phase: z.number(),
    }),
  ),
  alerts: z.array(
    z.object({ level: z.enum(["info", "warning", "critical"]), message: z.string() }),
  ),
});
export type WorkspaceOverview = z.infer<typeof WorkspaceOverview>;
