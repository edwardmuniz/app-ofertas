import type { Scope } from "@ofertas/contracts";
import type { Actor } from "./context";
import { AppError } from "./errors";

export function requireScope(actor: Actor, scope: Scope) {
  if (actor.scopes.has(scope)) return;
  throw new AppError("FORBIDDEN_SCOPE", `Esta ação exige o escopo "${scope}".`, {
    hint:
      actor.type === "token"
        ? `Crie um token com o escopo "${scope}" em Configurações → Conectar agente.`
        : "Peça a um administrador do workspace para alterar seu papel.",
    details: { required_scope: scope },
  });
}

/** Ações que só humanos logados no painel podem fazer (ex.: criar tokens). */
export function requireHuman(actor: Actor, what: string) {
  if (actor.type === "user") return;
  throw new AppError("FORBIDDEN", `${what} só pode ser feito por um usuário no painel.`, {
    hint: "Peça ao operador humano para fazer isso no painel.",
  });
}
