import {
  type Channel,
  type Segment,
  UpsertChannelInput,
  UpsertSegmentInput,
} from "@ofertas/contracts";
import { channelSegments, channels, type DbOrTx, segments } from "@ofertas/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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

export async function listChannels(ctx: Ctx): Promise<Channel[]> {
  requireScope(ctx.actor, "channels:read");
  const rows = await ctx.db
    .select()
    .from(channels)
    .where(eq(channels.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(channels.createdAt));
  const segs = await segmentIdsFor(
    ctx.db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toChannel(r, segs.get(r.id) ?? []));
}

async function assertSegmentsExist(db: DbOrTx, workspaceId: string, ids: string[]) {
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

/** Cria (sem id) ou edita (com id) um canal. Na Fase 3, os grupos passam a ser importados do WhatsApp. */
export async function upsertChannel(ctx: Ctx, raw: UpsertChannelInput, opts: MutationOptions = {}) {
  const input = UpsertChannelInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.id ? "channels.update" : "channels.create",
    scope: "channels:write",
    input,
    opts,
    target: (i) => ({ type: "channel", id: i.id }),
    preview: async (c, i) => {
      if (i.segment_ids) await assertSegmentsExist(c.db, wsId, i.segment_ids);
      if (!i.id) {
        if (!i.name) {
          throw new AppError("VALIDATION_ERROR", "Informe o nome para criar o canal.");
        }
        return { before: null, changes: i };
      }
      const before = await getChannelRow(c.db, wsId, i.id);
      const segs = await segmentIdsFor(c.db, [before.id]);
      return { before: toChannel(before, segs.get(before.id) ?? []), changes: i };
    },
    execute: async (tx, i) => {
      const values = {
        ...(i.type !== undefined && { type: i.type }),
        ...(i.name !== undefined && { name: i.name }),
        ...(i.invite_url !== undefined && { inviteUrl: i.invite_url }),
        ...(i.member_count !== undefined && { memberCount: i.member_count }),
        ...(i.member_limit !== undefined && { memberLimit: i.member_limit }),
        ...(i.status !== undefined && { status: i.status }),
      };
      let row: ChannelRow | undefined;
      if (i.id) {
        [row] = Object.keys(values).length
          ? await tx.db
              .update(channels)
              .set(values)
              .where(and(eq(channels.id, i.id), eq(channels.workspaceId, wsId)))
              .returning()
          : [await getChannelRow(tx.db, wsId, i.id)];
      } else {
        [row] = await tx.db
          .insert(channels)
          .values({ ...values, name: i.name ?? "", workspaceId: wsId })
          .returning();
      }
      if (!row) throw new AppError("NOT_FOUND", "Canal não encontrado.");
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
  const rows = await ctx.db
    .select({
      segment: segments,
      channelCount: sql<number>`count(${channelSegments.channelId})::int`,
    })
    .from(segments)
    .leftJoin(channelSegments, eq(channelSegments.segmentId, segments.id))
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
