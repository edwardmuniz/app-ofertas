import { z } from "zod";

export const AI_FEATURES = ["copy", "curator"] as const;

const AiUsageLine = z.object({
  feature: z.enum(AI_FEATURES).describe("copy = texto das ofertas; curator = curador automático."),
  calls: z.number().describe("Gerações (um texto, uma rodada do curador)."),
  requests: z.number().describe("Chamadas ao modelo."),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number().describe("Dólar, somando o que o provedor informou."),
});

const AiUsagePeriod = z.object({
  cost_usd: z.number(),
  by_feature: z.array(AiUsageLine),
});

export const AiUsageSummary = z.object({
  today: AiUsagePeriod,
  month: AiUsagePeriod,
  since: z.string().nullable().describe("Primeiro registro (o gasto anterior não foi medido)."),
  unpriced_calls: z
    .number()
    .describe("Gerações no mês sem custo informado (ex.: Gemini, que não devolve o valor)."),
});
export type AiUsageSummary = z.infer<typeof AiUsageSummary>;
