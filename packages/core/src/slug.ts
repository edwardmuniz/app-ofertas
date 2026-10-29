import { randomInt } from "node:crypto";
import { AppError } from "./errors";

// Sem caracteres ambíguos (0/O, 1/l/I).
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOWER_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Código curto aleatório. `lowercase` para caminhos digitados à mão (ex.: convites). */
export function generateSlug(length = 7, opts: { lowercase?: boolean } = {}): string {
  const alphabet = opts.lowercase ? LOWER_ALPHABET : ALPHABET;
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** Caminhos do redirecionador que não podem virar slug. */
export const RESERVED_SLUGS = new Set([
  "entrar",
  "health",
  "api",
  "admin",
  "app",
  "www",
  "bio",
  "l",
  "r",
  "static",
  "assets",
  "favicon.ico",
  "robots.txt",
]);

export function normalizeCustomSlug(slug: string): string {
  const s = slug.toLowerCase();
  if (RESERVED_SLUGS.has(s)) {
    throw new AppError("VALIDATION_ERROR", `O slug "${s}" é reservado.`, {
      hint: "Escolha outro slug ou omita para gerar um automaticamente.",
    });
  }
  return s;
}
