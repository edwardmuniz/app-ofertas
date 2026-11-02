import {
  AUDIENCE_SOURCES,
  type AudienceStats,
  type MetricsPeriodQuery,
  type Storefront,
  StorefrontDesign,
  UpdateStorefrontInput,
} from "@ofertas/contracts";
import {
  channelStatsDaily,
  channels,
  clicks,
  type DbOrTx,
  inviteLinks,
  offers,
  products,
  storefronts,
  workspaces,
} from "@ofertas/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { requireScope } from "./authz";
import { type Ctx, type Deps, now } from "./context";
import { AppError } from "./errors";
import { inviteUrl } from "./invites";
import { resolvePeriod } from "./metrics";
import { type MutationOptions, runMutation } from "./mutation";
import { localDate } from "./tz";

type Row = typeof storefronts.$inferSelect;

/** Endereços que confundem com páginas do sistema ou marcas de terceiros. */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "entrar",
  "health",
  "login",
  "ofzap",
  "painel",
  "suporte",
  "www",
  "amazon",
  "shopee",
  "mercadolivre",
  "magalu",
  "whatsapp",
]);

export const storefrontUrl = (deps: Pick<Deps, "redirectBaseUrl">, slug: string) =>
  `${deps.redirectBaseUrl.replace(/\/$/, "")}/@${slug}`;

const cacheKey = (slug: string) => `storefront:${slug}`;

/** Personalização salva, com os padrões preenchidos (campos inválidos antigos voltam ao padrão). */
function designOf(r: Pick<Row, "design">): StorefrontDesign {
  const parsed = StorefrontDesign.safeParse(r.design ?? {});
  return parsed.success ? parsed.data : StorefrontDesign.parse({});
}

function toStorefront(deps: Pick<Deps, "redirectBaseUrl">, r: Row): Storefront {
  const url = storefrontUrl(deps, r.slug);
  return {
    slug: r.slug,
    url,
    title: r.title,
    tagline: r.tagline,
    avatar_url: r.avatarUrl,
    invite_link_ids: r.inviteLinkIds,
    design: designOf(r),
    active: r.active,
    source_links: AUDIENCE_SOURCES.map((s) => ({ ...s, url: `${url}?src=${s.source}` })),
  };
}

async function rowOf(db: DbOrTx, workspaceId: string) {
  const [r] = await db.select().from(storefronts).where(eq(storefronts.workspaceId, workspaceId));
  return r ?? null;
}

export async function getStorefront(ctx: Ctx): Promise<Storefront | null> {
  requireScope(ctx.actor, "growth:read");
  const r = await rowOf(ctx.db, ctx.actor.workspaceId);
  return r ? toStorefront(ctx, r) : null;
}

/** Cria ou altera a vitrine do workspace. */
export async function updateStorefront(
  ctx: Ctx,
  raw: UpdateStorefrontInput,
  opts: MutationOptions = {},
) {
  const input = UpdateStorefrontInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "growth.update_storefront",
    scope: "growth:write",
    input,
    opts,
    target: () => ({ type: "storefront", id: wsId }),
    preview: async (c, i) => {
      const before = await rowOf(c.db, wsId);
      if (!before && (!i.slug || !i.title)) {
        throw new AppError("VALIDATION_ERROR", "Informe o endereço e o nome da marca.", {
          hint: "Ex.: slug achadinhosdoedu e título Achadinhos do Edu.",
        });
      }
      if (i.slug && i.slug !== before?.slug) {
        if (RESERVED.has(i.slug)) {
          throw new AppError("VALIDATION_ERROR", "Esse endereço é reservado.", {
            hint: "Escolha outro, de preferência com o nome da sua marca.",
          });
        }
        const [taken] = await c.db
          .select({ id: storefronts.id })
          .from(storefronts)
          .where(and(eq(storefronts.slug, i.slug), ne(storefronts.workspaceId, wsId)));
        if (taken) throw new AppError("CONFLICT", "Esse endereço já está em uso.");
      }
      if (i.invite_link_ids?.length) {
        const found = await c.db
          .select({ id: inviteLinks.id })
          .from(inviteLinks)
          .where(
            and(eq(inviteLinks.workspaceId, wsId), inArray(inviteLinks.id, i.invite_link_ids)),
          );
        if (found.length !== new Set(i.invite_link_ids).size) {
          throw new AppError("VALIDATION_ERROR", "Convite não encontrado neste workspace.");
        }
      }
      // Só os campos de personalização enviados mudam.
      const sent = (raw as { design?: Record<string, unknown> }).design ?? {};
      const patch = Object.fromEntries(Object.entries(i.design ?? {}).filter(([k]) => k in sent));
      const merged = StorefrontDesign.parse({ ...(before ? designOf(before) : {}), ...patch });
      const design = {
        ...merged,
        accent_color: merged.accent_color.toUpperCase(),
        background_color: merged.background_color.toUpperCase(),
        text_color: merged.text_color.toUpperCase(),
      };
      if (design.featured_offer_ids.length) {
        const found = await c.db
          .select({ id: offers.id })
          .from(offers)
          .where(and(eq(offers.workspaceId, wsId), inArray(offers.id, design.featured_offer_ids)));
        if (found.length !== new Set(design.featured_offer_ids).size) {
          throw new AppError("VALIDATION_ERROR", "Oferta em destaque não encontrada.");
        }
      }
      return { before: before ? toStorefront(c, before) : null, design };
    },
    execute: async (tx, i, p) => {
      const values = {
        ...(i.slug !== undefined && { slug: i.slug }),
        ...(i.title !== undefined && { title: i.title }),
        ...(i.tagline !== undefined && { tagline: i.tagline || null }),
        ...(i.avatar_url !== undefined && { avatarUrl: i.avatar_url }),
        ...(i.invite_link_ids !== undefined && { inviteLinkIds: [...new Set(i.invite_link_ids)] }),
        ...(i.active !== undefined && { active: i.active }),
        design: p.design,
      };
      const [row] = p.before
        ? await tx.db
            .update(storefronts)
            .set(values)
            .where(eq(storefronts.workspaceId, wsId))
            .returning()
        : await tx.db
            .insert(storefronts)
            .values({ workspaceId: wsId, slug: i.slug ?? "", title: i.title ?? "", ...values })
            .returning();
      if (!row) throw new Error("Falha ao salvar a vitrine");
      await ctx.cache.del(cacheKey(row.slug));
      if (p.before && p.before.slug !== row.slug) await ctx.cache.del(cacheKey(p.before.slug));
      return toStorefront(ctx, row);
    },
  });
}

// ── Página pública ──────────────────────────────────────────────

export type PublicOffer = {
  id: string;
  category: string | null;
  featured: boolean;
  title: string;
  image: string | null;
  price: number;
  original_price: number | null;
  discount_pct: number | null;
  pix_price: number | null;
  platform: string;
  url: string;
};

export type PublicStorefront = {
  workspace_id: string;
  slug: string;
  title: string;
  tagline: string | null;
  avatar_url: string | null;
  design: StorefrontDesign;
  invites: { slug: string; label: string }[];
  offers: PublicOffer[];
};

const OFFER_WINDOW_DAYS = 7;

/** Dados da vitrine para a página pública (null = não existe ou está pausada). Cache de 60 s. */
export async function loadPublicStorefront(
  deps: Deps,
  rawSlug: string,
): Promise<PublicStorefront | null> {
  const slug = rawSlug.toLowerCase();
  const cached = await deps.cache.get(cacheKey(slug));
  if (cached !== null) return cached === "null" ? null : (JSON.parse(cached) as PublicStorefront);

  const [row] = await deps.db.select().from(storefronts).where(eq(storefronts.slug, slug));
  let out: PublicStorefront | null = null;
  if (row?.active) {
    const invites = row.inviteLinkIds.length
      ? await deps.db
          .select({ id: inviteLinks.id, slug: inviteLinks.slug, name: inviteLinks.name })
          .from(inviteLinks)
          .where(
            and(
              eq(inviteLinks.workspaceId, row.workspaceId),
              inArray(inviteLinks.id, row.inviteLinkIds),
              eq(inviteLinks.active, true),
            ),
          )
      : [];
    const design = designOf(row);
    const base = and(
      eq(offers.workspaceId, row.workspaceId),
      eq(offers.status, "approved"),
      isNotNull(offers.affiliateUrl),
    );
    // Destaques primeiro (na ordem escolhida, enquanto aprovados), depois as melhores recentes.
    const featured = design.featured_offer_ids.length
      ? await deps.db
          .select({ offer: offers, product: products })
          .from(offers)
          .innerJoin(products, eq(products.id, offers.productId))
          .where(and(base, inArray(offers.id, design.featured_offer_ids)))
      : [];
    featured.sort(
      (a, b) =>
        design.featured_offer_ids.indexOf(a.offer.id) -
        design.featured_offer_ids.indexOf(b.offer.id),
    );
    const since = new Date(now(deps).getTime() - OFFER_WINDOW_DAYS * 86_400_000);
    const recent =
      design.offers_mode === "auto"
        ? await deps.db
            .select({ offer: offers, product: products })
            .from(offers)
            .innerJoin(products, eq(products.id, offers.productId))
            .where(and(base, gte(offers.createdAt, since)))
            .orderBy(desc(offers.score), desc(offers.createdAt))
            .limit(design.max_offers + featured.length)
        : [];
    const featuredIds = new Set(featured.map((f) => f.offer.id));
    const list = [
      ...featured.map((r) => ({ ...r, featured: true })),
      ...recent.filter((r) => !featuredIds.has(r.offer.id)).map((r) => ({ ...r, featured: false })),
    ].slice(0, design.max_offers);
    out = {
      workspace_id: row.workspaceId,
      slug: row.slug,
      title: row.title,
      tagline: row.tagline,
      avatar_url: row.avatarUrl,
      design,
      invites: row.inviteLinkIds
        .map((id) => invites.find((v) => v.id === id))
        .filter((v): v is NonNullable<typeof v> => Boolean(v))
        .map((v) => ({ slug: v.slug, label: v.name })),
      offers: list.map(({ offer: o, product: p, featured: f }) => ({
        id: o.id,
        category: p.categoryName,
        featured: f,
        title: p.title,
        image: p.imageUrls[0] ?? null,
        price: o.price,
        original_price: o.originalPrice,
        discount_pct: o.discountPct,
        pix_price: o.priceDetails?.pix_price ?? null,
        platform: p.platform,
        // Link de afiliado direto (a Amazon não aceita destino escondido).
        url: o.affiliateUrl ?? p.url,
      })),
    };
  }
  await deps.cache.set(cacheKey(slug), out ? JSON.stringify(out) : "null", 60);
  return out;
}

/** Link do botão "Entrar no grupo", levando a origem da visita. */
export function storefrontInviteHref(
  deps: Pick<Deps, "redirectBaseUrl">,
  inviteSlug: string,
  src: string | null,
) {
  const url = new URL(inviteUrl(deps, inviteSlug));
  if (src) url.searchParams.set("src", src);
  url.searchParams.set("via", "vitrine");
  return url.toString();
}

// ── Medição ─────────────────────────────────────────────────────

export async function getAudienceStats(
  ctx: Ctx,
  raw: MetricsPeriodQuery = {},
): Promise<AudienceStats> {
  requireScope(ctx.actor, "growth:read");
  const wsId = ctx.actor.workspaceId;
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, wsId));
  const tz = ws?.tz ?? "America/Sao_Paulo";
  const { cur } = resolvePeriod(raw, now(ctx), tz);
  const inRange = and(
    eq(clicks.workspaceId, wsId),
    eq(clicks.isBot, false),
    gte(clicks.ts, cur.from),
    lt(clicks.ts, cur.to),
    inArray(clicks.kind, ["page_view", "page_offer", "invite"]),
  );
  const src = sql<string>`coalesce(nullif(${clicks.params} ->> 'src', ''), 'direto')`;
  const day = sql<string>`to_char(${clicks.ts} at time zone ${tz}, 'YYYY-MM-DD')`;
  const count = (kind: string) =>
    sql<number>`(count(*) filter (where ${clicks.kind} = ${kind}))::int`;

  const fromDay = localDate(cur.from, tz);
  const toDay = localDate(new Date(cur.to.getTime() - 1), tz);
  const [bySource, byDay, groupDays] = await Promise.all([
    ctx.db
      .select({
        source: src,
        views: count("page_view"),
        invites: count("invite"),
        offers: count("page_offer"),
      })
      .from(clicks)
      .where(inRange)
      .groupBy(src),
    ctx.db
      .select({ date: day, views: count("page_view"), invites: count("invite") })
      .from(clicks)
      .where(inRange)
      .groupBy(sql`1`),
    ctx.db
      .select({
        date: channelStatsDaily.date,
        joins: sql<number>`coalesce(sum(${channelStatsDaily.joins}), 0)::int`,
        leaves: sql<number>`coalesce(sum(${channelStatsDaily.leaves}), 0)::int`,
      })
      .from(channelStatsDaily)
      .innerJoin(channels, eq(channels.id, channelStatsDaily.channelId))
      .where(
        and(
          eq(channels.workspaceId, wsId),
          gte(channelStatsDaily.date, fromDay),
          lte(channelStatsDaily.date, toDay),
        ),
      )
      .groupBy(channelStatsDaily.date),
  ]);

  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  const sources = bySource
    .map((r) => ({
      source: r.source,
      views: r.views,
      invite_clicks: r.invites,
      offer_clicks: r.offers,
      view_to_invite: ratio(r.invites, r.views),
    }))
    .sort((a, b) => b.invite_clicks - a.invite_clicks || b.views - a.views);
  const sum = (k: "views" | "invite_clicks" | "offer_clicks") =>
    sources.reduce((s, r) => s + r[k], 0);
  const joins = groupDays.reduce((s, r) => s + r.joins, 0);
  const leaves = groupDays.reduce((s, r) => s + r.leaves, 0);

  const dates = [...new Set([...byDay.map((d) => d.date), ...groupDays.map((d) => d.date)])].sort();
  return {
    period: { from: cur.from.toISOString(), to: cur.to.toISOString(), label: cur.label },
    sources,
    totals: {
      views: sum("views"),
      invite_clicks: sum("invite_clicks"),
      offer_clicks: sum("offer_clicks"),
      joins,
      leaves,
      net: joins - leaves,
      invite_to_join: ratio(joins, sum("invite_clicks")),
    },
    daily: dates.map((date) => {
      const c = byDay.find((d) => d.date === date);
      const g = groupDays.find((d) => d.date === date);
      return {
        date,
        views: c?.views ?? 0,
        invite_clicks: c?.invites ?? 0,
        joins: g?.joins ?? 0,
        leaves: g?.leaves ?? 0,
      };
    }),
  };
}
