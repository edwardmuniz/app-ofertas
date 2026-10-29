import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { AppError } from "./errors";

// Paginação por cursor em ordem decrescente de (created_at, id).
// Cursor = "<created_at ISO>|<id>" em base64url.

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string) {
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime()) || !id) {
    throw new AppError("VALIDATION_ERROR", "Cursor inválido.", {
      hint: "Use o valor next_cursor retornado pela página anterior.",
    });
  }
  return { date, id };
}

/** Condição "mais antigo que o cursor". */
export function olderThan(cursor: string, createdAt: PgColumn, id: PgColumn): SQL | undefined {
  const c = decodeCursor(cursor);
  return or(lt(createdAt, c.date), and(eq(createdAt, c.date), lt(id, c.id)));
}

/** Monta a página a partir de rows buscadas com limit + 1. */
export function toPage<R extends { createdAt: Date; id: string }, T>(
  rows: R[],
  limit: number,
  map: (r: R) => T,
) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(map),
    next_cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
