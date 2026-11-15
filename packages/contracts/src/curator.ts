import { z } from "zod";
import { PLATFORMS } from "./offers";

export const CuratorPick = z.object({
  offer_id: z.string().nullable().describe("Preenchido depois de gravada na curadoria."),
  product_id: z.string(),
  platform: z.enum(PLATFORMS),
  account_id: z.string().describe("Conta de afiliado da oferta."),
  account_label: z.string(),
  title: z.string(),
  price: z.number(),
  discount_pct: z.number().nullable(),
  score: z.number(),
  reason: z.string().describe("Por que o agente escolheu."),
});
export type CuratorPick = z.infer<typeof CuratorPick>;

export const CuratorRun = z.object({
  picks: z.array(CuratorPick),
  searches: z.array(z.string()).describe("Termos que o agente buscou."),
  summary: z.string().describe("Resumo do agente."),
  errors: z.array(z.string()),
});
export type CuratorRun = z.infer<typeof CuratorRun>;

export const CuratorStatus = z.object({
  enabled: z.boolean(),
  configured: z.boolean().describe("false = falta OPENROUTER_API_KEY no servidor."),
  every_hours: z.number(),
  max_offers: z.number().describe("Máximo por rodada em cada conta."),
  accounts: z
    .array(z.object({ id: z.string(), label: z.string(), platform: z.enum(PLATFORMS) }))
    .describe("Contas de afiliado ativas em que o curador busca."),
  last_run_at: z.string().nullable(),
  next_run_at: z.string().nullable(),
  requested_at: z
    .string()
    .nullable()
    .describe("Rodada pedida e ainda não atendida (o worker roda em até 1 minuto)."),
  last_result: z
    .object({
      added: z.number(),
      searches: z.array(z.string()),
      summary: z.string(),
      error: z.string().nullable(),
      by_account: z.record(z.string(), z.number()).describe("Ofertas trazidas por conta (rótulo)."),
      cost_usd: z.number().nullable().describe("Gasto da rodada com a IA, em dólar."),
    })
    .nullable(),
});
export type CuratorStatus = z.infer<typeof CuratorStatus>;
