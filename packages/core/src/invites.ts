import { CreateInviteLinkInput, type InviteLink, UpdateInviteLinkInput } from "@ofertas/contracts";
import { channelSegments, channels, type DbOrTx, inviteLinks, segments } from "@ofertas/db";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { type MutationOptions, runMutation } from "./mutation";
import { generateSlug, normalizeCustomSlug } from "./slug";

type InviteRow = typeof inviteLinks.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

export const inviteUrl = (deps: Pick<Deps, "redirectBaseUrl">, slug: string) =>
  `${deps.redirectBaseUrl.replace(/\/$/, "")}/entrar/${slug}`;

/** Grupos do segmento com vaga, na ordem de preenchimento (mais antigos primeiro). */
async function candidateChannels(db: DbOrTx, segmentId: string, reserve: number) {
  return db
    .select({ channel: channels })
    .from(channelSegments)
    .innerJoin(channels, eq(channels.id, channelSegments.channelId))
    .where(
      and(
        eq(channelSegments.segmentId, segmentId),
        eq(channels.status, "active"),
        isNotNull(channels.inviteUrl),
        sql`${channels.memberCount} < ${channels.memberLimit} - ${reserve}`,
      ),
    )
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .then((rows) => rows.map((r) => r.channel));
}

async function capacityOf(db: DbOrTx, invite: InviteRow) {
  const candidates = await candidateChannels(db, invite.segmentId, invite.reserve);
  const slots = candidates.reduce(
    (sum, c) => sum + Math.max(0, c.memberLimit - invite.reserve - c.memberCount),
    0,
  );
  const first = candidates[0];
  return {
    channels: candidates.length,
    available_slots: slots,
    current_channel: first ? { id: first.id, name: first.name } : null,
  };
}

async function toInviteLink(
  deps: Pick<Deps, "redirectBaseUrl">,
  db: DbOrTx,
  r: InviteRow,
  segmentName: string,
): Promise<InviteLink> {
  return {
    id: r.id,
    slug: r.slug,
    url: inviteUrl(deps, r.slug),
    name: r.name,
    segment_id: r.segmentId,
    segment_name: segmentName,
    strategy: r.strategy,
    reserve: r.reserve,
    fallback_url: r.fallbackUrl,
    active: r.active,
    capacity: await capacityOf(db, r),
    created_at: r.createdAt.toISOString(),
  };
}

async function getSegmentName(db: DbOrTx, workspaceId: string, segmentId: string) {
  const [seg] = await db
    .select({ name: segments.name })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.workspaceId, workspaceId)));
  if (!seg) {
    throw new AppError("NOT_FOUND", "Segmento não encontrado.", {
      hint: "Use list_segments para ver os ids válidos.",
    });
  }
  return seg.name;
}

async function inviteSlugTaken(db: DbOrTx, slug: string) {
  const [row] = await db
    .select({ id: inviteLinks.id })
    .from(inviteLinks)
    .where(eq(inviteLinks.slug, slug));
  return Boolean(row);
}

export async function createInviteLink(
  ctx: Ctx,
  raw: CreateInviteLinkInput,
  opts: MutationOptions = {},
) {
  const input = CreateInviteLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "invites.create",
    scope: "links:write",
    input,
    opts,
    preview: async (c, i) => {
      const segmentName = await getSegmentName(c.db, wsId, i.segment_id);
      let slug: string;
      if (i.slug) {
        slug = normalizeCustomSlug(i.slug);
        if (await inviteSlugTaken(c.db, slug)) {
          throw new AppError("CONFLICT", `O convite "${slug}" já existe.`);
        }
      } else {
        do slug = generateSlug(6, { lowercase: true });
        while (await inviteSlugTaken(c.db, slug));
      }
      return { slug, url: inviteUrl(c, slug), segment_name: segmentName };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .insert(inviteLinks)
        .values({
          workspaceId: wsId,
          slug: p.slug,
          name: i.name,
          segmentId: i.segment_id,
          strategy: i.strategy,
          reserve: i.reserve,
          fallbackUrl: i.fallback_url ?? null,
        })
        .returning();
      if (!row) throw new Error("Falha ao criar convite");
      return toInviteLink(ctx, tx.db, row, p.segment_name);
    },
  });
}

export async function updateInviteLink(
  ctx: Ctx,
  raw: UpdateInviteLinkInput,
  opts: MutationOptions = {},
) {
  const input = UpdateInviteLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "invites.update",
    scope: "links:write",
    input,
    opts,
    target: (i) => ({ type: "invite_link", id: i.id }),
    preview: async (c, i) => {
      const [row] = await c.db
        .select()
        .from(inviteLinks)
        .where(and(eq(inviteLinks.id, i.id), eq(inviteLinks.workspaceId, wsId)));
      if (!row) throw new AppError("NOT_FOUND", "Convite não encontrado.");
      const { id: _id, ...changes } = i;
      const segmentId = i.segment_id ?? row.segmentId;
      // Valida o segmento novo (e devolve o nome na prévia).
      const segmentName = await getSegmentName(c.db, wsId, segmentId);
      return { segmentId, segment_name: segmentName, changes };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .update(inviteLinks)
        .set({
          ...(i.name !== undefined && { name: i.name }),
          ...(i.segment_id !== undefined && { segmentId: i.segment_id }),
          ...(i.strategy !== undefined && { strategy: i.strategy }),
          ...(i.reserve !== undefined && { reserve: i.reserve }),
          ...(i.fallback_url !== undefined && { fallbackUrl: i.fallback_url }),
          ...(i.active !== undefined && { active: i.active }),
        })
        .where(and(eq(inviteLinks.id, i.id), eq(inviteLinks.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Convite não encontrado.");
      return toInviteLink(ctx, tx.db, row, p.segment_name);
    },
  });
}

export async function listInviteLinks(ctx: Ctx): Promise<InviteLink[]> {
  requireScope(ctx.actor, "links:read");
  const rows = await ctx.db
    .select({ invite: inviteLinks, segmentName: segments.name })
    .from(inviteLinks)
    .innerJoin(segments, eq(segments.id, inviteLinks.segmentId))
    .where(eq(inviteLinks.workspaceId, ctx.actor.workspaceId))
    .orderBy(desc(inviteLinks.createdAt));
  return Promise.all(rows.map((r) => toInviteLink(ctx, ctx.db, r.invite, r.segmentName)));
}

// ── Resolução pública (usada pelo redirecionador) ──────────────────

export type InviteResolution =
  | { kind: "not_found" }
  | { kind: "inactive"; invite: InviteRow }
  | { kind: "redirect"; invite: InviteRow; channel: ChannelRow }
  | { kind: "full"; invite: InviteRow };

const FULL_EVENT_THROTTLE_SEC = 3600;

/** Escolhe o grupo de destino de um convite rotativo. */
export async function resolveInvite(deps: Deps, slug: string): Promise<InviteResolution> {
  const [invite] = await deps.db
    .select()
    .from(inviteLinks)
    .where(eq(inviteLinks.slug, slug.toLowerCase()));
  if (!invite) return { kind: "not_found" };
  if (!invite.active) return { kind: "inactive", invite };

  const candidates = await candidateChannels(deps.db, invite.segmentId, invite.reserve);
  if (candidates.length === 0) {
    const first = await deps.cache.setIfAbsent(
      `evt:segment.full:${invite.id}`,
      "1",
      FULL_EVENT_THROTTLE_SEC,
    );
    if (first) {
      await emitEvent(deps.db, invite.workspaceId, "segment.full", {
        invite_link_id: invite.id,
        segment_id: invite.segmentId,
        at: now(deps).toISOString(),
      });
    }
    return { kind: "full", invite };
  }

  let channel = candidates[0] as ChannelRow;
  if (invite.strategy === "round_robin" && candidates.length > 1) {
    const { count } = await deps.counters.incr(`rr:${invite.id}`, 30 * 86_400);
    channel = candidates[(count - 1) % candidates.length] as ChannelRow;
  }
  return { kind: "redirect", invite, channel };
}
