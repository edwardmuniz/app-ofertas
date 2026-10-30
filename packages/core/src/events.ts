import { type DbOrTx, events } from "@ofertas/db";

/**
 * Tipos de evento emitidos pela plataforma. Alimentam alertas, recomendações (growth)
 * e, futuramente, webhooks.
 */
export type EventType =
  | "segment.full"
  | "link.created"
  | "link.destination_changed"
  | "offer.expired"
  | "affiliate.auth_failed";

export async function emitEvent(
  db: DbOrTx,
  workspaceId: string,
  type: EventType,
  payload: Record<string, unknown>,
) {
  await db.insert(events).values({ workspaceId, type, payload });
}
