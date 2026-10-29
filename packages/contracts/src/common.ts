import { z } from "zod";

export const ORIGINS = ["web", "rest", "mcp", "cli", "worker"] as const;
export type Origin = (typeof ORIGINS)[number];

export const ACTOR_TYPES = ["user", "token", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Opções aceitas por toda operação que altera algo. No MCP vêm como argumentos; na REST, como query/headers. */
export const MutationOptions = z.object({
  dry_run: z
    .boolean()
    .optional()
    .describe("Se true, retorna a prévia do que seria feito sem alterar nada."),
  idempotency_key: z
    .string()
    .min(8)
    .max(200)
    .optional()
    .describe("Chave única da operação. Repetir a chamada com a mesma chave não executa de novo."),
  reason: z.string().max(500).optional().describe("Motivo da ação, gravado no log de auditoria."),
});
export type MutationOptions = z.infer<typeof MutationOptions>;

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
