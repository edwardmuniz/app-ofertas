import type { ActorType, Origin, Role, Scope } from "@ofertas/contracts";
import type { Db, DbOrTx } from "@ofertas/db";
import type { CounterStore } from "./limits";

export type Actor = {
  type: ActorType;
  /** id do usuário, do token ou nome do processo (system) */
  id: string;
  /** Nome legível para o log de auditoria */
  label: string;
  workspaceId: string;
  scopes: ReadonlySet<Scope>;
  origin: Origin;
  /** Presente quando o ator é um usuário logado */
  userId?: string;
  role?: Role;
};

export type Deps = {
  db: Db;
  counters: CounterStore;
  now?: () => Date;
};

export type Ctx = Deps & { actor: Actor };

/** Contexto dentro de uma transação: mesmas dependências, mas `db` é a transação. */
export type TxCtx = Omit<Ctx, "db"> & { db: DbOrTx };

export const now = (deps: Pick<Deps, "now">) => (deps.now ? deps.now() : new Date());
