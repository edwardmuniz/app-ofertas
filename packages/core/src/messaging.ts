import { timingSafeEqual } from "node:crypto";
import {
  type GroupSummary,
  type InstanceRef,
  isMessagingError,
  type MessagingProviderName,
  parseEvolutionWebhook,
  samePhone,
  type WebhookEnvelope,
} from "@ofertas/connectors";
import {
  type AvailableGroup,
  type ConnectionState,
  CreateMessagingAccountInput,
  type MessagingAccount,
  SyncGroupsInput,
  type SyncGroupsPreview,
  type SyncGroupsResult,
} from "@ofertas/contracts";
import {
  channelStatsDaily,
  channels,
  type DbOrTx,
  messagingAccounts,
  posts,
  workspaces,
} from "@ofertas/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import {
  addSegments,
  assertSegmentsExist,
  getChannelRow,
  segmentIdsFor,
  toChannel,
} from "./channels";
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
      TIMEOUT: "A Evolution Go demorou a responder; a ação pode ter sido feita mesmo assim.",
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

/** Parte do usuário de um JID ("5511...:5@s.whatsapp.net" → "5511..."). */
export const jidUserOf = (jid: string | null | undefined) =>
  jid ? ((jid.split("@")[0] ?? "").split(":")[0] ?? "") : "";

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
    // LoggedIn já implica sessão ativa; o "Connected" (socket) oscila logo após o pareamento.
    const status = st.loggedIn
      ? "connected"
      : row.status === "connected"
        ? "disconnected"
        : row.status;
    // Só grava se ninguém mudou o status enquanto consultávamos (ex.: o webhook de conexão
    // chegou no meio): sem isso uma consulta antiga voltava "conectado" para "aguardando".
    const [updated] = await deps.db
      .update(messagingAccounts)
      .set({
        status,
        ownJid: st.jid ?? row.ownJid,
        lastError: null,
        ...(status === "connected" && row.status !== "connected" ? { connectedAt: now(deps) } : {}),
      })
      .where(and(eq(messagingAccounts.id, row.id), eq(messagingAccounts.status, row.status)))
      .returning();
    return updated ?? (await getAccountRow(deps.db, row.workspaceId, row.id));
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
    // O QR chega pelo webhook (cache). Pedir à Evolution Go segura a requisição por 2–5 s
    // (e, sem cliente ativo, reinicia a instância), então pedimos no máximo a cada 15 s.
    qr = await ctx.cache.get(qrCacheKey(row.id));
    const askedKey = `wa:qr-asked:${row.id}`;
    if (!qr && !(await ctx.cache.get(askedKey))) {
      await ctx.cache.set(askedKey, "1", 15);
      try {
        qr = (await providerOf(ctx, row).getQr(refOf(ctx, row))).image;
        if (qr) await ctx.cache.set(qrCacheKey(row.id), qr, 20);
      } catch (err) {
        const e = messagingError(err);
        // Provedor pode não ter QR ainda (conexão iniciando) ou já ter logado: só informa.
        await ctx.db
          .update(messagingAccounts)
          .set({ lastError: e.message })
          .where(eq(messagingAccounts.id, row.id));
      }
      // O simulado conecta ao gerar o QR, e o real pode ter logado durante a espera.
      row = await updateFromStatus(ctx, row);
    }
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

/**
 * Remove o número da plataforma: desloga, apaga a instância no provedor e o registro.
 * Os grupos importados continuam como canais (sem número ligado) e as publicações
 * agendadas para eles são canceladas, já que não teriam por onde sair.
 */
export async function removeMessagingAccount(
  ctx: Ctx,
  accountId: string,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Remover números de WhatsApp");
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "whatsapp.remove_account",
    scope: "channels:write",
    input: { account_id: accountId },
    opts,
    target: (i) => ({ type: "messaging_account", id: i.account_id }),
    preview: async (c, i) => {
      const row = await getAccountRow(c.db, wsId, i.account_id);
      const chans = await c.db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.messagingAccountId, row.id));
      const [pending] = chans.length
        ? await c.db
            .select({ n: sql<number>`count(*)::int` })
            .from(posts)
            .where(
              and(
                inArray(
                  posts.channelId,
                  chans.map((ch) => ch.id),
                ),
                eq(posts.status, "scheduled"),
              ),
            )
        : [{ n: 0 }];
      return {
        account: await toAccount(c.db, row),
        channels_kept: chans.length,
        scheduled_posts_canceled: pending?.n ?? 0,
      };
    },
    execute: async (tx, i) => {
      const row = await getAccountRow(tx.db, wsId, i.account_id);
      const provider = providerOf(ctx, row);
      try {
        await provider.logout(refOf(ctx, row));
      } catch {
        // Já deslogado ou instância inexistente: seguimos para apagar.
      }
      try {
        await provider.deleteInstance(row.instanceId);
      } catch (err) {
        // Instância que já não existe no provedor não impede a remoção; fora do ar, sim.
        if (!(isMessagingError(err) && err.code === "INVALID")) throw messagingError(err);
      }
      const chans = await tx.db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.messagingAccountId, row.id));
      let canceled = 0;
      if (chans.length) {
        const rows = await tx.db
          .update(posts)
          .set({ status: "canceled" })
          .where(
            and(
              inArray(
                posts.channelId,
                chans.map((ch) => ch.id),
              ),
              eq(posts.status, "scheduled"),
            ),
          )
          .returning({ id: posts.id });
        canceled = rows.length;
      }
      await tx.db.delete(messagingAccounts).where(eq(messagingAccounts.id, row.id));
      await ctx.cache.del(qrCacheKey(row.id));
      return {
        removed: true as const,
        channels_kept: chans.length,
        scheduled_posts_canceled: canceled,
      };
    },
  });
}

/**
 * Importa os grupos escolhidos do número como canais.
 * - dry_run devolve todos os grupos do número (com o que já está na plataforma) para escolher;
 * - com `group_jids`, importa/atualiza só esses (um arquivado escolhido volta a ficar ativo);
 * - sem `group_jids`, só atualiza os já importados (nome, membros, admin), sem criar nada.
 */
export async function syncGroups(
  ctx: Ctx,
  accountId: string,
  raw: SyncGroupsInput = {},
  opts: MutationOptions = {},
) {
  const wsId = ctx.actor.workspaceId;
  const input = SyncGroupsInput.parse(raw);
  return runMutation(ctx, {
    action: "whatsapp.sync_groups",
    scope: "channels:write",
    input: { account_id: accountId, ...input },
    opts,
    target: (i) => ({ type: "messaging_account", id: i.account_id }),
    preview: async (c, i) => {
      const row = await getAccountRow(c.db, wsId, i.account_id);
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      let groups: GroupSummary[];
      try {
        groups = await providerOf(c, row).listGroups(refOf(c, row), { ownJid: row.ownJid });
      } catch (err) {
        throw messagingError(err);
      }
      const existing = await c.db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, wsId),
            inArray(channels.externalId, groups.length ? groups.map((g) => g.jid) : [""]),
          ),
        );
      const byJid = new Map(existing.map((ch) => [ch.externalId, ch]));
      const available: AvailableGroup[] = groups.map((g) => ({
        jid: g.jid,
        name: g.name,
        participant_count: g.participantCount,
        admin_only: g.adminOnly,
        number_is_admin: g.isAdmin,
        channel_id: byJid.get(g.jid)?.id ?? null,
        channel_status: byJid.get(g.jid)?.status ?? null,
      }));
      const jids = new Set(groups.map((g) => g.jid));
      const linked = await c.db
        .select({ id: channels.id, name: channels.name, externalId: channels.externalId })
        .from(channels)
        .where(and(eq(channels.messagingAccountId, row.id), ne(channels.status, "archived")));
      const left = linked
        .filter((ch) => ch.externalId && !jids.has(ch.externalId))
        .map((ch) => ({ channel_id: ch.id, name: ch.name }));

      let selected: string[];
      if (i.group_jids) {
        const unknown = i.group_jids.filter((j) => !jids.has(j));
        if (unknown.length) {
          throw new AppError("VALIDATION_ERROR", "Há grupos que o número não participa.", {
            hint: "Use os JIDs devolvidos pelo dry_run da importação.",
            details: { unknown },
          });
        }
        selected = [...new Set(i.group_jids)];
      } else {
        selected = available
          .filter((g) => g.channel_status && g.channel_status !== "archived")
          .map((g) => g.jid);
      }
      const chosen = new Set(selected);
      return {
        groups: available,
        left,
        selected,
        to_create: available.filter((g) => chosen.has(g.jid) && !g.channel_id).length,
        to_update: available.filter((g) => chosen.has(g.jid) && g.channel_id).length,
      } satisfies SyncGroupsPreview;
    },
    execute: async (tx, i, p): Promise<SyncGroupsResult> => {
      const row = await getAccountRow(tx.db, wsId, i.account_id);
      const provider = providerOf(ctx, row);
      const ref = refOf(ctx, row);
      const at = now(ctx);
      const chosen = new Set(p.selected);
      const targets = p.groups.filter((g) => chosen.has(g.jid));
      const existing = targets.length
        ? await tx.db
            .select()
            .from(channels)
            .where(
              and(
                eq(channels.workspaceId, wsId),
                inArray(
                  channels.externalId,
                  targets.map((g) => g.jid),
                ),
              ),
            )
        : [];
      const byJid = new Map(existing.map((ch) => [ch.externalId, ch]));
      // Links de convite: uma chamada por grupo, até 5 ao mesmo tempo. Falha (ex.: o número
      // não é admin do grupo) não impede a importação.
      const invites = new Map<string, string>();
      const noInvite: string[] = [];
      const missing = targets.filter((g) => !byJid.get(g.jid)?.inviteUrl);
      for (let k = 0; k < missing.length; k += 5) {
        await Promise.all(
          missing.slice(k, k + 5).map(async (g) => {
            try {
              invites.set(g.jid, await provider.inviteLink(ref, g.jid));
            } catch {
              noInvite.push(g.name);
            }
          }),
        );
      }
      let created = 0;
      const ids: string[] = [];
      for (const g of targets) {
        const before = byJid.get(g.jid);
        const values = {
          name: g.name,
          memberCount: g.participant_count,
          adminOnly: g.admin_only,
          numberIsAdmin: g.number_is_admin,
          inviteUrl: before?.inviteUrl ?? invites.get(g.jid) ?? null,
          messagingAccountId: row.id,
          lastSyncedAt: at,
        };
        if (before) {
          // Escolher de novo um grupo removido o traz de volta.
          await tx.db
            .update(channels)
            .set({
              ...values,
              ...(before.status === "archived" ? { status: "active" as const } : {}),
            })
            .where(eq(channels.id, before.id));
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
      if (i.segment_ids) await addSegments(tx.db, ids, i.segment_ids);
      const rows = ids.length
        ? await tx.db.select().from(channels).where(inArray(channels.id, ids))
        : [];
      const segs = await segmentIdsFor(tx.db, ids);
      return {
        created,
        updated: targets.length - created,
        invite_errors: noInvite.length,
        no_invite: noInvite,
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
    case "group_update": {
      const [ch] = await deps.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, row.workspaceId), eq(channels.externalId, e.groupJid)));
      if (!ch) break;
      // Mudanças feitas pelo celular (ou por outro admin) refletem no canal.
      const me = jidUserOf(row.ownJid);
      const set: Partial<typeof channels.$inferInsert> = {};
      if (e.joined || e.left) {
        set.memberCount = sql`greatest(0, ${channels.memberCount} + ${e.joined - e.left})` as never;
      }
      if (e.name !== undefined) set.name = e.name;
      if (e.description !== undefined) set.description = e.description || null;
      if (e.adminOnly !== undefined) set.adminOnly = e.adminOnly;
      if (e.locked !== undefined) set.locked = e.locked;
      if (e.approvalRequired !== undefined) set.approvalRequired = e.approvalRequired;
      if (e.inviteLink) set.inviteUrl = e.inviteLink;
      if (me && e.promoted.some((u) => samePhone(u, me))) set.numberIsAdmin = true;
      if (me && e.demoted.some((u) => samePhone(u, me))) set.numberIsAdmin = false;
      if (e.deleted) {
        set.providerState = "deleted";
        set.status = ch.status === "archived" ? "archived" : "paused";
      } else if (e.suspended === true) {
        set.providerState = "suspended";
        set.status = ch.status === "archived" ? "archived" : "paused";
      } else if (e.suspended === false) {
        set.providerState = "ok";
      }
      if (Object.keys(set).length) {
        await deps.db.update(channels).set(set).where(eq(channels.id, ch.id));
      }
      if (e.joined || e.left) {
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
      if (set.numberIsAdmin === false) {
        await emitEvent(deps.db, row.workspaceId, "group.admin_lost", { channel_id: ch.id });
      }
      if (set.providerState && set.providerState !== "ok") {
        await emitEvent(deps.db, row.workspaceId, "group.unavailable", {
          channel_id: ch.id,
          state: set.providerState,
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

/**
 * Consulta o provedor e atualiza o status dos números já conectados alguma vez. Não depende
 * só do webhook: se ele falhar, o alerta de número caído ainda aparece.
 */
export async function refreshMessagingStatuses(deps: Deps) {
  const rows = await deps.db
    .select()
    .from(messagingAccounts)
    .where(inArray(messagingAccounts.status, ["connected", "disconnected"]));
  let changed = 0;
  for (const row of rows) {
    const updated = await updateFromStatus(deps, row);
    if (updated.status !== row.status) changed++;
  }
  return { checked: rows.length, changed };
}
