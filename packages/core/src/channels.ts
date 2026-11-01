import {
  type Channel,
  ListChannelsQuery,
  type Segment,
  UpdateChannelInput,
  UpsertSegmentInput,
} from "@ofertas/contracts";
import {
  automationRules,
  channelSegments,
  channels,
  type DbOrTx,
  inviteLinks,
  posts,
  segments,
} from "@ofertas/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import type { Ctx } from "./context";
import { AppError } from "./errors";
import { type MutationOptions, runMutation } from "./mutation";

type ChannelRow = typeof channels.$inferSelect;

const toChannel = (r: ChannelRow, segmentIds: string[]): Channel => ({
  id: r.id,
  type: r.type,
  name: r.name,
  invite_url: r.inviteUrl,
  member_count: r.memberCount,
  member_limit: r.memberLimit,
  status: r.status,
  segment_ids: segmentIds,
  external_id: r.externalId,
  messaging_account_id: r.messagingAccountId,
  admin_only: r.adminOnly,
  number_is_admin: r.numberIsAdmin,
  description: r.description,
  locked: r.locked,
  approval_required: r.approvalRequired,
  admins_add_members: r.adminsAddMembers,
  provider_state: r.providerState,
  community_jid: r.communityJid,
  last_synced_at: r.lastSyncedAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
});

export { segmentIdsFor, toChannel };

async function segmentIdsFor(db: DbOrTx, channelIds: string[]) {
  const map = new Map<string, string[]>();
  if (channelIds.length === 0) return map;
  const rows = await db
    .select()
    .from(channelSegments)
    .where(inArray(channelSegments.channelId, channelIds));
  for (const r of rows) map.set(r.channelId, [...(map.get(r.channelId) ?? []), r.segmentId]);
  return map;
}

export async function getChannelRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Canal não encontrado.", { details: { id } });
  return row;
}

/** Canais do workspace. Arquivados (removidos) só aparecem com `include_archived`. */
export async function listChannels(ctx: Ctx, raw: ListChannelsQuery = {}): Promise<Channel[]> {
  requireScope(ctx.actor, "channels:read");
  const q = ListChannelsQuery.parse(raw);
  const rows = await ctx.db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, ctx.actor.workspaceId),
        q.include_archived ? undefined : ne(channels.status, "archived"),
      ),
    )
    .orderBy(asc(channels.createdAt));
  const segs = await segmentIdsFor(
    ctx.db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toChannel(r, segs.get(r.id) ?? []));
}

/** Adiciona segmentos aos canais, mantendo os que eles já têm. */
export async function addSegments(db: DbOrTx, channelIds: string[], segmentIds: string[]) {
  if (!channelIds.length || !segmentIds.length) return;
  await db
    .insert(channelSegments)
    .values(
      channelIds.flatMap((channelId) => segmentIds.map((segmentId) => ({ channelId, segmentId }))),
    )
    .onConflictDoNothing();
}

/** Publicações agendadas (ainda não enviadas) para os canais. */
async function scheduledPostIds(db: DbOrTx, channelIds: string[]) {
  if (!channelIds.length) return [];
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(inArray(posts.channelId, channelIds), eq(posts.status, "scheduled")));
  return rows.map((r) => r.id);
}

export async function assertSegmentsExist(db: DbOrTx, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.workspaceId, workspaceId), inArray(segments.id, ids)));
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) {
    throw new AppError("NOT_FOUND", "Segmento(s) não encontrado(s).", {
      hint: "Use list_segments para ver os ids válidos.",
      details: { missing },
    });
  }
}

/**
 * Edita status, limite e segmentos de um canal. Canais só nascem da importação ou da criação
 * de grupos no WhatsApp (ver groups.ts); não há cadastro manual.
 */
export async function updateChannel(
  ctx: Ctx,
  channelId: string,
  raw: UpdateChannelInput,
  opts: MutationOptions = {},
) {
  const input = UpdateChannelInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "channels.update",
    scope: "channels:write",
    input: { id: channelId, ...input },
    opts,
    target: (i) => ({ type: "channel", id: i.id }),
    preview: async (c, i) => {
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      const before = await getChannelRow(c.db, wsId, i.id);
      const segs = await segmentIdsFor(c.db, [before.id]);
      // Arquivar = remover o grupo da operação: os agendamentos dele são cancelados.
      const archiving = i.status === "archived" && before.status !== "archived";
      return {
        before: toChannel(before, segs.get(before.id) ?? []),
        changes: i,
        scheduled_posts_canceled: archiving
          ? (await scheduledPostIds(c.db, [before.id])).length
          : 0,
      };
    },
    execute: async (tx, i) => {
      const values = {
        ...(i.member_limit !== undefined && { memberLimit: i.member_limit }),
        ...(i.status !== undefined && { status: i.status }),
      };
      const [row] = Object.keys(values).length
        ? await tx.db
            .update(channels)
            .set(values)
            .where(and(eq(channels.id, i.id), eq(channels.workspaceId, wsId)))
            .returning()
        : [await getChannelRow(tx.db, wsId, i.id)];
      if (!row) throw new AppError("NOT_FOUND", "Canal não encontrado.");
      if (i.status === "archived") {
        const ids = await scheduledPostIds(tx.db, [row.id]);
        if (ids.length) {
          await tx.db.update(posts).set({ status: "canceled" }).where(inArray(posts.id, ids));
        }
      }
      if (i.segment_ids) {
        await tx.db.delete(channelSegments).where(eq(channelSegments.channelId, row.id));
        if (i.segment_ids.length) {
          await tx.db
            .insert(channelSegments)
            .values(i.segment_ids.map((segmentId) => ({ channelId: row.id, segmentId })));
        }
      }
      const segs = await segmentIdsFor(tx.db, [row.id]);
      return toChannel(row, segs.get(row.id) ?? []);
    },
  });
}

export async function listSegments(ctx: Ctx): Promise<Segment[]> {
  requireScope(ctx.actor, "channels:read");
  // Conta só grupos em operação: removidos (arquivados) mantêm o segmento para quando
  // forem restaurados, mas não entram na contagem.
  const rows = await ctx.db
    .select({
      segment: segments,
      channelCount: sql<number>`count(${channels.id})::int`,
    })
    .from(segments)
    .leftJoin(channelSegments, eq(channelSegments.segmentId, segments.id))
    .leftJoin(
      channels,
      and(eq(channels.id, channelSegments.channelId), ne(channels.status, "archived")),
    )
    .where(eq(segments.workspaceId, ctx.actor.workspaceId))
    .groupBy(segments.id)
    .orderBy(asc(segments.name));
  return rows.map(({ segment: s, channelCount }) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    channel_count: channelCount,
    created_at: s.createdAt.toISOString(),
  }));
}

export async function upsertSegment(ctx: Ctx, raw: UpsertSegmentInput, opts: MutationOptions = {}) {
  const input = UpsertSegmentInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "segments.update" : "segments.create",
    scope: "channels:write",
    input,
    opts,
    target: (i) => ({ type: "segment", id: i.id }),
    preview: async (c, i) => {
      if (!i.id && !i.name) {
        throw new AppError("VALIDATION_ERROR", "Informe o nome para criar o segmento.");
      }
      if (i.name) {
        const [dup] = await c.db
          .select({ id: segments.id })
          .from(segments)
          .where(and(eq(segments.workspaceId, wsId), eq(segments.name, i.name)));
        if (dup && dup.id !== i.id) {
          throw new AppError("CONFLICT", `Já existe um segmento chamado "${i.name}".`, {
            details: { id: dup.id },
          });
        }
      }
      return i;
    },
    execute: async (tx, i) => {
      const values = {
        ...(i.name !== undefined && { name: i.name }),
        ...(i.description !== undefined && { description: i.description }),
      };
      const [row] = i.id
        ? await tx.db
            .update(segments)
            .set(values)
            .where(and(eq(segments.id, i.id), eq(segments.workspaceId, wsId)))
            .returning()
        : await tx.db
            .insert(segments)
            .values({ name: i.name ?? "", description: i.description ?? null, workspaceId: wsId })
            .returning();
      if (!row) throw new AppError("NOT_FOUND", "Segmento não encontrado.");
      return { id: row.id, name: row.name, description: row.description };
    },
  });
}

/**
 * Apaga um segmento. Recusa se alguma regra automática ou link de convite usa o segmento,
 * para não deixar automações apontando para o nada. Os canais continuam, só perdem a etiqueta.
 */
export async function deleteSegment(ctx: Ctx, segmentId: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "segments.delete",
    scope: "channels:write",
    input: { segment_id: segmentId },
    opts,
    target: (i) => ({ type: "segment", id: i.segment_id }),
    preview: async (c, i) => {
      const [seg] = await c.db
        .select()
        .from(segments)
        .where(and(eq(segments.id, i.segment_id), eq(segments.workspaceId, wsId)));
      if (!seg) throw new AppError("NOT_FOUND", "Segmento não encontrado.");
      const rules = await c.db
        .select({ id: automationRules.id, name: automationRules.name })
        .from(automationRules)
        .where(
          and(
            eq(automationRules.workspaceId, wsId),
            sql`${seg.id}::uuid = any(${automationRules.segmentIds})`,
          ),
        );
      const invites = await c.db
        .select({ id: inviteLinks.id, name: inviteLinks.name })
        .from(inviteLinks)
        .where(eq(inviteLinks.segmentId, seg.id));
      if (rules.length || invites.length) {
        const used = [
          ...rules.map((r) => `regra "${r.name}"`),
          ...invites.map((v) => `convite "${v.name}"`),
        ];
        throw new AppError(
          "CONFLICT",
          `O segmento "${seg.name}" está em uso: ${used.join(", ")}.`,
          {
            hint: "Tire o segmento dessas regras e convites (ou apague-os) antes de apagar o segmento.",
            details: { rule_ids: rules.map((r) => r.id), invite_ids: invites.map((v) => v.id) },
          },
        );
      }
      const [n] = await c.db
        .select({ n: sql<number>`count(*)::int` })
        .from(channelSegments)
        .where(eq(channelSegments.segmentId, seg.id));
      return { id: seg.id, name: seg.name, channel_count: n?.n ?? 0 };
    },
    execute: async (tx, _i, p) => {
      await tx.db
        .delete(segments)
        .where(and(eq(segments.id, p.id), eq(segments.workspaceId, wsId)));
      return { deleted: true as const, id: p.id, name: p.name, channel_count: p.channel_count };
    },
  });
}
