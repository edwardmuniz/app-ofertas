import {
  CreateTrackedLinkInput,
  ListTrackedLinksQuery,
  type TrackedLink,
  UpdateTrackedLinkInput,
} from "@ofertas/contracts";
import { type DbOrTx, trackedLinks } from "@ofertas/db";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { requireScope } from "./authz";
import { getChannelRow } from "./channels";
import { type Ctx, type Deps, now } from "./context";
import { olderThan, toPage } from "./cursor";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { type MutationOptions, runMutation } from "./mutation";
import { generateSlug, normalizeCustomSlug } from "./slug";

type LinkRow = typeof trackedLinks.$inferSelect;

export const shortUrl = (deps: Pick<Deps, "redirectBaseUrl">, slug: string) =>
  `${deps.redirectBaseUrl.replace(/\/$/, "")}/${slug}`;

export const linkCacheKey = (slug: string) => `link:${slug}`;

const toTrackedLink = (deps: Pick<Deps, "redirectBaseUrl">, r: LinkRow): TrackedLink => ({
  id: r.id,
  slug: r.slug,
  short_url: shortUrl(deps, r.slug),
  destination_url: r.destinationUrl,
  fallback_url: r.fallbackUrl,
  active: r.active,
  expires_at: r.expiresAt?.toISOString() ?? null,
  title: r.title,
  source: r.source,
  campaign: r.campaign,
  channel_id: r.channelId,
  sub_ids: r.subIds,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

async function slugTaken(db: DbOrTx, slug: string) {
  const [row] = await db
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(eq(trackedLinks.slug, slug));
  return Boolean(row);
}

async function getLinkRow(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(trackedLinks)
    .where(and(eq(trackedLinks.id, id), eq(trackedLinks.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Link não encontrado.", { details: { id } });
  return row;
}

export async function createTrackedLink(
  ctx: Ctx,
  raw: CreateTrackedLinkInput,
  opts: MutationOptions = {},
) {
  const input = CreateTrackedLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const res = await runMutation(ctx, {
    action: "links.create",
    scope: "links:write",
    input,
    opts,
    preview: async (c, i) => {
      if (i.channel_id) await getChannelRow(c.db, wsId, i.channel_id);
      let slug: string;
      if (i.slug) {
        slug = normalizeCustomSlug(i.slug);
        if (await slugTaken(c.db, slug)) {
          throw new AppError("CONFLICT", `O slug "${slug}" já está em uso.`, {
            hint: "Escolha outro slug ou omita para gerar automaticamente.",
          });
        }
      } else {
        do slug = generateSlug();
        while (await slugTaken(c.db, slug));
      }
      return { slug, short_url: shortUrl(c, slug), destination_url: i.destination_url };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .insert(trackedLinks)
        .values({
          workspaceId: wsId,
          slug: p.slug,
          destinationUrl: i.destination_url,
          fallbackUrl: i.fallback_url ?? null,
          expiresAt: i.expires_at ? new Date(i.expires_at) : null,
          title: i.title ?? null,
          source: i.source ?? null,
          campaign: i.campaign ?? null,
          channelId: i.channel_id ?? null,
          subIds: i.sub_ids ?? {},
        })
        .returning();
      if (!row) throw new Error("Falha ao criar link");
      await emitEvent(tx.db, wsId, "link.created", { link_id: row.id, slug: row.slug });
      return toTrackedLink(ctx, row);
    },
  });
  // Remove eventual "não existe" guardado em cache para este slug.
  if (res.status === "done") await ctx.cache.del(linkCacheKey(res.result.slug));
  return res;
}

export async function updateTrackedLink(
  ctx: Ctx,
  raw: UpdateTrackedLinkInput,
  opts: MutationOptions = {},
) {
  const input = UpdateTrackedLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const res = await runMutation(ctx, {
    action: "links.update",
    scope: "links:write",
    input,
    opts,
    target: (i) => ({ type: "tracked_link", id: i.id }),
    preview: async (c, i) => {
      const before = toTrackedLink(c, await getLinkRow(c.db, wsId, i.id));
      const { id: _id, ...changes } = i;
      return { before, changes };
    },
    execute: async (tx, i, p) => {
      const [row] = await tx.db
        .update(trackedLinks)
        .set({
          ...(i.destination_url !== undefined && { destinationUrl: i.destination_url }),
          ...(i.fallback_url !== undefined && { fallbackUrl: i.fallback_url }),
          ...(i.active !== undefined && { active: i.active }),
          ...(i.expires_at !== undefined && {
            expiresAt: i.expires_at ? new Date(i.expires_at) : null,
          }),
          ...(i.title !== undefined && { title: i.title }),
          updatedAt: now(ctx),
        })
        .where(and(eq(trackedLinks.id, i.id), eq(trackedLinks.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Link não encontrado.");
      if (i.destination_url && i.destination_url !== p.before.destination_url) {
        await emitEvent(tx.db, wsId, "link.destination_changed", {
          link_id: row.id,
          from: p.before.destination_url,
          to: i.destination_url,
        });
      }
      return toTrackedLink(ctx, row);
    },
  });
  if (res.status === "done") await ctx.cache.del(linkCacheKey(res.result.slug));
  return res;
}

export async function listTrackedLinks(ctx: Ctx, raw: Partial<ListTrackedLinksQuery> = {}) {
  requireScope(ctx.actor, "links:read");
  const q = ListTrackedLinksQuery.parse(raw);
  const conds = [eq(trackedLinks.workspaceId, ctx.actor.workspaceId)];
  if (q.channel_id) conds.push(eq(trackedLinks.channelId, q.channel_id));
  if (q.campaign) conds.push(eq(trackedLinks.campaign, q.campaign));
  if (q.source) conds.push(eq(trackedLinks.source, q.source));
  if (q.active !== undefined) conds.push(eq(trackedLinks.active, q.active));
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    const search = or(ilike(trackedLinks.title, term), ilike(trackedLinks.slug, term));
    if (search) conds.push(search);
  }
  if (q.cursor) {
    const c = olderThan(q.cursor, trackedLinks.createdAt, trackedLinks.id);
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select()
    .from(trackedLinks)
    .where(and(...conds))
    .orderBy(desc(trackedLinks.createdAt), desc(trackedLinks.id))
    .limit(q.limit + 1);
  return toPage(rows, q.limit, (r) => toTrackedLink(ctx, r));
}
