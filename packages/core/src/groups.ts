// Gestão de grupos do WhatsApp: tudo o que a Evolution Go faz com grupos e comunidades.
// Ver docs/specs/12-grupos-e-publicacao.md §Gestão de grupos.
import { type GroupSetting, isMessagingError, samePhone } from "@ofertas/connectors";
import {
  CreateCommunityInput,
  CreateGroupInput,
  type CreateGroupResult,
  type GroupDetails,
  JoinGroupInput,
  type JoinGroupResult,
  LinkCommunityGroupsInput,
  ManageParticipantsInput,
  type ManageParticipantsResult,
  type TeamContact,
  UpdateGroupInput,
  UpdateGroupSettingsInput,
  UpsertTeamContactInput,
} from "@ofertas/contracts";
import { channels, type DbOrTx, posts, teamContacts } from "@ofertas/db";
import { toSquareJpeg } from "@ofertas/render";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireHuman, requireScope } from "./authz";
import {
  addSegments,
  assertSegmentsExist,
  getChannelRow,
  segmentIdsFor,
  toChannel,
} from "./channels";
import { type Ctx, now } from "./context";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { consumeLimit, getLimit } from "./limits";
import { getAccountRow, jidUserOf, messagingError, providerOf, refOf } from "./messaging";
import { type MutationOptions, runMutation } from "./mutation";

type ChannelRow = typeof channels.$inferSelect;

/** Chama o provedor convertendo falhas no erro padrão. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw messagingError(err);
  }
}

/** Grupo + número que o administra. Exige grupo importado de um número. */
async function groupTarget(ctx: Ctx, db: DbOrTx, channelId: string) {
  const ch = await getChannelRow(db, ctx.actor.workspaceId, channelId);
  if (!ch.messagingAccountId || !ch.externalId) {
    throw new AppError("CONFLICT", `"${ch.name}" não está ligado a um número de WhatsApp.`, {
      hint: "Importe o grupo em WhatsApp → Importar grupos.",
    });
  }
  const acc = await getAccountRow(db, ctx.actor.workspaceId, ch.messagingAccountId);
  return { ch, acc, jid: ch.externalId, provider: providerOf(ctx, acc), ref: refOf(ctx, acc) };
}

async function connectedAccount(ctx: Ctx, db: DbOrTx, accountId: string) {
  const acc = await getAccountRow(db, ctx.actor.workspaceId, accountId);
  if (acc.status !== "connected") {
    throw new AppError("CONFLICT", `O número "${acc.label}" não está conectado.`, {
      hint: "Conecte o número em WhatsApp antes.",
    });
  }
  return { acc, provider: providerOf(ctx, acc), ref: refOf(ctx, acc) };
}

async function channelOut(db: DbOrTx, row: ChannelRow) {
  const segs = await segmentIdsFor(db, [row.id]);
  return toChannel(row, segs.get(row.id) ?? []);
}

async function cancelScheduled(db: DbOrTx, channelId: string) {
  const rows = await db
    .update(posts)
    .set({ status: "canceled" })
    .where(and(eq(posts.channelId, channelId), eq(posts.status, "scheduled")))
    .returning({ id: posts.id });
  return rows.length;
}

/**
 * Baixa a foto (fetcher seguro, sem rede interna) e converte em JPEG quadrado como data URL:
 * o WhatsApp recusa foto de grupo em PNG/WebP ("the given data is not a valid image").
 */
async function groupPhoto(ctx: Ctx, url: string) {
  let data: Buffer;
  try {
    ({ data } = await ctx.fetchMedia(url));
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", "Não foi possível baixar a imagem da foto.", {
      hint: "Use uma URL pública (http/https) que abra a imagem direto no navegador.",
      details: { reason: err instanceof Error ? err.message : String(err) },
    });
  }
  try {
    return `data:image/jpeg;base64,${toSquareJpeg(data).toString("base64")}`;
  } catch (err) {
    throw new AppError(
      "VALIDATION_ERROR",
      err instanceof Error ? err.message : "Imagem inválida para foto do grupo.",
    );
  }
}

/** "5511987654321" → "+55 11 •••••-4321"; identificadores que não são telefone ficam ocultos. */
export function maskPhone(user: string) {
  if (!/^\d{12,15}$/.test(user)) return "membro (número oculto)";
  return `+${user.slice(0, 2)} ${user.slice(2, 4)} •••••-${user.slice(-4)}`;
}

// ── Números da equipe ───────────────────────────────────────────

const toTeam = (r: typeof teamContacts.$inferSelect): TeamContact => ({
  id: r.id,
  phone: r.phone,
  label: r.label,
  created_at: r.createdAt.toISOString(),
});

async function teamOf(db: DbOrTx, workspaceId: string) {
  return db
    .select()
    .from(teamContacts)
    .where(eq(teamContacts.workspaceId, workspaceId))
    .orderBy(asc(teamContacts.createdAt));
}

export async function listTeamContacts(ctx: Ctx): Promise<TeamContact[]> {
  requireScope(ctx.actor, "channels:read");
  return (await teamOf(ctx.db, ctx.actor.workspaceId)).map(toTeam);
}

/** Cadastra (ou renomeia) um telefone da equipe. Só eles podem ser adicionados a grupos. */
export async function upsertTeamContact(
  ctx: Ctx,
  raw: UpsertTeamContactInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Cadastrar números da equipe");
  const input = UpsertTeamContactInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "team.upsert",
    scope: "channels:write",
    input,
    opts,
    preview: async (_c, i) => i,
    execute: async (tx, i) => {
      const [row] = await tx.db
        .insert(teamContacts)
        .values({ workspaceId: wsId, phone: i.phone, label: i.label })
        .onConflictDoUpdate({
          target: [teamContacts.workspaceId, teamContacts.phone],
          set: { label: i.label },
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar número da equipe");
      return toTeam(row);
    },
  });
}

export async function deleteTeamContact(ctx: Ctx, id: string, opts: MutationOptions = {}) {
  requireHuman(ctx.actor, "Remover números da equipe");
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "team.delete",
    scope: "channels:write",
    input: { id },
    opts,
    target: (i) => ({ type: "team_contact", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select()
        .from(teamContacts)
        .where(and(eq(teamContacts.id, i.id), eq(teamContacts.workspaceId, wsId)));
      if (!row) throw new AppError("NOT_FOUND", "Número da equipe não encontrado.");
      return toTeam(row);
    },
    execute: async (tx, i) => {
      await tx.db
        .delete(teamContacts)
        .where(and(eq(teamContacts.id, i.id), eq(teamContacts.workspaceId, wsId)));
      return { deleted: true as const, id: i.id };
    },
  });
}

async function assertTeamPhones(db: DbOrTx, workspaceId: string, phones: string[]) {
  const team = new Set((await teamOf(db, workspaceId)).map((t) => t.phone));
  const outside = phones.filter((p) => !team.has(p));
  if (outside.length) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Só números da equipe podem ser adicionados a grupos pela plataforma.",
      {
        hint: "Cadastre o telefone em WhatsApp → Números da equipe. Adicionar clientes sem consentimento é spam e leva a banimento.",
        details: { not_in_team: outside },
      },
    );
  }
}

// ── Detalhes ────────────────────────────────────────────────────

/** Lê o grupo no WhatsApp, atualiza o canal e devolve configurações e admins. */
export async function getGroup(ctx: Ctx, channelId: string): Promise<GroupDetails> {
  requireScope(ctx.actor, "channels:read");
  const t = await groupTarget(ctx, ctx.db, channelId);
  const info = await call(() => t.provider.getGroupInfo(t.ref, t.jid, { ownJid: t.acc.ownJid }));
  const [row] = await ctx.db
    .update(channels)
    .set({
      name: info.name,
      description: info.description,
      memberCount: info.participantCount,
      adminOnly: info.adminOnly,
      locked: info.locked,
      approvalRequired: info.approvalRequired,
      adminsAddMembers: info.adminsAddMembers,
      numberIsAdmin: info.isAdmin,
      communityJid: info.communityJid,
      providerState: "ok",
      lastSyncedAt: now(ctx),
    })
    .where(eq(channels.id, t.ch.id))
    .returning();
  const ch = row ?? t.ch;
  const team = await teamOf(ctx.db, ctx.actor.workspaceId);
  const teamLabel = (u: string) => team.find((m) => samePhone(m.phone, u))?.label ?? null;
  const me = jidUserOf(t.acc.ownJid);
  const inList = (list: string[], phone: string) => list.some((u) => samePhone(u, phone));
  const ws = ctx.actor.workspaceId;
  const [community] = info.communityJid
    ? await ctx.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(and(eq(channels.workspaceId, ws), eq(channels.externalId, info.communityJid)))
    : [];
  const linked =
    ch.type === "wa_community"
      ? await ctx.db
          .select({ id: channels.id, name: channels.name })
          .from(channels)
          .where(and(eq(channels.workspaceId, ws), eq(channels.communityJid, t.jid)))
      : [];
  return {
    channel: await channelOut(ctx.db, ch),
    admins: info.admins.map((u) => {
      const label = teamLabel(u);
      const self = samePhone(u, me);
      return {
        phone:
          self || label ? `+${team.find((m) => samePhone(m.phone, u))?.phone ?? u}` : maskPhone(u),
        is_self: self,
        team_label: label,
      };
    }),
    team_in_group: team
      .filter((m) => inList(info.participants, m.phone))
      .map((m) => ({ phone: m.phone, label: m.label, is_admin: inList(info.admins, m.phone) })),
    community: info.communityJid
      ? { id: community?.id ?? null, name: community?.name ?? null }
      : null,
    linked_groups: linked,
  };
}

// ── Editar ──────────────────────────────────────────────────────

export async function updateGroup(
  ctx: Ctx,
  channelId: string,
  raw: UpdateGroupInput,
  opts: MutationOptions = {},
) {
  const input = UpdateGroupInput.parse(raw);
  return runMutation(ctx, {
    action: "groups.update",
    scope: "channels:write",
    input: { channel_id: channelId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.channel_id);
      if (i.name === undefined && i.description === undefined && i.photo_url === undefined) {
        throw new AppError("VALIDATION_ERROR", "Informe nome, descrição ou foto.");
      }
      return {
        group: t.ch.name,
        from: { name: t.ch.name, description: t.ch.description },
        to: { name: i.name, description: i.description, photo_url: i.photo_url },
      };
    },
    execute: async (tx, i) => {
      const t = await groupTarget(ctx, tx.db, i.channel_id);
      // Converte a foto antes de mexer no grupo: imagem ruim não deixa a edição pela metade.
      const photo = i.photo_url ? await groupPhoto(ctx, i.photo_url) : null;
      if (i.name !== undefined)
        await call(() => t.provider.setGroupName(t.ref, t.jid, i.name ?? ""));
      if (i.description !== undefined) {
        await call(() => t.provider.setGroupDescription(t.ref, t.jid, i.description ?? ""));
      }
      if (photo) await call(() => t.provider.setGroupPhoto(t.ref, t.jid, photo));
      // Só a foto não muda nada no canal (a foto não é guardada aqui).
      const [row] = await tx.db
        .update(channels)
        .set({
          ...(i.name !== undefined && { name: i.name }),
          ...(i.description !== undefined && { description: i.description || null }),
          lastSyncedAt: now(ctx),
        })
        .where(eq(channels.id, t.ch.id))
        .returning();
      return channelOut(tx.db, row ?? t.ch);
    },
  });
}

const SETTING_MAP = {
  admin_only: ["announcement", "not_announcement", "adminOnly"],
  locked: ["locked", "unlocked", "locked"],
  approval_required: ["approval_on", "approval_off", "approvalRequired"],
  admins_add_members: ["admin_add", "all_member_add", "adminsAddMembers"],
} as const satisfies Record<
  keyof UpdateGroupSettingsInput,
  readonly [GroupSetting, GroupSetting, keyof ChannelRow]
>;

/** Liga/desliga as 4 configurações do grupo. */
export async function updateGroupSettings(
  ctx: Ctx,
  channelId: string,
  raw: UpdateGroupSettingsInput,
  opts: MutationOptions = {},
) {
  const input = UpdateGroupSettingsInput.parse(raw);
  return runMutation(ctx, {
    action: "groups.update_settings",
    scope: "channels:write",
    input: { channel_id: channelId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.channel_id);
      const changes = (Object.keys(SETTING_MAP) as (keyof typeof SETTING_MAP)[])
        .filter((k) => i[k] !== undefined)
        .map((k) => ({ setting: k, to: i[k] as boolean }));
      if (!changes.length)
        throw new AppError("VALIDATION_ERROR", "Informe ao menos uma configuração.");
      if (t.ch.numberIsAdmin === false) {
        throw new AppError("CONFLICT", `O número não é admin de "${t.ch.name}".`, {
          hint: "Só admins mudam as configurações do grupo.",
        });
      }
      return { group: t.ch.name, changes };
    },
    execute: async (tx, i, p) => {
      const t = await groupTarget(ctx, tx.db, i.channel_id);
      const set: Partial<ChannelRow> = {};
      for (const { setting, to } of p.changes) {
        const [on, off, column] = SETTING_MAP[setting];
        await call(() => t.provider.setGroupSetting(t.ref, t.jid, to ? on : off));
        (set as Record<string, boolean>)[column] = to;
      }
      const [row] = await tx.db
        .update(channels)
        .set(set)
        .where(eq(channels.id, t.ch.id))
        .returning();
      return channelOut(tx.db, row ?? t.ch);
    },
  });
}

/** Revoga o link de convite atual e gera outro. */
export async function resetGroupInvite(ctx: Ctx, channelId: string, opts: MutationOptions = {}) {
  requireHuman(ctx.actor, "Gerar novo link de convite");
  return runMutation(ctx, {
    action: "groups.reset_invite",
    scope: "channels:write",
    input: { channel_id: channelId },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.channel_id);
      return { group: t.ch.name, revokes: t.ch.inviteUrl };
    },
    execute: async (tx, i) => {
      const t = await groupTarget(ctx, tx.db, i.channel_id);
      const url = await call(() => t.provider.inviteLink(t.ref, t.jid, { reset: true }));
      const [row] = await tx.db
        .update(channels)
        .set({ inviteUrl: url })
        .where(eq(channels.id, t.ch.id))
        .returning();
      return channelOut(tx.db, row ?? t.ch);
    },
  });
}

// ── Participantes ───────────────────────────────────────────────

/**
 * Adiciona (só equipe), remove, promove ou rebaixa participantes. A Evolution Go não diz
 * quem falhou, então o resultado vem de reler o grupo.
 */
export async function manageGroupParticipants(
  ctx: Ctx,
  channelId: string,
  raw: ManageParticipantsInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Gerenciar participantes de grupos");
  const input = ManageParticipantsInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: `groups.participants.${input.action}`,
    scope: "channels:write",
    input: { channel_id: channelId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.channel_id);
      if (i.action === "add") await assertTeamPhones(c.db, wsId, i.phones);
      if (t.ch.numberIsAdmin === false) {
        throw new AppError("CONFLICT", `O número não é admin de "${t.ch.name}".`, {
          hint: "Só admins gerenciam participantes.",
        });
      }
      return { group: t.ch.name, action: i.action, phones: i.phones.map(maskPhone) };
    },
    execute: async (tx, i): Promise<ManageParticipantsResult> => {
      const t = await groupTarget(ctx, tx.db, i.channel_id);
      if (i.action === "add") {
        const max = await getLimit(ctx, wsId, "groups.add_per_day");
        for (const _ of i.phones) {
          await consumeLimit(ctx, {
            key: "groups.add_per_day",
            bucket: t.acc.id,
            max,
            windowSec: 86_400,
          });
        }
      }
      await call(() => t.provider.updateParticipants(t.ref, t.jid, i.phones, i.action));
      const info = await call(() =>
        t.provider.getGroupInfo(t.ref, t.jid, { ownJid: t.acc.ownJid }),
      );
      const has = (list: string[], p: string) => list.some((u) => samePhone(u, p));
      const ok = (p: string) =>
        i.action === "add"
          ? has(info.participants, p)
          : i.action === "remove"
            ? !has(info.participants, p)
            : i.action === "promote"
              ? has(info.admins, p)
              : !has(info.admins, p);
      await tx.db
        .update(channels)
        .set({ memberCount: info.participantCount, numberIsAdmin: info.isAdmin })
        .where(eq(channels.id, t.ch.id));
      return {
        action: i.action,
        done: i.phones.filter(ok),
        failed: i.phones.filter((p) => !ok(p)),
      };
    },
  });
}

// ── Criar, entrar, sair ─────────────────────────────────────────

/**
 * Cria o grupo. Se o provedor estourar o tempo, o grupo pode ter sido criado mesmo assim:
 * procura um grupo novo com o mesmo nome antes de desistir (tentar de novo criaria outro).
 */
async function createOrRecover(
  provider: ReturnType<typeof providerOf>,
  ref: ReturnType<typeof refOf>,
  ownJid: string | null,
  name: string,
  participants: string[],
) {
  const before = new Set(
    (await call(() => provider.listGroups(ref, { ownJid }))).map((g) => g.jid),
  );
  try {
    return await provider.createGroup(ref, name, participants);
  } catch (err) {
    if (!(isMessagingError(err) && err.code === "TIMEOUT")) throw messagingError(err);
    for (const wait of [0, 3000, 6000]) {
      if (wait) await new Promise((ok) => setTimeout(ok, wait));
      const fresh = (await call(() => provider.listGroups(ref, { ownJid }))).filter(
        (g) => !before.has(g.jid) && g.name === name,
      );
      if (fresh[0]) return { jid: fresh[0].jid, failed: [] };
    }
    throw new AppError(
      "PROVIDER_ERROR",
      "O WhatsApp demorou para criar o grupo e ele ainda não apareceu.",
      {
        hint: "Confira no celular antes de tentar de novo. Se o grupo existir, traga-o em WhatsApp → Importar grupos.",
        details: { provider_code: "TIMEOUT" },
      },
    );
  }
}

/**
 * Cria o grupo no WhatsApp e já aplica descrição, foto, configurações e link de convite.
 * Falha num passo depois de criado não desfaz o grupo: volta em `pending`.
 */
export async function createGroup(ctx: Ctx, raw: CreateGroupInput, opts: MutationOptions = {}) {
  requireHuman(ctx.actor, "Criar grupos");
  const input = CreateGroupInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "groups.create",
    scope: "channels:write",
    input,
    opts,
    preview: async (c, i) => {
      const { acc } = await connectedAccount(ctx, c.db, i.account_id);
      await assertTeamPhones(c.db, wsId, i.participants);
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      return { ...i, account: acc.label };
    },
    execute: async (tx, i): Promise<CreateGroupResult> => {
      const { acc, provider, ref } = await connectedAccount(ctx, tx.db, i.account_id);
      // Foto convertida antes de criar: imagem ruim falha sem deixar grupo criado pela metade.
      const photo = i.photo_url ? await groupPhoto(ctx, i.photo_url) : null;
      const created = await createOrRecover(provider, ref, acc.ownJid, i.name, i.participants);
      const jid = created.jid;
      const pending: CreateGroupResult["pending"] = [];
      const step = async (name: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          return true;
        } catch (err) {
          pending.push({ step: name, error: messagingError(err).message });
          return false;
        }
      };
      if (i.description)
        await step("descrição", () => provider.setGroupDescription(ref, jid, i.description ?? ""));
      if (photo) await step("foto", () => provider.setGroupPhoto(ref, jid, photo));
      const adminOnly = await step("só admins enviam", () =>
        provider.setGroupSetting(ref, jid, i.admin_only ? "announcement" : "not_announcement"),
      );
      const locked = await step("só admins editam", () =>
        provider.setGroupSetting(ref, jid, i.locked ? "locked" : "unlocked"),
      );
      const adminAdd = await step("só admins adicionam", () =>
        provider.setGroupSetting(ref, jid, "admin_add"),
      );
      let inviteUrl: string | null = null;
      await step("link de convite", async () => {
        inviteUrl = await provider.inviteLink(ref, jid);
      });
      const [row] = await tx.db
        .insert(channels)
        .values({
          workspaceId: wsId,
          type: "wa_group",
          name: i.name,
          externalId: jid,
          messagingAccountId: acc.id,
          inviteUrl,
          description: i.description ?? null,
          memberCount: 1 + i.participants.length - created.failed.length,
          ...(i.member_limit && { memberLimit: i.member_limit }),
          adminOnly: adminOnly ? i.admin_only : null,
          locked: locked ? i.locked : null,
          adminsAddMembers: adminAdd ? true : null,
          approvalRequired: false,
          numberIsAdmin: true,
          lastSyncedAt: now(ctx),
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar o grupo");
      if (i.segment_ids) await addSegments(tx.db, [row.id], i.segment_ids);
      await emitEvent(tx.db, wsId, "group.created", { channel_id: row.id });
      return {
        channel: await channelOut(tx.db, row),
        pending,
        failed_participants: created.failed,
      };
    },
  });
}

/** Coloca o número num grupo existente pelo link de convite e importa o grupo. */
export async function joinGroup(
  ctx: Ctx,
  accountId: string,
  raw: JoinGroupInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Entrar em grupos");
  const input = JoinGroupInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "groups.join",
    scope: "channels:write",
    input: { account_id: accountId, ...input },
    opts,
    target: (i) => ({ type: "messaging_account", id: i.account_id }),
    preview: async (c, i) => {
      const { acc } = await connectedAccount(ctx, c.db, i.account_id);
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      return { account: acc.label, invite_url: i.invite_url };
    },
    execute: async (tx, i): Promise<JoinGroupResult> => {
      const { acc, provider, ref } = await connectedAccount(ctx, tx.db, i.account_id);
      const own = { ownJid: acc.ownJid };
      const before = new Set((await call(() => provider.listGroups(ref, own))).map((g) => g.jid));
      await call(() => provider.joinGroup(ref, i.invite_url));
      const fresh = (await call(() => provider.listGroups(ref, own))).filter(
        (g) => !before.has(g.jid),
      );
      // A Evolution Go não devolve o grupo: sem grupo novo, a entrada espera aprovação
      // (ou o número já estava nele).
      if (!fresh.length) return { status: "pending", channels: [] };
      const ids: string[] = [];
      for (const g of fresh) {
        let invite: string | null = null;
        try {
          invite = await provider.inviteLink(ref, g.jid);
        } catch {
          // Sem admin não há link: segue sem.
        }
        const values = {
          name: g.name,
          memberCount: g.participantCount,
          adminOnly: g.adminOnly,
          numberIsAdmin: g.isAdmin,
          inviteUrl: invite,
          messagingAccountId: acc.id,
          lastSyncedAt: now(ctx),
          status: "active" as const,
          providerState: "ok" as const,
        };
        const [row] = await tx.db
          .insert(channels)
          .values({ ...values, workspaceId: wsId, type: "wa_group", externalId: g.jid })
          .onConflictDoUpdate({ target: [channels.workspaceId, channels.externalId], set: values })
          .returning({ id: channels.id });
        if (row) ids.push(row.id);
      }
      if (i.segment_ids) await addSegments(tx.db, ids, i.segment_ids);
      const rows = await tx.db.select().from(channels).where(inArray(channels.id, ids));
      const segs = await segmentIdsFor(tx.db, ids);
      await emitEvent(tx.db, wsId, "group.joined", { channel_ids: ids });
      return { status: "joined", channels: rows.map((r) => toChannel(r, segs.get(r.id) ?? [])) };
    },
  });
}

/** Tira o número do grupo. Irreversível sem novo convite: arquiva o canal. */
export async function leaveGroup(ctx: Ctx, channelId: string, opts: MutationOptions = {}) {
  requireHuman(ctx.actor, "Sair de grupos");
  return runMutation(ctx, {
    action: "groups.leave",
    scope: "channels:write",
    input: { channel_id: channelId },
    opts,
    target: (i) => ({ type: "channel", id: i.channel_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.channel_id);
      let onlyAdmin = false;
      try {
        const info = await t.provider.getGroupInfo(t.ref, t.jid, { ownJid: t.acc.ownJid });
        onlyAdmin = info.isAdmin === true && info.admins.length === 1;
      } catch {
        // Sem leitura do grupo: só não avisa.
      }
      const scheduled = await c.db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.channelId, t.ch.id), eq(posts.status, "scheduled")));
      return {
        group: t.ch.name,
        only_admin: onlyAdmin,
        scheduled_posts_canceled: scheduled.length,
      };
    },
    execute: async (tx, i) => {
      const t = await groupTarget(ctx, tx.db, i.channel_id);
      await call(() => t.provider.leaveGroup(t.ref, t.jid));
      const canceled = await cancelScheduled(tx.db, t.ch.id);
      const [row] = await tx.db
        .update(channels)
        .set({ status: "archived", numberIsAdmin: null })
        .where(eq(channels.id, t.ch.id))
        .returning();
      await emitEvent(tx.db, ctx.actor.workspaceId, "group.left", { channel_id: t.ch.id });
      return { channel: await channelOut(tx.db, row ?? t.ch), scheduled_posts_canceled: canceled };
    },
  });
}

// ── Comunidades ─────────────────────────────────────────────────

export async function createCommunity(
  ctx: Ctx,
  raw: CreateCommunityInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Criar comunidades");
  const input = CreateCommunityInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "groups.create_community",
    scope: "channels:write",
    input,
    opts,
    preview: async (c, i) => {
      const { acc } = await connectedAccount(ctx, c.db, i.account_id);
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      return { ...i, account: acc.label };
    },
    execute: async (tx, i) => {
      const { acc, provider, ref } = await connectedAccount(ctx, tx.db, i.account_id);
      const { jid } = await call(() => provider.createCommunity(ref, i.name));
      if (i.description) {
        try {
          await provider.setGroupDescription(ref, jid, i.description);
        } catch {
          // Descrição é opcional; dá para editar depois.
        }
      }
      const [row] = await tx.db
        .insert(channels)
        .values({
          workspaceId: wsId,
          type: "wa_community",
          name: i.name,
          externalId: jid,
          messagingAccountId: acc.id,
          description: i.description ?? null,
          memberCount: 1,
          numberIsAdmin: true,
          lastSyncedAt: now(ctx),
        })
        .returning();
      if (!row) throw new Error("Falha ao salvar a comunidade");
      if (i.segment_ids) await addSegments(tx.db, [row.id], i.segment_ids);
      return channelOut(tx.db, row);
    },
  });
}

/**
 * Liga ou desliga grupos de uma comunidade. A resposta da Evolution Go não é confiável,
 * então cada grupo é relido para confirmar.
 */
export async function linkCommunityGroups(
  ctx: Ctx,
  communityId: string,
  raw: LinkCommunityGroupsInput,
  opts: MutationOptions = {},
) {
  requireHuman(ctx.actor, "Organizar comunidades");
  const input = LinkCommunityGroupsInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.link ? "groups.community_link" : "groups.community_unlink",
    scope: "channels:write",
    input: { community_id: communityId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.community_id }),
    preview: async (c, i) => {
      const t = await groupTarget(ctx, c.db, i.community_id);
      if (t.ch.type !== "wa_community") {
        throw new AppError("VALIDATION_ERROR", `"${t.ch.name}" não é uma comunidade.`);
      }
      const groups = await c.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, wsId), inArray(channels.id, i.channel_ids)));
      const wrong = groups.filter(
        (g) => !g.externalId || g.messagingAccountId !== t.acc.id || g.type !== "wa_group",
      );
      if (groups.length !== i.channel_ids.length || wrong.length) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Só grupos do mesmo número da comunidade podem ser ligados a ela.",
          { details: { invalid: wrong.map((g) => g.name) } },
        );
      }
      return { community: t.ch.name, link: i.link, groups: groups.map((g) => g.name) };
    },
    execute: async (tx, i) => {
      const t = await groupTarget(ctx, tx.db, i.community_id);
      const groups = await tx.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, wsId), inArray(channels.id, i.channel_ids)));
      const jids = groups.map((g) => g.externalId ?? "");
      await call(() => t.provider.linkCommunityGroups(t.ref, t.jid, jids, i.link));
      const done: string[] = [];
      const failed: string[] = [];
      for (const g of groups) {
        let parent: string | null = null;
        try {
          parent = (await t.provider.getGroupInfo(t.ref, g.externalId ?? "")).communityJid;
        } catch {
          failed.push(g.name);
          continue;
        }
        const ok = i.link ? parent === t.jid : parent !== t.jid;
        (ok ? done : failed).push(g.name);
        await tx.db.update(channels).set({ communityJid: parent }).where(eq(channels.id, g.id));
      }
      return { done, failed };
    },
  });
}
