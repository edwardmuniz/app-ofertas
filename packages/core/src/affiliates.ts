import {
  type AffiliateConnector,
  CREDENTIAL_FIELDS,
  FEED_FIELDS,
  isConnectorError,
  type Platform,
} from "@ofertas/connectors";
import {
  type AffiliateAccount,
  ConnectAffiliateAccountInput,
  UpdateAffiliateAccountInput,
} from "@ofertas/contracts";
import { affiliateAccounts, type DbOrTx, offers } from "@ofertas/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import type { Ctx, Deps } from "./context";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { FeedConnector, type FeedCredentials, feedRunning, pingFeed } from "./feed";
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

type ConnectorDeps = Pick<Deps, "secrets" | "affiliateConnectors" | "db" | "openStream">;

export function connectorFor(deps: ConnectorDeps, row: AccountRow): AffiliateConnector {
  const credentials = row.credentials
    ? deps.secrets.decryptJson<Record<string, string>>(row.credentials)
    : null;
  if (row.mode === "feed") {
    const creds = credentials as Partial<FeedCredentials> | null;
    return new FeedConnector(deps.db, row.id, creds, deps.openStream);
  }
  return deps.affiliateConnectors({ platform: row.platform, mode: row.mode, credentials });
}

function toAccount(deps: ConnectorDeps, r: AccountRow): AffiliateAccount {
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
    feed:
      r.mode === "feed"
        ? {
            synced_at: r.feedSyncedAt?.toISOString() ?? null,
            items: r.feedInfo?.items ?? 0,
            read: r.feedInfo?.read ?? 0,
            running: feedRunning(r.feedInfo),
            progress: feedRunning(r.feedInfo) ? (r.feedInfo?.progress ?? null) : null,
            error:
              r.feedInfo?.running_since && !feedRunning(r.feedInfo)
                ? "Importação interrompida (o worker parou ou reiniciou). Recomeça sozinha em até 2 minutos."
                : (r.feedInfo?.error ?? null),
          }
        : null,
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
  if (input.mode === "feed" && !FEED_FIELDS[input.platform]) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Feed de produtos não disponível para ${input.platform}.`,
    );
  }
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
  const credentials =
    input.mode === "live"
      ? (input.credentials ?? {})
      : input.mode === "feed"
        ? {
            affiliate_id: (input.credentials?.affiliate_id ?? "").trim(),
            feed_urls: (input.credentials?.feed_urls ?? "").trim(),
          }
        : null;

  return runMutation(ctx, {
    action: "affiliates.connect",
    scope: "settings:write",
    // Nunca grava o segredo no log/idempotência: só a plataforma e o rótulo.
    input: { platform: input.platform, label: input.label, mode: input.mode },
    opts,
    preview: async (c, i) => {
      try {
        if (i.mode === "feed") await pingFeed(credentials, c.openStream);
        else
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

/** Pede uma nova importação do feed de produtos (o worker importa na próxima rodada). */
export async function requestFeedSync(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  return runMutation(ctx, {
    action: "affiliates.feed_sync",
    scope: "offers:write",
    input: { id },
    opts,
    target: (i) => ({ type: "affiliate_account", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select()
        .from(affiliateAccounts)
        .where(
          and(
            eq(affiliateAccounts.id, i.id),
            eq(affiliateAccounts.workspaceId, ctx.actor.workspaceId),
          ),
        );
      if (!row) throw new AppError("NOT_FOUND", "Conta de afiliado não encontrada.");
      if (row.mode !== "feed") {
        throw new AppError("VALIDATION_ERROR", "Só contas em modo feed importam o feed.");
      }
      return { id: row.id, running: Boolean(row.feedInfo?.running_since) };
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(affiliateAccounts)
        .set({ feedSyncedAt: null })
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

async function loadAccount(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(affiliateAccounts)
    .where(and(eq(affiliateAccounts.id, id), eq(affiliateAccounts.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Conta de afiliado não encontrada.");
  return row;
}

/**
 * Edita nome e credenciais de uma conta. Credenciais em branco mantêm as atuais; as novas são
 * testadas antes de salvar. Mudar os links do feed pede nova importação. Só pelo painel.
 */
export async function updateAffiliateAccount(
  ctx: Ctx,
  id: string,
  raw: UpdateAffiliateAccountInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Editar contas de afiliado");
  const input = UpdateAffiliateAccountInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const changed = Object.fromEntries(
    Object.entries(input.credentials ?? {})
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v),
  );
  return runMutation(ctx, {
    action: "affiliates.update",
    scope: "settings:write",
    // Nunca grava segredos no log: só quais campos mudaram.
    input: { id, label: input.label, credential_fields: Object.keys(changed) },
    opts,
    target: (i) => ({ type: "affiliate_account", id: i.id }),
    preview: async (c, i) => {
      const row = await loadAccount(c.db, wsId, i.id);
      const current = row.credentials
        ? c.secrets.decryptJson<Record<string, string>>(row.credentials)
        : null;
      let credentials: Record<string, string> | null = current;
      if (i.credential_fields.length) {
        if (row.mode === "fake") {
          throw new AppError("VALIDATION_ERROR", "Conta simulada não tem credenciais.");
        }
        credentials = { ...(current ?? {}), ...changed };
        try {
          if (row.mode === "feed") await pingFeed(credentials, c.openStream);
          else {
            await c
              .affiliateConnectors({ platform: row.platform, mode: row.mode, credentials })
              .ping();
          }
        } catch (err) {
          throw providerError(err);
        }
      }
      const feedChanged = row.mode === "feed" && credentials?.feed_urls !== current?.feed_urls;
      return { id: row.id, label: i.label ?? row.label, credentials, feedChanged, mode: row.mode };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .update(affiliateAccounts)
        .set({
          label: p.label,
          ...(i.credential_fields.length && p.credentials
            ? {
                credentials: ctx.secrets.encryptJson(p.credentials),
                status: "active" as const,
                lastError: null,
              }
            : {}),
          ...(p.feedChanged ? { feedSyncedAt: null } : {}),
        })
        .where(eq(affiliateAccounts.id, p.id))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Conta de afiliado não encontrada.");
      return toAccount(ctx, row);
    },
  });
}

/**
 * Remove uma conta. Ofertas e publicações ficam: as ofertas passam a "por link" (mantêm o
 * link de afiliado salvo). O catálogo do feed é apagado. Só pelo painel.
 */
export async function deleteAffiliateAccount(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  requireHuman(ctx.actor, "Remover contas de afiliado");
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "affiliates.delete",
    scope: "settings:write",
    input: { id },
    opts,
    target: (i) => ({ type: "affiliate_account", id: i.id }),
    preview: async (c, i) => {
      const row = await loadAccount(c.db, wsId, i.id);
      const [{ count = 0 } = {}] = await c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(offers)
        .where(eq(offers.affiliateAccountId, row.id));
      return { id: row.id, label: row.label, offers_detached: count };
    },
    execute: async (tx, _i, p) => {
      await tx.db
        .update(offers)
        .set({ affiliateAccountId: null })
        .where(eq(offers.affiliateAccountId, p.id));
      await tx.db.delete(affiliateAccounts).where(eq(affiliateAccounts.id, p.id));
      return { id: p.id, deleted: true as const, offers_detached: p.offers_detached };
    },
  });
}
