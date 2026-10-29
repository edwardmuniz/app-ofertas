import { z } from "zod";
import { ACTOR_TYPES, ORIGINS } from "./common";

export const AUDIT_RESULTS = ["ok", "error", "pending_approval"] as const;

export const AuditEntry = z.object({
  id: z.string(),
  created_at: z.string(),
  actor_type: z.enum(ACTOR_TYPES),
  actor_id: z.string(),
  actor_label: z.string(),
  origin: z.enum(ORIGINS),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  params: z.unknown(),
  reason: z.string().nullable(),
  result: z.enum(AUDIT_RESULTS),
  error: z.unknown().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional().describe("Valor next_cursor da página anterior."),
  origin: z.enum(ORIGINS).optional(),
  actor_type: z.enum(ACTOR_TYPES).optional(),
  action: z
    .string()
    .max(100)
    .optional()
    .describe("Filtra por ação exata, ex.: workspace.update_preferences"),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = z.object({
  items: z.array(AuditEntry),
  next_cursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;
