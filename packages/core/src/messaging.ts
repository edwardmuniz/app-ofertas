import { timingSafeEqual } from "node:crypto";
import {
  type InstanceRef,
  isMessagingError,
  type MessagingProviderName,
  parseEvolutionWebhook,
  type WebhookEnvelope,
} from "@ofertas/connectors";
import {
  type ConnectionState,
  CreateMessagingAccountInput,
  type MessagingAccount,
  type SyncGroupsResult,
} from "@ofertas/contracts";
import {
  channelStatsDaily,
  channels,
  type DbOrTx,
  messagingAccounts,
  workspaces,
} from "@ofertas/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import { getChannelRow, segmentIdsFor, toChannel } from "./channels";
import { type Ctx, type Deps, now } from "./context";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { type MutationOptions, runMutation } from "./mutation";
import { localDate } from "./tz";

type AccountRow = typeof messagingAccounts.$inferSelect;

/** Converte falhas do provedor de WhatsApp no erro padrão. */
export function messagingError(err: unknown): AppError {
  if (isMessagingError(err)) {
    const hints: Record<string, string> = {
      AUTH: "Confira EVOLUTION_GO_API_KEY ou reconecte o número.",
      NOT_CONNECTED: "O número está desconectado. Reconecte em WhatsApp no painel.",
      UNAVAILABLE: "A Evolution Go não respondeu. Confira se o servidor dela está no ar.",
      NOT_CONFIGURED: "Configure EVOLUTION_GO_URL e EVOLUTION_GO_API_KEY no .env do servidor.",
    };
    return new AppError(
      err.code === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
      err.message,
      { hint: hints[err.code], details: { provider_code: err.code } },
    );
  }
  if (err instanceof AppError) return err;
  return new AppError("PROVIDER_ERROR", `Falha no WhatsApp: ${String(err)}`);
}

export const refOf = (deps: Pick<Deps, "secrets">, row: AccountRow): InstanceRef => ({
  instanceId: row.instanceId,
  token: deps.secrets.decrypt(row.token),
});

export const providerOf = (deps: Pick<Deps, "messaging">, row: AccountRow) =>
  deps.messaging(row.provider as MessagingProviderName);

const webhookUrlFor = (deps: Pick<Deps, "messagingWebhookUrl">, provider: string) =>
  deps.messagingWebhookUrl ? `${deps.messagingWebhookUrl.replace(/\/$/, "")}/${provider}` : null;

const qrCacheKey = (accountId: string) => `wa:qr:${accountId}`;

async function toAccount(db: DbOrTx, r: AccountRow): Promise<MessagingAccount> {
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(channels)
    .where(eq(channels.messagingAccountId, r.id));
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    phone: r.phone,
    own_jid: r.ownJid,
    status: r.status,
    last_event_at: r.lastEventAt?.toISOString() ?? null,
    last_error: r.lastError,
    connected_at: r.connectedAt?.toISOString() ?? null,
    channel_count: c?.n ?? 0,
    created_at: r.createdAt.toISOString(),
  };
}

export async function getAccountRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(messagingAccounts)
    .where(and(eq(messagingAccounts.id, id), eq(messagingAccounts.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Número de WhatsApp não encontrado.");
  return row;
}

export async function listMessagingAccounts(ctx: Ctx): Promise<MessagingAccount[]> {
  requireScope(ctx.actor, "channels:read");
  const rows = await ctx.db
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(messagingAccounts.createdAt));
  return Promise.all(rows.map((r) => toAccount(ctx.db, r)));
}

/** Cria a instância no provedor e registra o webhook. A conexão do número é feita depois, por QR ou código. */
export async function createMessagingAccount(
  ctx: Ctx,
  raw: CreateMessagingAccountInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Conectar números de WhatsApp");
  const input = CreateMessagingAccountInput.parse(raw);
  return runMutation(ctx, {
    action: "whatsapp.create_account",
    scope: "channels:write",
    input,
    opts,
    preview: async (c, i) => {
      try {
        c.messaging(i.provider);
      } catch (err) {
        throw messagingError(err);
      }
      return { ...i, webhook_url: webhookUrlFor(c, i.provider) };
    },
    execute: async (tx, i, p) => {
      const provider = ctx.messaging(i.provider);
      let ref: InstanceRef;
      try {
        ref = await provider.createInstance(
          `ofertas-${ctx.actor.workspaceId.slice(-6)}-${Date.now().toString(36)}`,
        );
        await provider.connect(ref, { webhookUrl: p.webhook_url });
      } catch (err) {
        throw messagingError(err);
      }
      const [row] = await tx.db
        .insert(messagingAccounts)
        .values({
          workspaceId: ctx.actor.workspaceId,
          provider: i.provider,
          label: i.label,
          instanceId: ref.instanceId,
          token: ctx.secrets.encrypt(ref.token),
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar número");
      return toAccount(tx.db, row);
    },
  });
}

async function updateFromStatus(deps: Deps, row: AccountRow) {
  try {
    const st = await providerOf(deps, row).status(refOf(deps, row));
    const status =
      st.connected && st.loggedIn
        ? "connected"
        : row.status === "connected"
          ? "disconnected"
          : row.status;
    const [updated] = await deps.db
      .update(messagingAccounts)
      .set({
        status,
        ownJid: st.jid ?? row.ownJid,
        lastError: null,
        ...(status === "connected" && row.status !== "connected" ? { connectedAt: now(deps) } : {}),
      })
      .where(eq(messagingAccounts.id, row.id))
      .returning();
    return updated ?? row;
  } catch (err) {
    const e = messagingError(err);
    const [updated] = await deps.db
      .update(messagingAccounts)
      .set({ lastError: e.message })
      .where(eq(messagingAccounts.id, row.id))
      .returning();
    return updated ?? row;
  }
}

/** Estado da conexão; enquanto não conectado, devolve o QR atual para escanear. */
export async function getConnectionState(ctx: Ctx, accountId: string): Promise<ConnectionState> {
  requireHuman(ctx.actor, "Ver o QR de conexão");
  let row = await getAccountRow(ctx.db, ctx.actor.workspaceId, accountId);
  row = await updateFromStatus(ctx, row);
  let qr: string | null = null;
  if (row.status !== "connected") {
    qr = await ctx.cache.get(qrCacheKey(row.id));
    if (!qr) {
      try {
        qr = (await providerOf(ctx, row).getQr(refOf(ctx, row))).image;
      } catch (err) {
        const e = messagingError(err);
        // Provedor pode não ter QR ainda (conexão iniciando): só informa.
        await ctx.db
          .update(messagingAccounts)
          .set({ lastError: e.message })
          .where(eq(messagingAccounts.id, row.id));
      }
    }
    // O simulado conecta ao gerar o QR: reconsulta o status.
    row = await updateFromStatus(ctx, row);
  }
  return {
    account: await toAccount(ctx.db, row),
    qr_image: row.status === "connected" ? null : qr,
  };
}

export async function requestPairingCode(ctx: Ctx, accountId: string, phone: string) {
  requireHuman(ctx.actor, "Gerar código de pareamento");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 13) {
    throw new AppError("VALIDATION_ERROR", "Informe o número com DDI e DDD, ex.: 5511999998888.");
  }
  const row = await getAccountRow(ctx.db, ctx.actor.workspaceId, accountId);
  try {
    const code = await providerOf(ctx, row).pairingCode(refOf(ctx, row), digits);
    await ctx.db
      .update(messagingAccounts)
      .set({ phone: digits })
      .where(eq(messagingAccounts.id, row.id));
    return { code };
  } catch (err) {
    throw messagingError(err);
  }
}

export async function logoutMessagingAccount(
  ctx: Ctx,
  accountId: string,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Desconectar números");
  return runMutation(ctx, {
    action: "whatsapp.logout",
    scope: "channels:write",
    input: { account_id: accountId },
    opts,
    target: (i) => ({ type: "messaging_account", id: i.account_id }),
    preview: async (c, i) =>
      toAccount(c.db, await getAccountRow(c.db, ctx.actor.workspaceId, i.account_id)),
    execute: async (tx, i) => {
      const row = await getAccountRow(tx.db, ctx.actor.workspaceId, i.account_id);
      try {
        await providerOf(ctx, row).logout(refOf(ctx, row));
      } catch (err) {
        if (!(isMessagingError(err) && err.code === "NOT_CONNECTED")) throw messagingError(err);
      }
      const [updated] = await tx.db
        .update(messagingAccounts)
        .set({ status: "logged_out" })
        .where(eq(messagingAccounts.id, row.id))
        .returning();
      return toAccount(tx.db, updated ?? row);
    },
  });
}

/** Importa/atualiza os grupos do número como canais. */
export async function syncGroups(ctx: Ctx, accountId: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "whatsapp.sync_groups",
    scope: "channels:write",
    input: { account_id: accountId },
    opts,
    target: (i) => ({ type: "messaging_account", id: i.account_id }),
    preview: async (c, i) => {
      const row = await getAccountRow(c.db, wsId, i.account_id);
      let groups: Awaited<ReturnType<ReturnType<Deps["messaging"]>["listGroups"]>>;
      try {
        groups = await providerOf(c, row).listGroups(refOf(c, row));
      } catch (err) {
        throw messagingError(err);
      }
      const existing = await c.db
        .select({ externalId: channels.externalId })
        .from(channels)
        .where(eq(channels.workspaceId, wsId));
      const known = new Set(existing.map((e) => e.externalId));
      return {
        groups,
        to_create: groups.filter((g) => !known.has(g.jid)).length,
        to_update: groups.filter((g) => known.has(g.jid)).length,
      };
    },
    execute: async (tx, i, p): Promise<SyncGroupsResult> => {
      const row = await getAccountRow(tx.db, wsId, i.account_id);
      const provider = providerOf(ctx, row);
      const ref = refOf(ctx, row);
      const at = now(ctx);
      let created = 0;
      let inviteErrors = 0;
      const ids: string[] = [];
      for (const g of p.groups) {
        const [before] = await tx.db
          .select()
          .from(channels)
          .where(and(eq(channels.workspaceId, wsId), eq(channels.externalId, g.jid)));
        let inviteUrl = before?.inviteUrl ?? null;
        if (!inviteUrl) {
          try {
            inviteUrl = await provider.inviteLink(ref, g.jid);
          } catch {
            inviteErrors++;
          }
        }
        const values = {
          name: g.name,
          memberCount: g.participantCount,
          adminOnly: g.adminOnly,
          inviteUrl,
          messagingAccountId: row.id,
          lastSyncedAt: at,
        };
        if (before) {
          await tx.db.update(channels).set(values).where(eq(channels.id, before.id));
          ids.push(before.id);
        } else {
          const [ins] = await tx.db
            .insert(channels)
            .values({ ...values, workspaceId: wsId, type: "wa_group", externalId: g.jid })
            .returning({ id: channels.id });
          if (ins) ids.push(ins.id);
          created++;
        }
      }
      const rows = ids.length
        ? await tx.db.select().from(channels).where(inArray(channels.id, ids))
        : [];
      const segs = await segmentIdsFor(tx.db, ids);
      return {
        created,
        updated: p.groups.length - created,
        invite_errors: inviteErrors,
        channels: rows.map((r) => toChannel(r, segs.get(r.id) ?? [])),
      };
    },
  });
}

/** Liga/desliga "só administradores enviam" no grupo. */
export async function setChannelAdminOnly(
  ctx: Ctx,
  channelId: string,
  on: boolean,
  opts: MutationOptions = {},
) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "channels.set_admin_only",
    scope: "channels:write",
    input: { channel_id: channelId, admin_only: on },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const ch = await getChannelRow(c.db, wsId, i.channel_id);
      if (!ch.messagingAccountId || !ch.externalId) {
        throw new AppError("CONFLICT", "Este canal não está ligado a um número de WhatsApp.", {
          hint: "Importe os grupos do número em WhatsApp no painel.",
        });
      }
      return { channel: ch.name, from: ch.adminOnly, to: i.admin_only };
    },
    execute: async (tx, i) => {
      const ch = await getChannelRow(tx.db, wsId, i.channel_id);
      const acc = await getAccountRow(tx.db, wsId, ch.messagingAccountId ?? "");
      try {
        await providerOf(ctx, acc).setAdminOnly(refOf(ctx, acc), ch.externalId ?? "", i.admin_only);
      } catch (err) {
        throw messagingError(err);
      }
      const [row] = await tx.db
        .update(channels)
        .set({ adminOnly: i.admin_only })
        .where(eq(channels.id, ch.id))
        .returning();
      const segs = await segmentIdsFor(tx.db, [ch.id]);
      return toChannel(row ?? ch, segs.get(ch.id) ?? []);
    },
  });
}

// ── Webhooks ────────────────────────────────────────────────────

const PARSERS: Record<string, (body: unknown) => WebhookEnvelope> = {
  evolution_go: parseEvolutionWebhook,
  fake: parseEvolutionWebhook,
};

function sameSecret(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Processa um webhook do provedor. A autenticidade é verificada pelo token da instância,
 * que só a plataforma e o provedor conhecem.
 */
export async function handleMessagingWebhook(deps: Deps, provider: string, body: unknown) {
  const parse = PARSERS[provider];
  if (!parse) return { ok: false as const, reason: "provedor desconhecido" };
  const env = parse(body);
  if (!env.instanceId || !env.instanceToken) return { ok: false as const, reason: "sem instância" };

  const [row] = await deps.db
    .select()
    .from(messagingAccounts)
    .where(
      and(
        eq(messagingAccounts.provider, provider as MessagingProviderName),
        eq(messagingAccounts.instanceId, env.instanceId),
      ),
    );
  if (!row || !sameSecret(deps.secrets.decrypt(row.token), env.instanceToken)) {
    return { ok: false as const, reason: "instância não reconhecida" };
  }

  const at = now(deps);
  const e = env.event;
  await deps.db
    .update(messagingAccounts)
    .set({ lastEventAt: at })
    .where(eq(messagingAccounts.id, row.id));

  switch (e.kind) {
    case "connected":
      await deps.db
        .update(messagingAccounts)
        .set({ status: "connected", ownJid: e.jid ?? row.ownJid, connectedAt: at, lastError: null })
        .where(eq(messagingAccounts.id, row.id));
      await deps.cache.del(qrCacheKey(row.id));
      if (row.status !== "connected") {
        await emitEvent(deps.db, row.workspaceId, "whatsapp.connected", { account_id: row.id });
      }
      break;
    case "logged_out":
      await deps.db
        .update(messagingAccounts)
        .set({ status: "logged_out" })
        .where(eq(messagingAccounts.id, row.id));
      await emitEvent(deps.db, row.workspaceId, "whatsapp.logged_out", { account_id: row.id });
      break;
    case "qr":
      if (e.image) await deps.cache.set(qrCacheKey(row.id), e.image, 60);
      break;
    case "participants": {
      if (!e.joined && !e.left) break;
      const [ch] = await deps.db
        .update(channels)
        .set({ memberCount: sql`greatest(0, ${channels.memberCount} + ${e.joined - e.left})` })
        .where(and(eq(channels.workspaceId, row.workspaceId), eq(channels.externalId, e.groupJid)))
        .returning({ id: channels.id });
      if (ch) {
        const [ws] = await deps.db
          .select({ tz: workspaces.timezone })
          .from(workspaces)
          .where(eq(workspaces.id, row.workspaceId));
        await deps.db
          .insert(channelStatsDaily)
          .values({
            channelId: ch.id,
            date: localDate(at, ws?.tz ?? "America/Sao_Paulo"),
            joins: e.joined,
            leaves: e.left,
          })
          .onConflictDoUpdate({
            target: [channelStatsDaily.channelId, channelStatsDaily.date],
            set: {
              joins: sql`${channelStatsDaily.joins} + ${e.joined}`,
              leaves: sql`${channelStatsDaily.leaves} + ${e.left}`,
            },
          });
      }
      break;
    }
    case "joined_group":
      if (e.participantCount !== null) {
        await deps.db
          .update(channels)
          .set({ memberCount: e.participantCount })
          .where(
            and(eq(channels.workspaceId, row.workspaceId), eq(channels.externalId, e.groupJid)),
          );
      }
      break;
    default:
      break;
  }
  return { ok: true as const, event: e.kind };
}
