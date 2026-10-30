import {
  type AffiliateConnector,
  CREDENTIAL_FIELDS,
  isConnectorError,
  type Platform,
} from "@ofertas/connectors";
import { type AffiliateAccount, ConnectAffiliateAccountInput } from "@ofertas/contracts";
import { affiliateAccounts, type DbOrTx } from "@ofertas/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import type { Ctx, Deps } from "./context";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { type MutationOptions, runMutation } from "./mutation";

type AccountRow = typeof affiliateAccounts.$inferSelect;

/** Converte falhas de conectores no erro padrão da plataforma. */
export function providerError(err: unknown): AppError {
  if (isConnectorError(err)) {
    const hints: Record<string, string> = {
      AUTH: "Confira as credenciais da conta em Afiliados.",
      RATE_LIMIT: "A plataforma limitou as requisições. Tente de novo em alguns minutos.",
      UNAVAILABLE: "A plataforma está fora do ar ou lenta. Tente de novo em instantes.",
      UNSUPPORTED: "Esta plataforma ainda não tem integração.",
    };
    return new AppError("PROVIDER_ERROR", err.message, {
      hint: hints[err.code],
      details: { platform: err.platform, provider_code: err.code },
    });
  }
  if (err instanceof AppError) return err;
  return new AppError("PROVIDER_ERROR", `Falha na integração: ${String(err)}`);
}

export function connectorFor(deps: Pick<Deps, "secrets" | "affiliateConnectors">, row: AccountRow) {
  const credentials = row.credentials
    ? deps.secrets.decryptJson<Record<string, string>>(row.credentials)
    : null;
  return deps.affiliateConnectors({ platform: row.platform, mode: row.mode, credentials });
}

function toAccount(
  deps: Pick<Deps, "secrets" | "affiliateConnectors">,
  r: AccountRow,
): AffiliateAccount {
  let capabilities: AffiliateConnector["capabilities"] = {
    search: false,
    lookup: false,
    linkGeneration: false,
    subIds: 0,
    conversionsReport: false,
  };
  try {
    capabilities = connectorFor(deps, r).capabilities;
  } catch {
    // conector indisponível: mostra sem capacidades
  }
  return {
    id: r.id,
    platform: r.platform,
    label: r.label,
    mode: r.mode,
    status: r.status,
    last_error: r.lastError,
    capabilities,
    created_at: r.createdAt.toISOString(),
  };
}

export async function listAffiliateAccounts(ctx: Ctx): Promise<AffiliateAccount[]> {
  requireScope(ctx.actor, "offers:read");
  const rows = await ctx.db
    .select()
    .from(affiliateAccounts)
    .where(eq(affiliateAccounts.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(affiliateAccounts.createdAt));
  return rows.map((r) => toAccount(ctx, r));
}

/** Contas ativas do workspace, opcionalmente filtradas por plataforma. */
export async function activeAccounts(db: DbOrTx, workspaceId: string, platforms?: Platform[]) {
  const conds = [
    eq(affiliateAccounts.workspaceId, workspaceId),
    inArray(affiliateAccounts.status, ["active", "error"]),
  ];
  if (platforms?.length) conds.push(inArray(affiliateAccounts.platform, platforms));
  return db
    .select()
    .from(affiliateAccounts)
    .where(and(...conds))
    .orderBy(asc(affiliateAccounts.createdAt));
}

/**
 * Conecta uma conta de afiliado. Só pelo painel: credenciais não devem passar por agentes.
 * Testa a conexão antes de salvar.
 */
export async function connectAffiliateAccount(
  ctx: Ctx,
  raw: ConnectAffiliateAccountInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Conectar contas de afiliado");
  const input = ConnectAffiliateAccountInput.parse(raw);
  if (input.mode === "live") {
    const missing = CREDENTIAL_FIELDS[input.platform]
      .filter((f) => !input.credentials?.[f.key])
      .map((f) => f.key);
    if (missing.length || CREDENTIAL_FIELDS[input.platform].length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        missing.length
          ? `Credenciais faltando: ${missing.join(", ")}.`
          : `A integração com ${input.platform} ainda não está disponível.`,
        { details: { missing } },
      );
    }
  }
  const credentials = input.mode === "live" ? (input.credentials ?? {}) : null;

  return runMutation(ctx, {
    action: "affiliates.connect",
    scope: "settings:write",
    // Nunca grava o segredo no log/idempotência: só a plataforma e o rótulo.
    input: { platform: input.platform, label: input.label, mode: input.mode },
    opts,
    preview: async (c, i) => {
      try {
        await c.affiliateConnectors({ platform: i.platform, mode: i.mode, credentials }).ping();
      } catch (err) {
        throw providerError(err);
      }
      return { ...i, connection: "ok" };
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .insert(affiliateAccounts)
        .values({
          workspaceId: ctx.actor.workspaceId,
          platform: i.platform,
          label: i.label,
          mode: i.mode,
          credentials: credentials ? ctx.secrets.encryptJson(credentials) : null,
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar conta");
      return toAccount(ctx, row);
    },
  });
}

export async function setAffiliateAccountStatus(
  ctx: Ctx,
  id: string,
  status: "active" | "disabled",
  opts: MutationOptions = {},
) {
  return runMutation(ctx, {
    action: status === "disabled" ? "affiliates.disable" : "affiliates.enable",
    scope: "settings:write",
    input: { id, status },
    opts,
    target: (i) => ({ type: "affiliate_account", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select({ id: affiliateAccounts.id })
        .from(affiliateAccounts)
        .where(
          and(
            eq(affiliateAccounts.id, i.id),
            eq(affiliateAccounts.workspaceId, ctx.actor.workspaceId),
          ),
        );
      if (!row) throw new AppError("NOT_FOUND", "Conta de afiliado não encontrada.");
      return i;
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(affiliateAccounts)
        .set({ status: i.status, lastError: null })
        .where(eq(affiliateAccounts.id, i.id))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Conta de afiliado não encontrada.");
      return toAccount(ctx, row);
    },
  });
}

/** Marca a conta com erro (ou limpa) após uma chamada ao conector. */
export async function recordAccountHealth(db: DbOrTx, account: AccountRow, err: unknown | null) {
  if (!err) {
    if (account.status === "error") {
      await db
        .update(affiliateAccounts)
        .set({ status: "active", lastError: null })
        .where(eq(affiliateAccounts.id, account.id));
    }
    return;
  }
  const auth = isConnectorError(err) && err.code === "AUTH";
  await db
    .update(affiliateAccounts)
    .set({
      status: auth ? "error" : account.status,
      lastError: String((err as Error).message ?? err),
    })
    .where(eq(affiliateAccounts.id, account.id));
  if (auth && account.status !== "error") {
    await emitEvent(db, account.workspaceId, "affiliate.auth_failed", {
      account_id: account.id,
      platform: account.platform,
    });
  }
}
