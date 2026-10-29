import { type DbOrTx, policies } from "@ofertas/db";
import { and, eq } from "drizzle-orm";

export type PolicyMode = "auto" | "approval" | "blocked";

/**
 * Política padrão por ação. Ações fora desta lista são `auto`.
 * Cada workspace pode sobrescrever na tabela `policies`.
 * Fases futuras adicionam aqui, ex.: "ads.create": "approval".
 */
export const DEFAULT_POLICIES: Record<string, PolicyMode> = {};

export async function resolvePolicy(
  db: DbOrTx,
  workspaceId: string,
  action: string,
): Promise<PolicyMode> {
  const [row] = await db
    .select({ mode: policies.mode })
    .from(policies)
    .where(and(eq(policies.workspaceId, workspaceId), eq(policies.actionType, action)))
    .limit(1);
  return row?.mode ?? DEFAULT_POLICIES[action] ?? "auto";
}
