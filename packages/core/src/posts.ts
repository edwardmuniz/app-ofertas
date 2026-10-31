import {
  ListPostsQuery,
  type Post,
  PreviewPostInput,
  SchedulePostsInput,
} from "@ofertas/contracts";
import {
  channelStatsDaily,
  channels,
  type DbOrTx,
  messagingAccounts,
  offers,
  posts,
  products,
  trackedLinks,
  workspaces,
} from "@ofertas/db";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now, systemActor } from "./context";
import { olderThan, toPage } from "./cursor";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { getLimit } from "./limits";
import { shortUrl } from "./links";
import { getAccountRow, messagingError, providerOf, refOf } from "./messaging";
import { type MutationOptions, runMutation } from "./mutation";
import { createOfferLink, validateOfferAsSystem } from "./offers";
import { offerVars, renderTemplate, resolveTemplateBody } from "./templates";
import { localDate, nextAllowedTime } from "./tz";

type PostRow = typeof posts.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

const MINUTE = 60_000;
const DUPLICATE_WINDOW_MS = 7 * 86_400_000;
const PUBLISHABLE_TYPES = ["wa_group", "wa_community", "wa_channel"] as const;
const LIVE_STATUSES = ["scheduled", "sending", "sent"] as const;
const MAX_ATTEMPTS = 3;
const PLACEHOLDER_LINK = "xxxxxxx";

export async function workspaceSchedule(db: DbOrTx, workspaceId: string) {
  const [ws] = await db
    .select({ tz: workspaces.timezone, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const windows = ws?.settings.preferences?.posting_windows;
  return {
    tz: ws?.tz ?? "America/Sao_Paulo",
    windows: Array.isArray(windows)
      ? windows.filter((w): w is string => typeof w === "string")
      : [],
  };
}

type Skipped = { channel_id: string | null; offer_id: string | null; reason: string };

/** Canais de destino (por id e por segmento) aptos a receber posts. */
async function resolveTargets(
  db: DbOrTx,
  workspaceId: string,
  channelIds: string[] = [],
  segmentIds: string[] = [],
) {
  const conds = [];
  if (channelIds.length) conds.push(inArray(channels.id, channelIds));
  if (segmentIds.length) {
    conds.push(
      sql`${channels.id} in (select channel_id from channel_segments where segment_id in ${segmentIds})`,
    );
  }
  if (!conds.length) {
    throw new AppError("VALIDATION_ERROR", "Informe channel_ids ou segment_ids.");
  }
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), or(...conds)));
  const skipped: Skipped[] = [];
  const targets: ChannelRow[] = [];
  for (const c of rows) {
    if (c.status !== "active")
      skipped.push({ channel_id: c.id, offer_id: null, reason: `Canal ${c.name} pausado.` });
    else if (!(PUBLISHABLE_TYPES as readonly string[]).includes(c.type))
      skipped.push({
        channel_id: c.id,
        offer_id: null,
        reason: `${c.name} não é um canal de WhatsApp.`,
      });
    else if (!c.messagingAccountId || !c.externalId)
      skipped.push({
        channel_id: c.id,
        offer_id: null,
        reason: `${c.name} não está ligado a um número de WhatsApp (importe os grupos).`,
      });
    else targets.push(c);
  }
  return { targets, skipped };
}

/** Último horário ocupado no canal (agendado ou enviado). */
async function lastSlot(db: DbOrTx, channelId: string) {
  const [r] = await db
    .select({ at: sql<string | null>`max(coalesce(${posts.sentAt}, ${posts.scheduledAt}))` })
    .from(posts)
    .where(and(eq(posts.channelId, channelId), inArray(posts.status, [...LIVE_STATUSES])));
  return r?.at ? new Date(r.at) : null;
}

/** Pares canal:produto já publicados/agendados recentemente. */
async function recentPairs(db: DbOrTx, channelIds: string[], productIds: string[], since: Date) {
  if (!channelIds.length || !productIds.length) return new Set<string>();
  const rows = await db
    .select({ channelId: posts.channelId, productId: offers.productId })
    .from(posts)
    .innerJoin(offers, eq(offers.id, posts.offerId))
    .where(
      and(
        inArray(posts.channelId, channelIds),
        inArray(offers.productId, productIds),
        inArray(posts.status, [...LIVE_STATUSES]),
        gte(posts.createdAt, since),
      ),
    );
  return new Set(rows.map((r) => `${r.channelId}:${r.productId}`));
}

async function offersWithProducts(db: DbOrTx, workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({ offer: offers, product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.workspaceId, workspaceId), inArray(offers.id, ids)));
}

function toPost(
  deps: Pick<Deps, "redirectBaseUrl">,
  r: PostRow,
  channelName: string,
  title: string | null,
  slug: string | null,
): Post {
  return {
    id: r.id,
    channel_id: r.channelId,
    channel_name: channelName,
    offer_id: r.offerId,
    title,
    status: r.status,
    scheduled_at: r.scheduledAt.toISOString(),
    sent_at: r.sentAt?.toISOString() ?? null,
    body: r.body,
    short_url: slug ? shortUrl(deps, slug) : null,
    error: r.error,
    attempts: r.attempts,
    rule_id: r.ruleId,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}

/** Prévia da mensagem (sem efeitos). */
export async function previewPost(ctx: Ctx, raw: PreviewPostInput) {
  requireScope(ctx.actor, "posts:read");
  const input = PreviewPostInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  if (input.text) return { body: input.text, image_url: null };
  if (!input.offer_id) throw new AppError("VALIDATION_ERROR", "Informe offer_id ou text.");
  const [row] = await offersWithProducts(ctx.db, wsId, [input.offer_id]);
  if (!row) throw new AppError("NOT_FOUND", "Oferta não encontrada.");
  const body = renderTemplate(
    await resolveTemplateBody(ctx.db, wsId, input.template_id),
    offerVars(row.offer, row.product, shortUrl(ctx, PLACEHOLDER_LINK)),
  );
  return { body, image_url: row.product.imageUrls[0] ?? null };
}

/**
 * Agenda publicações (ofertas ou texto livre) em canais/segmentos.
 * Respeita janelas de envio, intervalo mínimo por grupo e não repete o mesmo produto
 * no mesmo grupo por 7 dias.
 */
export async function schedulePosts(ctx: Ctx, raw: SchedulePostsInput, opts: MutationOptions = {}) {
  const input = SchedulePostsInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "posts.schedule",
    scope: "posts:write",
    input,
    opts,
    preview: async (c, i) => {
      if (!i.offer_ids?.length && !i.text) {
        throw new AppError("VALIDATION_ERROR", "Informe offer_ids ou text.");
      }
      const { targets, skipped } = await resolveTargets(c.db, wsId, i.channel_ids, i.segment_ids);
      const sched = await workspaceSchedule(c.db, wsId);
      const minInterval = (await getLimit(c, wsId, "posts.min_interval_minutes")) * MINUTE;
      const jitterMax = (await getLimit(c, wsId, "posts.jitter_seconds")) * 1000;
      const spacing = Math.max((i.spacing_minutes ?? 10) * MINUTE, minInterval);
      const start = i.at ? new Date(i.at) : now(c);
      const templateBody = await resolveTemplateBody(c.db, wsId, i.template_id);

      type Item = {
        offerId: string | null;
        productId: string | null;
        title: string | null;
        body: string;
      };
      const items: Item[] = [];
      if (i.offer_ids?.length) {
        const rows = await offersWithProducts(c.db, wsId, i.offer_ids);
        for (const id of i.offer_ids) {
          const r = rows.find((x) => x.offer.id === id);
          if (!r)
            skipped.push({ channel_id: null, offer_id: id, reason: "Oferta não encontrada." });
          else if (r.offer.status !== "approved")
            skipped.push({
              channel_id: null,
              offer_id: id,
              reason: `Oferta com status ${r.offer.status} (precisa estar aprovada).`,
            });
          else
            items.push({
              offerId: id,
              productId: r.product.id,
              title: r.product.title,
              body: renderTemplate(
                templateBody,
                offerVars(r.offer, r.product, shortUrl(c, PLACEHOLDER_LINK)),
              ),
            });
        }
      } else if (i.text) {
        items.push({ offerId: null, productId: null, title: null, body: i.text });
      }

      const recent = await recentPairs(
        c.db,
        targets.map((t) => t.id),
        items.map((x) => x.productId).filter((x): x is string => Boolean(x)),
        new Date(now(c).getTime() - DUPLICATE_WINDOW_MS),
      );

      const planned = [];
      for (const ch of targets) {
        const last = await lastSlot(c.db, ch.id);
        let cursor = new Date(Math.max(start.getTime(), last ? last.getTime() + minInterval : 0));
        for (const item of items) {
          if (item.productId && recent.has(`${ch.id}:${item.productId}`)) {
            skipped.push({
              channel_id: ch.id,
              offer_id: item.offerId,
              reason: `Já publicada em ${ch.name} nos últimos 7 dias.`,
            });
            continue;
          }
          const slot = nextAllowedTime(cursor, sched.windows, sched.tz);
          const at = new Date(slot.getTime() + Math.floor(Math.random() * jitterMax));
          planned.push({
            channel_id: ch.id,
            channel_name: ch.name,
            offer_id: item.offerId,
            title: item.title,
            scheduled_at: at.toISOString(),
            body: item.body,
          });
          cursor = new Date(at.getTime() + spacing);
        }
      }
      return { posts: planned, skipped };
    },
    execute: async (tx, i, p) => {
      if (!p.posts.length) return { scheduled: [], skipped: p.skipped };
      const rows = await tx.db
        .insert(posts)
        .values(
          p.posts.map((x) => ({
            workspaceId: wsId,
            channelId: x.channel_id,
            offerId: x.offer_id,
            customText: x.offer_id ? null : (i.text ?? null),
            templateId: i.template_id ?? null,
            withImage: i.with_image,
            scheduledAt: new Date(x.scheduled_at),
            body: x.body,
            createdBy: ctx.actor.label,
          })),
        )
        .returning();
      return {
        scheduled: rows.map((r) => {
          const plan = p.posts.find(
            (x) => x.channel_id === r.channelId && x.offer_id === r.offerId,
          );
          return toPost(ctx, r, plan?.channel_name ?? "", plan?.title ?? null, null);
        }),
        skipped: p.skipped,
      };
    },
  });
}

export async function listPosts(ctx: Ctx, raw: ListPostsQuery = {}) {
  requireScope(ctx.actor, "posts:read");
  const q = ListPostsQuery.parse(raw);
  const conds = [eq(posts.workspaceId, ctx.actor.workspaceId)];
  if (q.status) conds.push(eq(posts.status, q.status));
  if (q.channel_id) conds.push(eq(posts.channelId, q.channel_id));
  if (q.offer_id) conds.push(eq(posts.offerId, q.offer_id));
  if (q.cursor) {
    const c = olderThan(q.cursor, posts.createdAt, posts.id);
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select({
      post: posts,
      channelName: channels.name,
      title: products.title,
      slug: trackedLinks.slug,
    })
    .from(posts)
    .innerJoin(channels, eq(channels.id, posts.channelId))
    .leftJoin(offers, eq(offers.id, posts.offerId))
    .leftJoin(products, eq(products.id, offers.productId))
    .leftJoin(trackedLinks, eq(trackedLinks.id, posts.trackedLinkId))
    .where(and(...conds))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(q.limit + 1);
  return toPage(
    rows.map((r) => ({ ...r, id: r.post.id, createdAt: r.post.createdAt })),
    q.limit,
    (r) => toPost(ctx, r.post, r.channelName, r.title, r.slug),
  );
}

async function loadPost(db: DbOrTx, workspaceId: string, id: string) {
  const [row] = await db
    .select({ post: posts, channel: channels })
    .from(posts)
    .innerJoin(channels, eq(channels.id, posts.channelId))
    .where(and(eq(posts.id, id), eq(posts.workspaceId, workspaceId)));
  if (!row) throw new AppError("NOT_FOUND", "Publicação não encontrada.");
  return row;
}

export async function cancelPost(ctx: Ctx, postId: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "posts.cancel",
    scope: "posts:write",
    input: { post_id: postId },
    opts,
    target: (i) => ({ type: "post", id: i.post_id }),
    preview: async (c, i) => {
      const { post, channel } = await loadPost(c.db, wsId, i.post_id);
      if (post.status !== "scheduled") {
        throw new AppError(
          "CONFLICT",
          `Só dá para cancelar publicações agendadas (status atual: ${post.status}).`,
          {
            hint:
              post.status === "sent" ? "Para remover do grupo, use delete_sent_post." : undefined,
          },
        );
      }
      return { channel: channel.name, scheduled_at: post.scheduledAt.toISOString() };
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(posts)
        .set({ status: "canceled" })
        .where(and(eq(posts.id, i.post_id), eq(posts.status, "scheduled")))
        .returning();
      if (!row) throw new AppError("CONFLICT", "A publicação já saiu da fila.");
      const { channel } = await loadPost(tx.db, wsId, row.id);
      return toPost(ctx, row, channel.name, null, null);
    },
  });
}

/** Apaga para todos uma mensagem já enviada no grupo. */
export async function deleteSentPost(ctx: Ctx, postId: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "posts.delete_sent",
    scope: "posts:write",
    input: { post_id: postId },
    opts,
    target: (i) => ({ type: "post", id: i.post_id }),
    preview: async (c, i) => {
      const { post, channel } = await loadPost(c.db, wsId, i.post_id);
      if (post.status !== "sent" || !post.externalMessageId) {
        throw new AppError("CONFLICT", "Só dá para apagar publicações já enviadas.");
      }
      return { channel: channel.name, sent_at: post.sentAt?.toISOString() ?? null };
    },
    execute: async (tx, i) => {
      const { post, channel } = await loadPost(tx.db, wsId, i.post_id);
      const acc = await getAccountRow(tx.db, wsId, channel.messagingAccountId ?? "");
      try {
        await providerOf(ctx, acc).deleteMessage(
          refOf(ctx, acc),
          channel.externalId ?? "",
          post.externalMessageId ?? "",
        );
      } catch (err) {
        throw messagingError(err);
      }
      const [row] = await tx.db
        .update(posts)
        .set({ status: "deleted" })
        .where(eq(posts.id, post.id))
        .returning();
      return toPost(ctx, row ?? post, channel.name, null, null);
    },
  });
}

// ── Envio (worker) ──────────────────────────────────────────────

/** Pega posts vencidos para envio, sem disputar com outros workers. */
export async function claimDuePosts(deps: Deps, limit = 10) {
  const at = now(deps);
  // Recupera envios travados (processo caiu no meio).
  await deps.db
    .update(posts)
    .set({ status: "scheduled" })
    .where(
      and(eq(posts.status, "sending"), lt(posts.updatedAt, new Date(at.getTime() - 5 * MINUTE))),
    );
  const claimed = await deps.db.execute<{ id: string }>(sql`
    update posts set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id in (
      select id from posts
      where status = 'scheduled' and scheduled_at <= ${at.toISOString()}
      order by scheduled_at
      limit ${limit}
      for update skip locked
    )
    returning id`);
  return [...claimed].map((r) => r.id);
}

async function reschedule(
  db: DbOrTx,
  id: string,
  at: Date,
  error: string | null,
  countAttempt: boolean,
) {
  await db
    .update(posts)
    .set({
      status: "scheduled",
      scheduledAt: at,
      error,
      ...(countAttempt ? {} : { attempts: sql`greatest(0, ${posts.attempts} - 1)` }),
    })
    .where(eq(posts.id, id));
}

async function finish(deps: Deps, post: PostRow, status: "failed" | "skipped", reason: string) {
  await deps.db.update(posts).set({ status, error: reason }).where(eq(posts.id, post.id));
  await emitEvent(deps.db, post.workspaceId, status === "failed" ? "post.failed" : "post.skipped", {
    post_id: post.id,
    reason,
  });
  return { status, reason };
}

export type PublishOutcome = { status: string; reason?: string | null };

/** Envia um post já reivindicado (status sending). */
export async function publishPost(deps: Deps, postId: string): Promise<PublishOutcome> {
  const [row] = await deps.db
    .select({ post: posts, channel: channels })
    .from(posts)
    .innerJoin(channels, eq(channels.id, posts.channelId))
    .where(eq(posts.id, postId));
  if (row?.post.status !== "sending") return { status: "ignored" };
  const { post, channel } = row;
  const wsId = post.workspaceId;
  const at = now(deps);

  if (!channel.messagingAccountId || !channel.externalId) {
    return finish(deps, post, "failed", "Canal sem número de WhatsApp.");
  }
  const [acc] = await deps.db
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, channel.messagingAccountId));
  if (!acc) return finish(deps, post, "failed", "Número de WhatsApp removido.");
  if (acc.status !== "connected") {
    if (post.attempts >= MAX_ATTEMPTS * 4)
      return finish(deps, post, "failed", "WhatsApp desconectado há muito tempo.");
    await reschedule(
      deps.db,
      post.id,
      new Date(at.getTime() + 5 * MINUTE),
      "WhatsApp desconectado; nova tentativa em 5 min.",
      true,
    );
    return { status: "rescheduled", reason: "desconectado" };
  }

  // Limites anti-banimento: intervalo no grupo e teto por hora no número.
  const minInterval = (await getLimit(deps, wsId, "posts.min_interval_minutes")) * MINUTE;
  const [lastSent] = await deps.db
    .select({ at: sql<string | null>`max(${posts.sentAt})` })
    .from(posts)
    .where(and(eq(posts.channelId, channel.id), eq(posts.status, "sent")));
  if (lastSent?.at && at.getTime() - new Date(lastSent.at).getTime() < minInterval) {
    await reschedule(
      deps.db,
      post.id,
      new Date(new Date(lastSent.at).getTime() + minInterval),
      null,
      false,
    );
    return { status: "rescheduled", reason: "intervalo do grupo" };
  }
  const perHour = await getLimit(deps, wsId, "posts.per_hour.account");
  const [sentLastHour] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(channels, eq(channels.id, posts.channelId))
    .where(
      and(
        eq(channels.messagingAccountId, acc.id),
        eq(posts.status, "sent"),
        gte(posts.sentAt, new Date(at.getTime() - 60 * MINUTE)),
      ),
    );
  if ((sentLastHour?.n ?? 0) >= perHour) {
    await reschedule(deps.db, post.id, new Date(at.getTime() + 10 * MINUTE), null, false);
    return { status: "rescheduled", reason: "limite por hora do número" };
  }

  let body = post.customText ?? post.body ?? "";
  let imageUrl: string | null = null;
  let trackedLinkId: string | null = null;
  const sysCtx: Ctx = { ...deps, actor: systemActor(wsId, "publisher") };

  try {
    if (post.offerId) {
      const [o] = await offersWithProducts(deps.db, wsId, [post.offerId]);
      if (!o) return finish(deps, post, "skipped", "Oferta removida.");
      if (o.offer.status !== "approved")
        return finish(deps, post, "skipped", `Oferta ${o.offer.status}.`);
      const check = await validateOfferAsSystem(deps, o.offer, o.product);
      if (!check.ok)
        return finish(deps, post, "skipped", `Oferta inválida no envio: ${check.reason}`);
      const [fresh] = await offersWithProducts(deps.db, wsId, [post.offerId]);
      const link = await createOfferLink(sysCtx, {
        offer_id: post.offerId,
        source: "wa",
        channel_id: channel.id,
      });
      if (link.status !== "done") throw new Error("Link da oferta não gerado.");
      trackedLinkId = link.result.link_id;
      await deps.db
        .update(trackedLinks)
        .set({ postId: post.id })
        .where(eq(trackedLinks.id, trackedLinkId));
      body = renderTemplate(
        await resolveTemplateBody(deps.db, wsId, post.templateId),
        offerVars((fresh ?? o).offer, (fresh ?? o).product, link.result.short_url),
      );
      imageUrl = post.withImage ? (o.product.imageUrls[0] ?? null) : null;
    }

    const provider = providerOf(deps, acc);
    const ref = refOf(deps, acc);
    const sent = imageUrl
      ? await provider.sendImage(ref, channel.externalId, imageUrl, body)
      : await provider.sendText(ref, channel.externalId, body);

    await deps.db
      .update(posts)
      .set({
        status: "sent",
        sentAt: now(deps),
        body,
        externalMessageId: sent.messageId,
        trackedLinkId,
        error: null,
      })
      .where(eq(posts.id, post.id));
    const tz = (await workspaceSchedule(deps.db, wsId)).tz;
    await deps.db
      .insert(channelStatsDaily)
      .values({ channelId: channel.id, date: localDate(at, tz), messagesSent: 1 })
      .onConflictDoUpdate({
        target: [channelStatsDaily.channelId, channelStatsDaily.date],
        set: { messagesSent: sql`${channelStatsDaily.messagesSent} + 1` },
      });
    await recordAudit(deps.db, sysCtx.actor, {
      action: "posts.send",
      target: { type: "post", id: post.id },
      params: { channel: channel.name, message_id: sent.messageId },
      result: "ok",
    });
    return { status: "sent" };
  } catch (err) {
    const e = err instanceof AppError ? err : messagingError(err);
    if (post.attempts >= MAX_ATTEMPTS) return finish(deps, post, "failed", e.message);
    const delay = 2 ** post.attempts * MINUTE;
    await reschedule(deps.db, post.id, new Date(at.getTime() + delay), e.message, true);
    return { status: "rescheduled", reason: e.message };
  }
}

/** Uma rodada do publicador: reivindica e envia os posts vencidos, com pausa entre envios. */
export async function runPublisher(deps: Deps, opts: { batch?: number; pauseMs?: number } = {}) {
  const ids = await claimDuePosts(deps, opts.batch ?? 10);
  const results: (PublishOutcome & { id: string })[] = [];
  for (const [idx, id] of ids.entries()) {
    if (idx > 0 && opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
    results.push({ id, ...(await publishPost(deps, id)) });
  }
  return results;
}
