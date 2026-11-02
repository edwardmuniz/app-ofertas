import { createHash } from "node:crypto";
import {
  DIRECT_LINK_PLATFORMS,
  embeddedStoreUrl,
  FAKE_CATEGORIES,
  isGenericTitle,
  looksLikeAffiliateUrl,
  type Platform,
  type ProductOffer,
  parseAmazonPage,
  parseProductPage,
  platformOfUrl,
  productIdOfUrl,
  SHOPEE_CATEGORY_PT,
  sanitizeSubId,
  titleFromUrl,
} from "@ofertas/connectors";
import {
  CreateOfferLinkInput,
  FindSimilarInput,
  ImportOfferFromLinkInput,
  ListOffersQuery,
  type Offer,
  type OfferCandidate,
  type OfferCategory,
  type OfferDetail,
  OfferFromLinkInput,
  type OfferLink,
  type OfferLinkPreview,
  SaveOfferInput,
  SearchOffersInput,
  type SearchOffersResult,
  UpdateOfferPricesInput,
  UpdateOfferStatusInput,
  type ValidateOfferResult,
} from "@ofertas/contracts";
import {
  type affiliateAccounts,
  type DbOrTx,
  feedItems,
  offers,
  offerValidations,
  posts,
  pricePoints,
  products,
  workspaces,
} from "@ofertas/db";
import { and, desc, eq, gte, ilike, inArray, sql } from "drizzle-orm";
import { activeAccounts, connectorFor, providerError, recordAccountHealth } from "./affiliates";
import { requireScope } from "./authz";
import { getChannelRow } from "./channels";
import { type Ctx, type Deps, now } from "./context";
import { olderThan, toPage } from "./cursor";
import { AppError } from "./errors";
import { emitEvent } from "./events";
import { freeSlug, insertTrackedLink, shortUrl } from "./links";
import { type MutationOptions, runMutation } from "./mutation";
import {
  offerScore,
  type PriceSummary,
  priceSummaries,
  type QualityFlag,
  qualityFlags,
  summaryOrEmpty,
} from "./scoring";

type ProductRow = typeof products.$inferSelect;
type OfferRow = typeof offers.$inferSelect;
type AccountRow = typeof affiliateAccounts.$inferSelect;
type DbDeps = Pick<
  Deps,
  "db" | "secrets" | "affiliateConnectors" | "now" | "openStream" | "fetchPage"
>;

/** Variação de preço aceita antes de considerar a oferta expirada. */
export const PRICE_TOLERANCE = 0.05;
/** Intervalo mínimo entre registros de preço iguais do mesmo produto. */
const PRICE_POINT_MIN_INTERVAL_MS = 60 * 60 * 1000;

const keyOf = (platform: string, externalId: string) => `${platform}:${externalId}`;

async function workspaceNiches(db: DbOrTx, workspaceId: string): Promise<string[]> {
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const niches = ws?.settings.preferences?.niches;
  return Array.isArray(niches) ? niches.filter((n): n is string => typeof n === "string") : [];
}

// ── Persistência de produtos e preços ───────────────────────────

const excluded = (col: string) => sql.raw(`excluded."${col}"`);

async function upsertProducts(db: DbOrTx, workspaceId: string, items: ProductOffer[], at: Date) {
  const unique = new Map(items.map((i) => [keyOf(i.platform, i.externalId), i]));
  const map = new Map<string, ProductRow>();
  if (unique.size === 0) return map;
  const rows = await db
    .insert(products)
    .values(
      [...unique.values()].map((i) => ({
        workspaceId,
        platform: i.platform,
        externalId: i.externalId,
        title: i.title,
        url: i.url,
        imageUrls: i.imageUrls,
        shopName: i.shopName,
        categoryIds: i.categoryIds,
        categoryName: i.categoryName,
        rating: i.rating,
        soldCount: i.soldCount,
        lastPrice: i.price,
        lastSeenAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: [products.workspaceId, products.platform, products.externalId],
      set: {
        title: excluded("title"),
        url: excluded("url"),
        imageUrls: excluded("image_urls"),
        shopName: excluded("shop_name"),
        categoryIds: excluded("category_ids"),
        categoryName: excluded("category_name"),
        rating: excluded("rating"),
        soldCount: excluded("sold_count"),
        lastPrice: excluded("last_price"),
        lastSeenAt: excluded("last_seen_at"),
        updatedAt: at,
      },
    })
    .returning();
  for (const r of rows) map.set(keyOf(r.platform, r.externalId), r);
  return map;
}

/** Registra preço observado; evita repetir o mesmo preço em menos de 1h. */
async function recordPrices(
  db: DbOrTx,
  entries: { productId: string; price: number; originalPrice: number | null }[],
  source: "search" | "lookup" | "validation",
  at: Date,
) {
  // Preço zero = produto indisponível (sem preço na página): não entra no histórico.
  entries = entries.filter((e) => e.price > 0);
  if (entries.length === 0) return;
  const ids = entries.map((e) => e.productId);
  const latest = await db
    .selectDistinctOn([pricePoints.productId], {
      productId: pricePoints.productId,
      price: pricePoints.price,
      capturedAt: pricePoints.capturedAt,
    })
    .from(pricePoints)
    .where(inArray(pricePoints.productId, ids))
    .orderBy(pricePoints.productId, desc(pricePoints.capturedAt));
  const last = new Map(latest.map((l) => [l.productId, l]));
  const toInsert = entries.filter((e) => {
    const l = last.get(e.productId);
    return (
      !l ||
      l.price !== e.price ||
      at.getTime() - l.capturedAt.getTime() >= PRICE_POINT_MIN_INTERVAL_MS
    );
  });
  if (toInsert.length) {
    await db.insert(pricePoints).values(toInsert.map((e) => ({ ...e, source, capturedAt: at })));
  }
}

// ── Busca ───────────────────────────────────────────────────────

export type Candidate = {
  product: ProductRow;
  item: ProductOffer;
  account: AccountRow;
  history: PriceSummary;
  flags: QualityFlag[];
  score: number;
};

type ParsedSearch = ReturnType<typeof SearchOffersInput.parse>;

/** Busca nas contas ativas, grava produtos e preços e calcula nota e sinais. */
export async function runSearch(
  deps: DbDeps,
  workspaceId: string,
  q: ParsedSearch,
  opts: { excludeExternalIds?: string[] } = {},
): Promise<{
  candidates: Candidate[];
  errors: { platform: string; message: string }[];
  hasMore: boolean;
}> {
  const all = await activeAccounts(deps.db, workspaceId, q.platforms as Platform[] | undefined);
  if (all.length === 0) {
    throw new AppError("NOT_CONFIGURED", "Nenhuma conta de afiliado conectada.", {
      hint: "Conecte uma conta em Afiliados no painel (dá para usar o modo simulado para testar).",
    });
  }
  // Contas sem busca ficam de fora: as ofertas delas vêm por link.
  const accounts = all.filter((a) => {
    try {
      return connectorFor(deps, a).capabilities.search;
    } catch {
      return true;
    }
  });
  if (accounts.length === 0) {
    throw new AppError("NOT_CONFIGURED", "Nenhuma conta conectada permite busca.", {
      hint: "Use “Colar link” em Ofertas para trazer produtos dessa loja.",
    });
  }
  const hasFilters =
    q.min_discount !== undefined ||
    q.price_min !== undefined ||
    q.price_max !== undefined ||
    q.min_rating !== undefined ||
    Boolean(opts.excludeExternalIds?.length);
  const fetchLimit = hasFilters ? 50 : q.limit;

  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const res = await connectorFor(deps, account).search({
          keyword: q.keyword,
          categoryId: q.category_id,
          sort: q.sort,
          limit: fetchLimit,
          page: q.page,
          minDiscount: q.min_discount,
          priceMin: q.price_min,
          priceMax: q.price_max,
          minRating: q.min_rating,
        });
        await recordAccountHealth(deps.db, account, null);
        return { account, items: res.items, hasMore: res.hasMore, error: null };
      } catch (err) {
        await recordAccountHealth(deps.db, account, err);
        return { account, items: [] as ProductOffer[], hasMore: false, error: providerError(err) };
      }
    }),
  );
  const errors = results
    .filter((r) => r.error)
    .map((r) => ({ platform: r.account.platform, message: r.error?.message ?? "erro" }));
  const firstError = results.find((r) => r.error)?.error;
  if (errors.length === results.length && firstError) throw firstError;

  const exclude = new Set(opts.excludeExternalIds ?? []);
  const pairs = results.flatMap((r) =>
    r.items
      .filter(
        (i) =>
          !exclude.has(i.externalId) &&
          (q.min_discount === undefined || (i.discountPct ?? 0) >= q.min_discount) &&
          (q.price_min === undefined || i.price >= q.price_min) &&
          (q.price_max === undefined || i.price <= q.price_max) &&
          (q.min_rating === undefined || (i.rating ?? 0) >= q.min_rating),
      )
      .map((item) => ({ item, account: r.account })),
  );

  const at = now(deps);
  const productMap = await upsertProducts(
    deps.db,
    workspaceId,
    pairs.map((p) => p.item),
    at,
  );
  const withProduct = pairs
    .map((p) => ({ ...p, product: productMap.get(keyOf(p.item.platform, p.item.externalId)) }))
    .filter((p): p is typeof p & { product: ProductRow } => Boolean(p.product));

  await recordPrices(
    deps.db,
    withProduct.map((p) => ({
      productId: p.product.id,
      price: p.item.price,
      originalPrice: p.item.originalPrice,
    })),
    "search",
    at,
  );
  const histories = await priceSummaries(
    deps.db,
    withProduct.map((p) => p.product.id),
    at,
  );
  const niches = await workspaceNiches(deps.db, workspaceId);

  const candidates: Candidate[] = withProduct.map((p) => {
    const history = summaryOrEmpty(histories.get(p.product.id));
    const flags = qualityFlags(p.item, history);
    return { ...p, history, flags, score: offerScore(p.item, history, flags, niches) };
  });
  if (q.sort === "relevance") candidates.sort((a, b) => b.score - a.score);
  if (q.sort === "discount") {
    candidates.sort((a, b) => (b.item.discountPct ?? 0) - (a.item.discountPct ?? 0));
  }
  const hasMore = candidates.length > q.limit || results.some((r) => r.hasMore);
  return { candidates: candidates.slice(0, q.limit), errors, hasMore };
}

async function latestOfferByProduct(db: DbOrTx, productIds: string[]) {
  const map = new Map<string, OfferRow>();
  if (productIds.length === 0) return map;
  const rows = await db
    .selectDistinctOn([offers.productId])
    .from(offers)
    .where(inArray(offers.productId, productIds))
    .orderBy(offers.productId, desc(offers.createdAt));
  for (const r of rows) map.set(r.productId, r);
  return map;
}

const historyOut = (h: PriceSummary) => ({
  min_30d: h.min_30d,
  median_30d: h.median_30d,
  min_90d: h.min_90d,
  points: h.points,
});

function toCandidate(c: Candidate, existing: OfferRow | undefined): OfferCandidate {
  return {
    product_id: c.product.id,
    offer_id: existing?.id ?? null,
    offer_status: existing?.status ?? null,
    platform: c.item.platform,
    external_id: c.item.externalId,
    title: c.item.title,
    image_url: c.item.imageUrls[0] ?? null,
    url: c.item.url,
    price: c.item.price,
    original_price: c.item.originalPrice,
    discount_pct: c.item.discountPct,
    commission_rate: c.item.commissionRate,
    commission_value: c.item.commissionValue,
    rating: c.item.rating,
    sold_count: c.item.soldCount,
    shop_name: c.item.shopName,
    category: c.item.categoryName,
    score: c.score,
    flags: c.flags,
    price_history: historyOut(c.history),
  };
}

export async function searchOffers(ctx: Ctx, raw: SearchOffersInput): Promise<SearchOffersResult> {
  requireScope(ctx.actor, "offers:read");
  const q = SearchOffersInput.parse(raw);
  const { candidates, errors, hasMore } = await runSearch(ctx, ctx.actor.workspaceId, q);
  const existing = await latestOfferByProduct(
    ctx.db,
    candidates.map((c) => c.product.id),
  );
  return {
    items: candidates.map((c) => toCandidate(c, existing.get(c.product.id))),
    errors,
    has_more: hasMore,
  };
}

// ── Curadoria ───────────────────────────────────────────────────

function toOffer(o: OfferRow, p: ProductRow): Offer {
  return {
    id: o.id,
    status: o.status,
    origin: o.affiliateAccountId ? "platform" : "link",
    product_id: p.id,
    platform: p.platform,
    title: p.title,
    image_url: p.imageUrls[0] ?? null,
    url: p.url,
    affiliate_url: o.affiliateUrl,
    price: o.price,
    original_price: o.originalPrice,
    discount_pct: o.discountPct,
    coupon_code: o.couponCode,
    coupon_description: o.couponDescription,
    commission_rate: o.commissionRate,
    commission_value: o.commissionValue,
    rating: p.rating,
    sold_count: p.soldCount,
    category: p.categoryName,
    score: o.score,
    flags: o.qualityFlags as Offer["flags"],
    notes: o.notes,
    reject_reason: o.rejectReason,
    valid_until: o.validUntil?.toISOString() ?? null,
    last_validated_at: o.lastValidatedAt?.toISOString() ?? null,
    pix_price: o.priceDetails?.pix_price ?? null,
    installments: o.priceDetails?.installments ?? null,
    copy: o.copy ?? null,
    created_at: o.createdAt.toISOString(),
  };
}

/** Preço no Pix e parcelamento do item, no formato guardado na oferta. */
export function priceDetailsOf(item: Pick<ProductOffer, "pixPrice" | "installments">) {
  const pix = item.pixPrice ?? null;
  const inst = item.installments ?? null;
  if (!pix && !inst) return null;
  return {
    pix_price: pix,
    installments: inst
      ? { count: inst.count, value: inst.value, interest_free: inst.interestFree }
      : null,
  };
}

async function loadProduct(db: DbOrTx, workspaceId: string, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
  if (!row) {
    throw new AppError("NOT_FOUND", "Produto não encontrado.", {
      hint: "Use o product_id retornado por search_offers.",
    });
  }
  return row;
}

export async function loadOffer(db: DbOrTx, workspaceId: string, offerId: string) {
  const [row] = await db
    .select({ offer: offers, product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.id, offerId), eq(offers.workspaceId, workspaceId)));
  if (!row)
    throw new AppError("NOT_FOUND", "Oferta não encontrada.", { details: { offer_id: offerId } });
  return row;
}

async function accountForPlatform(db: DbOrTx, workspaceId: string, platform: Platform) {
  const [account] = await activeAccounts(db, workspaceId, [platform]);
  if (!account) {
    throw new AppError("NOT_CONFIGURED", `Nenhuma conta ${platform} ativa.`, {
      hint: "Conecte ou reative a conta em Afiliados.",
    });
  }
  return account;
}

/** Valores da oferta a partir do item atual da plataforma. */
function offerValues(item: ProductOffer, score: number, flags: QualityFlag[]) {
  return {
    price: item.price,
    originalPrice: item.originalPrice,
    discountPct: item.discountPct,
    commissionRate: item.commissionRate,
    commissionValue: item.commissionValue,
    affiliateUrl: item.affiliateUrl,
    validUntil: item.validUntil ? new Date(item.validUntil) : null,
    priceDetails: priceDetailsOf(item),
    score,
    qualityFlags: flags,
  };
}

/** Consulta o produto agora na plataforma, grava o preço e calcula nota e sinais. */
async function freshCandidate(
  deps: DbDeps,
  workspaceId: string,
  product: ProductRow,
  couponCode?: string | null,
) {
  const account = await accountForPlatform(deps.db, workspaceId, product.platform);
  let item: ProductOffer | null;
  try {
    item = await connectorFor(deps, account).lookup(product.externalId);
  } catch (err) {
    await recordAccountHealth(deps.db, account, err);
    throw providerError(err);
  }
  const at = now(deps);
  if (item) {
    await recordPrices(
      deps.db,
      [{ productId: product.id, price: item.price, originalPrice: item.originalPrice }],
      "lookup",
      at,
    );
  }
  const history = summaryOrEmpty((await priceSummaries(deps.db, [product.id], at)).get(product.id));
  if (!item) return { account, item: null, history, flags: [] as QualityFlag[], score: 0 };
  const flags = qualityFlags({ ...item, couponCode }, history);
  const niches = await workspaceNiches(deps.db, workspaceId);
  return { account, item, history, flags, score: offerScore(item, history, flags, niches) };
}

/** Salva um produto na curadoria (aprovado por padrão). Consulta o preço atual antes. */
export async function saveOffer(ctx: Ctx, raw: SaveOfferInput, opts: MutationOptions = {}) {
  const input = SaveOfferInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.save",
    scope: "offers:write",
    input,
    opts,
    target: (i) => ({ type: "product", id: i.product_id }),
    preview: async (c, i) => {
      const product = await loadProduct(c.db, wsId, i.product_id);
      const fresh = await freshCandidate(c, wsId, product, i.coupon_code);
      if (!fresh.item) {
        throw new AppError("CONFLICT", "Produto não encontrado na plataforma.", {
          hint: "O anúncio pode ter sido removido. Rode find_similar_offers para achar outro.",
        });
      }
      if (!fresh.item.available) {
        throw new AppError("CONFLICT", "Produto sem estoque no momento.", {
          hint: "Rode find_similar_offers para achar uma alternativa.",
        });
      }
      const existing = (await latestOfferByProduct(c.db, [product.id])).get(product.id);
      return {
        product_id: product.id,
        title: product.title,
        account_id: fresh.account.id,
        item: fresh.item,
        score: fresh.score,
        flags: fresh.flags,
        // Reaproveita a última oferta do produto (inclusive rejeitada ou expirada): sem duplicar.
        updates_offer_id: existing?.id ?? null,
      };
    },
    execute: async (tx, i, p) => {
      const values = {
        ...offerValues(p.item, p.score, p.flags),
        status: i.status,
        couponCode: i.coupon_code ?? null,
        couponDescription: i.coupon_description ?? null,
        notes: i.notes ?? null,
        rejectReason: null,
        lastValidatedAt: now(ctx),
      };
      const [row] = p.updates_offer_id
        ? await tx.db
            .update(offers)
            .set({ ...values, affiliateAccountId: p.account_id })
            .where(eq(offers.id, p.updates_offer_id))
            .returning()
        : await tx.db
            .insert(offers)
            .values({
              ...values,
              workspaceId: wsId,
              productId: p.product_id,
              affiliateAccountId: p.account_id,
            })
            .returning();
      if (!row) throw new Error("Falha ao salvar oferta");
      return toOffer(row, await loadProduct(tx.db, wsId, p.product_id));
    },
  });
}

export async function setOfferStatus(
  ctx: Ctx,
  raw: UpdateOfferStatusInput,
  opts: MutationOptions = {},
) {
  const input = UpdateOfferStatusInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: input.status === "approved" ? "offers.approve" : "offers.reject",
    scope: "offers:write",
    input,
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer } = await loadOffer(c.db, wsId, i.offer_id);
      if (i.status === "approved" && offer.status === "expired") {
        throw new AppError("CONFLICT", "A oferta expirou e não pode ser aprovada.", {
          hint: "Rode validate_offer para conferir o preço atual ou find_similar_offers.",
        });
      }
      return { from: offer.status, to: i.status };
    },
    execute: async (tx, i) => {
      const [row] = await tx.db
        .update(offers)
        .set({
          status: i.status,
          rejectReason: i.status === "rejected" ? (i.reason ?? null) : null,
        })
        .where(and(eq(offers.id, i.offer_id), eq(offers.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Oferta não encontrada.");
      return toOffer(row, await loadProduct(tx.db, wsId, row.productId));
    },
  });
}

/**
 * Corrige os preços de uma oferta com o que a loja mostra (ex.: agente com navegador lê o Pix na
 * página da Shopee e vê que o "De" do feed é falso). Vale até o preço da loja mudar.
 */
export async function updateOfferPrices(
  ctx: Ctx,
  offerId: string,
  raw: UpdateOfferPricesInput,
  opts: MutationOptions = {},
) {
  const input = UpdateOfferPricesInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.update_prices",
    scope: "offers:write",
    input: { offer_id: offerId, ...input },
    opts,
    target: () => ({ type: "offer", id: offerId }),
    preview: async (c) => {
      const { offer } = await loadOffer(c.db, wsId, offerId);
      const price = input.price ?? offer.price;
      const original =
        input.original_price === undefined ? offer.originalPrice : input.original_price;
      const pix =
        input.pix_price === undefined ? (offer.priceDetails?.pix_price ?? null) : input.pix_price;
      const inst =
        input.installments === undefined
          ? (offer.priceDetails?.installments ?? null)
          : input.installments;
      const originalOk = original && original > price ? original : null;
      return {
        price,
        originalPrice: originalOk,
        discountPct: originalOk ? Math.round((1 - price / originalOk) * 100) : null,
        priceDetails: {
          pix_price: pix && pix < price ? pix : null,
          installments: inst
            ? { count: inst.count, value: inst.value, interest_free: inst.interest_free ?? true }
            : null,
          manual: true,
        },
        qualityFlags: originalOk
          ? offer.qualityFlags
          : offer.qualityFlags.filter((f) => f !== "fake_discount"),
      };
    },
    execute: async (tx, _i, p) => {
      const [row] = await tx.db
        .update(offers)
        .set(p)
        .where(and(eq(offers.id, offerId), eq(offers.workspaceId, wsId)))
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Oferta não encontrada.");
      if (p.price) {
        await recordPrices(
          tx.db,
          [{ productId: row.productId, price: p.price, originalPrice: p.originalPrice }],
          "lookup",
          now(ctx),
        );
      }
      return toOffer(row, await loadProduct(tx.db, wsId, row.productId));
    },
  });
}

export async function listOffers(ctx: Ctx, raw: ListOffersQuery = {}) {
  requireScope(ctx.actor, "offers:read");
  const q = ListOffersQuery.parse(raw);
  const conds = [eq(offers.workspaceId, ctx.actor.workspaceId)];
  if (q.status) conds.push(eq(offers.status, q.status));
  if (q.platform) conds.push(eq(products.platform, q.platform));
  if (q.min_score !== undefined) conds.push(gte(offers.score, q.min_score));
  if (q.q) conds.push(ilike(products.title, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`));
  if (q.sent) {
    const wasSent = sql`exists (select 1 from ${posts} where ${posts.offerId} = ${offers.id} and ${posts.status} = 'sent')`;
    conds.push(q.sent === "yes" ? wasSent : sql`not ${wasSent}`);
  }
  if (q.cursor) {
    const c = olderThan(q.cursor, offers.createdAt, offers.id);
    if (c) conds.push(c);
  }
  const rows = await ctx.db
    .select({ offer: offers, product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(...conds))
    .orderBy(desc(offers.createdAt), desc(offers.id))
    .limit(q.limit + 1);
  const sent = await sentSummaries(
    ctx.db,
    rows.map((r) => r.offer.id),
  );
  return toPage(
    rows.map((r) => ({ ...r, id: r.offer.id, createdAt: r.offer.createdAt })),
    q.limit,
    (r) => ({
      ...toOffer(r.offer, r.product),
      sent: sent.get(r.offer.id) ?? { posts: 0, channels: 0, last_at: null },
    }),
  );
}

/** Quantas mensagens, em quantos canais e quando foi o último envio de cada oferta. */
async function sentSummaries(db: DbOrTx, offerIds: string[]) {
  const map = new Map<string, NonNullable<Offer["sent"]>>();
  if (offerIds.length === 0) return map;
  const rows = await db
    .select({
      offerId: posts.offerId,
      posts: sql<number>`count(*)::int`,
      channels: sql<number>`count(distinct ${posts.channelId})::int`,
      last: sql<Date | string | null>`max(${posts.sentAt})`,
    })
    .from(posts)
    .where(and(inArray(posts.offerId, offerIds), eq(posts.status, "sent")))
    .groupBy(posts.offerId);
  for (const r of rows) {
    if (!r.offerId) continue;
    map.set(r.offerId, {
      posts: r.posts,
      channels: r.channels,
      last_at: r.last ? new Date(r.last).toISOString() : null,
    });
  }
  return map;
}

export async function getOffer(ctx: Ctx, offerId: string): Promise<OfferDetail> {
  requireScope(ctx.actor, "offers:read");
  const wsId = ctx.actor.workspaceId;
  const { offer, product } = await loadOffer(ctx.db, wsId, offerId);
  const at = now(ctx);
  const history = summaryOrEmpty((await priceSummaries(ctx.db, [product.id], at)).get(product.id));
  const [ws] = await ctx.db
    .select({ tz: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, wsId));
  const day = sql<string>`to_char(${pricePoints.capturedAt} at time zone ${ws?.tz ?? "America/Sao_Paulo"}, 'YYYY-MM-DD')`;
  const series = await ctx.db
    .select({
      date: day,
      min: sql<string>`min(${pricePoints.price})`,
      max: sql<string>`max(${pricePoints.price})`,
    })
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.productId, product.id),
        gte(pricePoints.capturedAt, new Date(at.getTime() - 90 * 86_400_000)),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const validations = await ctx.db
    .select()
    .from(offerValidations)
    .where(eq(offerValidations.offerId, offer.id))
    .orderBy(desc(offerValidations.checkedAt))
    .limit(10);
  return {
    ...toOffer(offer, product),
    price_history: {
      ...historyOut(history),
      series: series.map((s) => ({ date: s.date, min: Number(s.min), max: Number(s.max) })),
    },
    validations: validations.map((v) => ({
      checked_at: v.checkedAt.toISOString(),
      ok: v.ok,
      price_was: v.priceWas,
      price_now: v.priceNow,
      reason: v.reason,
    })),
  };
}

// ── Validação ───────────────────────────────────────────────────

/** Confere preço e estoque agora. Não grava nada. */
async function checkOffer(deps: DbDeps, workspaceId: string, offer: OfferRow, product: ProductRow) {
  if (!offer.affiliateAccountId) return checkLinkOffer(deps, offer);
  const fresh = await freshCandidate(deps, workspaceId, product, offer.couponCode);
  const priceNow = fresh.item?.price ?? null;
  const available = fresh.item ? fresh.item.available : null;
  const changePct =
    priceNow === null ? null : Math.round(((priceNow - offer.price) / offer.price) * 1000) / 10;
  let reason: string | null = null;
  if (!fresh.item) reason = "Produto não encontrado na plataforma.";
  else if (!fresh.item.available) reason = "Produto sem estoque.";
  else if (priceNow !== null && priceNow > offer.price * (1 + PRICE_TOLERANCE)) {
    reason = `Preço subiu ${changePct}% (de ${offer.price.toFixed(2)} para ${priceNow.toFixed(2)}).`;
  } else if (offer.validUntil && offer.validUntil <= now(deps)) {
    reason = "Período da oferta encerrado.";
  }
  return { fresh, priceNow, available, changePct, ok: reason === null, reason };
}

type Check = Awaited<ReturnType<typeof checkOffer>>;

async function applyCheck(db: DbOrTx, offer: OfferRow, check: Check, at: Date) {
  await db.insert(offerValidations).values({
    offerId: offer.id,
    ok: check.ok,
    priceWas: offer.price,
    priceNow: check.priceNow,
    available: check.available,
    reason: check.reason,
    checkedAt: at,
  });
  const status = check.ok ? offer.status : "expired";
  const item = check.fresh.item;
  const values = check.ok && item ? offerValues(item, check.fresh.score, check.fresh.flags) : {};
  // Preços corrigidos à mão (Pix lido na página, "De" falso removido) valem enquanto o preço não mudar.
  if (check.ok && item && offer.priceDetails?.manual && item.price === offer.price) {
    Object.assign(values, {
      originalPrice: offer.originalPrice,
      discountPct: offer.discountPct,
      priceDetails: offer.priceDetails,
      qualityFlags: offer.originalPrice
        ? check.fresh.flags
        : check.fresh.flags.filter((f) => f !== "fake_discount"),
    });
  }
  await db
    .update(offers)
    .set({ status, lastValidatedAt: at, ...values })
    .where(eq(offers.id, offer.id));
  if (!check.ok && offer.status !== "expired") {
    await emitEvent(db, offer.workspaceId, "offer.expired", {
      offer_id: offer.id,
      reason: check.reason,
    });
  }
  return status;
}

const toValidateResult = (
  offer: OfferRow,
  check: Check,
  status: Offer["status"],
): ValidateOfferResult => ({
  offer_id: offer.id,
  ok: check.ok,
  status,
  price_was: offer.price,
  price_now: check.priceNow,
  change_pct: check.changePct,
  available: check.available,
  reason: check.reason,
});

/** Revalida preço, estoque e validade. Se piorou além da tolerância (5%), a oferta expira. */
export async function validateOffer(ctx: Ctx, offerId: string, opts: MutationOptions = {}) {
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.validate",
    scope: "offers:write",
    input: { offer_id: offerId },
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer, product } = await loadOffer(c.db, wsId, i.offer_id);
      const check = await checkOffer(c, wsId, offer, product);
      return { offer, check };
    },
    execute: async (tx, _i, p) => {
      const status = await applyCheck(tx.db, p.offer, p.check, now(ctx));
      return toValidateResult(p.offer, p.check, status);
    },
  }).then((res) =>
    res.status === "dry_run"
      ? {
          status: "dry_run" as const,
          preview: toValidateResult(
            res.preview.offer,
            res.preview.check,
            res.preview.check.ok ? res.preview.offer.status : "expired",
          ),
        }
      : res,
  );
}

/** Validação feita por processos do sistema (worker, publicação). */
export async function validateOfferAsSystem(deps: DbDeps, offer: OfferRow, product: ProductRow) {
  const check = await checkOffer(deps, offer.workspaceId, offer, product);
  const status = await applyCheck(deps.db, offer, check, now(deps));
  return toValidateResult(offer, check, status);
}

// ── Similares ───────────────────────────────────────────────────

const STOPWORDS = new Set(["com", "para", "sem", "kit", "de", "da", "do", "e", "em"]);

export async function findSimilarOffers(ctx: Ctx, raw: FindSimilarInput) {
  requireScope(ctx.actor, "offers:read");
  const input = FindSimilarInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  let product: ProductRow;
  if (input.offer_id) product = (await loadOffer(ctx.db, wsId, input.offer_id)).product;
  else if (input.product_id) product = await loadProduct(ctx.db, wsId, input.product_id);
  else throw new AppError("VALIDATION_ERROR", "Informe offer_id ou product_id.");

  const words = product.title
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/\d/.test(w) && !STOPWORDS.has(w.toLowerCase()));
  const keyword = words.slice(0, 2).join(" ");
  const base = product.lastPrice ?? 0;
  const inRange = (c: Candidate) =>
    !base || (c.item.price >= base * 0.5 && c.item.price <= base * 1.5);

  const attempt = async (q: Partial<ParsedSearch>) =>
    (
      await runSearch(
        ctx,
        wsId,
        SearchOffersInput.parse({ ...q, limit: 50, platforms: [product.platform] }),
        { excludeExternalIds: [product.externalId] },
      )
    ).candidates.filter(inRange);

  let found = keyword ? await attempt({ keyword }) : [];
  if (found.length === 0 && product.categoryIds[0]) {
    found = await attempt({ category_id: product.categoryIds[0] });
  }
  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, input.limit);
  const existing = await latestOfferByProduct(
    ctx.db,
    top.map((c) => c.product.id),
  );
  return {
    reference: { product_id: product.id, title: product.title, price: product.lastPrice },
    items: top.map((c) => toCandidate(c, existing.get(c.product.id))),
  };
}

// ── Link pronto para divulgar ───────────────────────────────────

/**
 * Gera o link de afiliado com sub-ids e o envolve num link rastreado próprio.
 * O slug do link rastreado vai como sub-id: assim a comissão volta para o link, canal e origem.
 */
export async function createOfferLink(
  ctx: Ctx,
  raw: CreateOfferLinkInput,
  opts: MutationOptions = {},
) {
  const input = CreateOfferLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  const res = await runMutation(ctx, {
    action: "offers.create_link",
    scope: "links:write",
    input,
    opts,
    target: (i) => ({ type: "offer", id: i.offer_id }),
    preview: async (c, i) => {
      const { offer, product } = await loadOffer(c.db, wsId, i.offer_id);
      if (offer.status === "rejected" || offer.status === "expired") {
        throw new AppError(
          "CONFLICT",
          `Oferta ${offer.status === "expired" ? "expirada" : "rejeitada"}.`,
          {
            hint: "Use uma oferta aprovada. Para expiradas, rode find_similar_offers.",
          },
        );
      }
      if (i.channel_id) await getChannelRow(c.db, wsId, i.channel_id);
      const slug = await freeSlug(c.db);
      const subIds = [i.source, slug, i.campaign ?? ""].map(sanitizeSubId).filter(Boolean);
      return {
        offer_id: offer.id,
        product_url: product.url,
        title: product.title,
        fallback_affiliate_url: offer.affiliateUrl,
        account_id: offer.affiliateAccountId,
        platform: product.platform,
        slug,
        short_url: shortUrl(c, slug),
        sub_ids: subIds,
      };
    },
    execute: async (tx, i, p) => {
      const accounts = await activeAccounts(tx.db, wsId);
      let account = accounts.find((a) => a.id === p.account_id);
      // Oferta por link: se o destino é link comum da loja ou um an_redir (aceita sub-ids),
      // remonta com uma conta que gere link de comissão, marcando a origem deste link curto.
      const fallback = p.fallback_affiliate_url;
      if (
        !p.account_id &&
        (!fallback || !looksLikeAffiliateUrl(fallback) || fallback.includes("/an_redir?"))
      ) {
        account = accounts.find(
          (a) => a.platform === p.platform && (a.mode === "live" || a.mode === "feed"),
        );
      }
      let affiliateUrl = p.fallback_affiliate_url;
      if (account) {
        const connector = connectorFor(ctx, account);
        if (connector.capabilities.linkGeneration) {
          try {
            affiliateUrl = await connector.generateLink(p.product_url, p.sub_ids);
          } catch (err) {
            throw providerError(err);
          }
        }
      }
      if (!affiliateUrl) {
        throw new AppError("PROVIDER_ERROR", "Não foi possível gerar o link de afiliado.", {
          hint: "Confira se a conta de afiliado está ativa.",
        });
      }
      const row = await insertTrackedLink(tx.db, {
        workspaceId: wsId,
        slug: p.slug,
        destinationUrl: affiliateUrl,
        title: p.title,
        source: i.source,
        campaign: i.campaign ?? null,
        channelId: i.channel_id ?? null,
        offerId: p.offer_id,
        subIds: Object.fromEntries(p.sub_ids.map((s, idx) => [`sub${idx + 1}`, s])),
      });
      const short = shortUrl(ctx, row.slug);
      const out: OfferLink = {
        offer_id: p.offer_id,
        affiliate_url: affiliateUrl,
        link_id: row.id,
        short_url: short,
        share_url: shareUrlFor(affiliateUrl, short),
        sub_ids: p.sub_ids,
      };
      return out;
    },
  });
  if (res.status === "done") await ctx.cache.del(`link:${res.result.short_url.split("/").pop()}`);
  return res;
}

export { toOffer };

/**
 * Link que vai na mensagem. Lojas que proíbem encurtador próprio (Amazon) recebem o link de
 * afiliado direto; nelas, os cliques ficam no relatório da loja.
 */
export function shareUrlFor(affiliateUrl: string, shortLink: string) {
  const platform = platformOfUrl(affiliateUrl);
  return platform && DIRECT_LINK_PLATFORMS.has(platform) ? affiliateUrl : shortLink;
}

// ── Oferta por link ─────────────────────────────────────────────

/**
 * Oferta criada por link colado: sem API da loja não dá para conferir preço e estoque.
 * Só expira pelo prazo (valid_until).
 */
function checkLinkOffer(deps: Pick<Deps, "now">, offer: OfferRow) {
  const ended = offer.validUntil !== null && offer.validUntil <= now(deps);
  return {
    fresh: { item: null as ProductOffer | null, score: 0, flags: [] as QualityFlag[] },
    priceNow: null,
    available: null,
    changePct: null,
    ok: !ended,
    reason: ended ? "Período da oferta encerrado." : null,
  };
}

/** Produto sem id reconhecível no link: id estável derivado do endereço. */
function linkId(url: string) {
  const u = new URL(url);
  const hash = createHash("sha256").update(`${u.hostname}${u.pathname}`).digest("hex");
  return `link:${hash.slice(0, 16)}`;
}

type LinkData = {
  platform: Platform;
  externalId: string;
  productUrl: string;
  affiliateUrl: string;
  isAffiliate: boolean;
  source: "platform" | "page";
  item: ProductOffer | null;
  liveAccount: AccountRow | null;
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  originalPrice: number | null;
  shopName: string | null;
  pixPrice: number | null;
  installments: ProductOffer["installments"];
};

/** Abre o link (seguindo links curtos), descobre loja e produto e lê o que der da página. */
async function readLink(deps: Deps, workspaceId: string, raw: string): Promise<LinkData> {
  const pasted = raw.trim();
  if (!platformOfUrl(pasted)) {
    throw new AppError("VALIDATION_ERROR", "Link de loja não reconhecido.", {
      hint: "Aceita links da Shopee, Mercado Livre, Amazon e Magalu.",
    });
  }
  let page = await deps.fetchPage(pasted).catch(() => null);
  // Link curto que para numa página intermediária (link.amazon → amzlinks.in): segue o link de dentro.
  if (page && !productIdOfUrl(platformOfUrl(page.url) ?? "amazon", page.url)) {
    const inner = embeddedStoreUrl(page.html);
    if (inner) {
      page = (await deps.fetchPage(inner).catch(() => null)) ?? {
        url: inner,
        status: 599,
        html: "",
      };
    }
  }
  const finalUrl = page && platformOfUrl(page.url) ? page.url : pasted;
  const platform = (platformOfUrl(finalUrl) ?? platformOfUrl(pasted)) as Platform;
  const final = new URL(finalUrl);
  const foundId = productIdOfUrl(platform, finalUrl) ?? productIdOfUrl(platform, pasted);

  const data =
    page && page.status < 400
      ? parseProductPage(page.html, finalUrl)
      : { title: null, imageUrl: null, price: null, originalPrice: null, shopName: null };
  let amazon: ReturnType<typeof parseAmazonPage> | null = null;
  if (platform === "amazon" && page && page.status < 400) {
    // Leitor próprio da Amazon: foto em alta (a og:image tem a nota por cima) e preço "De:".
    amazon = parseAmazonPage(page.html);
    Object.assign(data, {
      title: amazon.title ?? data.title,
      imageUrl: amazon.imageUrl ?? data.imageUrl,
      price: amazon.price ?? data.price,
      originalPrice: amazon.originalPrice ?? data.originalPrice,
    });
  }
  const out: LinkData = {
    platform,
    externalId: foundId ?? linkId(finalUrl),
    productUrl: `${final.origin}${final.pathname}`,
    affiliateUrl: pasted,
    isAffiliate: looksLikeAffiliateUrl(pasted),
    source: "page",
    item: null,
    liveAccount: null,
    title:
      (isGenericTitle(data.title) ? null : data.title) ??
      titleFromUrl(finalUrl) ??
      titleFromUrl(pasted),
    imageUrl: data.imageUrl,
    price: data.price,
    originalPrice: data.originalPrice,
    shopName: data.shopName,
    pixPrice: amazon?.pixPrice ?? null,
    installments: amazon?.installments ?? null,
  };

  // Com conta real ou feed da loja, os dados vêm dela (e o preço é conferido antes de cada envio).
  const live = (await activeAccounts(deps.db, workspaceId, [platform])).find(
    (a) => a.mode === "live" || a.mode === "feed",
  );
  // Na Amazon o link é montado aqui com a sua tag, então sempre remonta (o colado pode ter a
  // tag de outra pessoa).
  if (live && (!out.isAffiliate || DIRECT_LINK_PLATFORMS.has(platform))) {
    // Link comum da loja: vira link de comissão (os links curtos ganham sub-ids depois).
    const link = await connectorFor(deps, live)
      .generateLink(out.productUrl, [])
      .catch(() => null);
    if (link) Object.assign(out, { affiliateUrl: link, isAffiliate: true });
  }
  if (live && foundId) {
    const item = await connectorFor(deps, live)
      .lookup(foundId)
      .catch(() => null);
    if (item) {
      Object.assign(out, {
        source: "platform",
        item,
        liveAccount: live,
        title: item.title,
        imageUrl: item.imageUrls[0] ?? out.imageUrl,
        price: item.price,
        originalPrice: item.originalPrice,
        shopName: item.shopName ?? out.shopName,
        productUrl: item.url || out.productUrl,
        pixPrice: item.pixPrice ?? out.pixPrice,
        installments: item.installments ?? out.installments,
      });
    }
  }
  return out;
}

async function openOfferFor(
  db: DbOrTx,
  workspaceId: string,
  platform: Platform,
  externalId: string,
) {
  const [row] = await db
    .select({ id: offers.id })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(
      and(
        eq(products.workspaceId, workspaceId),
        eq(products.platform, platform),
        eq(products.externalId, externalId),
        inArray(offers.status, ["new", "approved"]),
      ),
    )
    .orderBy(desc(offers.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Abre um link de produto e devolve o que foi encontrado (não grava nada). */
export async function previewOfferFromLink(
  ctx: Ctx,
  raw: OfferFromLinkInput,
): Promise<OfferLinkPreview> {
  requireScope(ctx.actor, "offers:write");
  const input = OfferFromLinkInput.parse(raw);
  const d = await readLink(ctx, ctx.actor.workspaceId, input.url);
  const missing: OfferLinkPreview["missing"] = [];
  if (!d.title) missing.push("title");
  if (!d.imageUrl) missing.push("image");
  if (!d.price) missing.push("price");
  return {
    platform: d.platform,
    external_id: d.externalId,
    product_url: d.productUrl,
    affiliate_url: d.affiliateUrl,
    is_affiliate_link: d.isAffiliate || d.source === "platform",
    source: d.source,
    title: d.title,
    image_url: d.imageUrl,
    price: d.price,
    original_price: d.originalPrice,
    pix_price: d.pixPrice,
    installments: d.installments
      ? {
          count: d.installments.count,
          value: d.installments.value,
          interest_free: d.installments.interestFree,
        }
      : null,
    shop_name: d.shopName,
    missing,
    existing_offer_id: await openOfferFor(ctx.db, ctx.actor.workspaceId, d.platform, d.externalId),
  };
}

/**
 * Cria (ou atualiza) uma oferta a partir de um link colado, com os dados conferidos pelo usuário.
 * O link colado vira o destino dos links curtos. Com conta real da loja, usa a API dela.
 */
export async function importOfferFromLink(
  ctx: Ctx,
  raw: ImportOfferFromLinkInput,
  opts: MutationOptions = {},
) {
  const input = ImportOfferFromLinkInput.parse(raw);
  const wsId = ctx.actor.workspaceId;
  return runMutation(ctx, {
    action: "offers.import_link",
    scope: "offers:write",
    input,
    opts,
    target: (i) => ({ type: "link", id: i.url.slice(0, 200) }),
    preview: async (c, i) => {
      const d = await readLink(ctx, wsId, i.url);
      // Link de afiliado que não revela o produto (meli.la): a página informada dá o id.
      if (i.product_url) {
        const id =
          platformOfUrl(i.product_url) === d.platform
            ? productIdOfUrl(d.platform, i.product_url)
            : null;
        if (!id) {
          throw new AppError(
            "VALIDATION_ERROR",
            "A página do produto não é da mesma loja do link.",
            { hint: "Envie em product_url o endereço da página do produto (ex.: .../p/MLB123)." },
          );
        }
        const page = new URL(i.product_url);
        Object.assign(d, { externalId: id, productUrl: `${page.origin}${page.pathname}` });
      }
      const original = i.original_price && i.original_price > i.price ? i.original_price : null;
      const item: ProductOffer = {
        platform: d.platform,
        externalId: d.externalId,
        title: i.title,
        url: d.productUrl,
        affiliateUrl: d.isAffiliate || !d.item?.affiliateUrl ? d.affiliateUrl : d.item.affiliateUrl,
        imageUrls: i.image_url ? [i.image_url] : (d.item?.imageUrls ?? []),
        price: i.price,
        originalPrice: original,
        discountPct: original ? Math.round((1 - i.price / original) * 100) : null,
        commissionRate: d.item?.commissionRate ?? null,
        commissionValue: d.item?.commissionValue ?? null,
        rating: d.item?.rating ?? null,
        soldCount: d.item?.soldCount ?? null,
        shopName: d.shopName,
        categoryIds: d.item?.categoryIds ?? [],
        categoryName: d.item?.categoryName ?? null,
        available: true,
        validUntil: null,
        // Informado por quem cola (ex.: agente que viu a página do Mercado Livre) ou lido da
        // página; o lido só vale se o preço conferido é o mesmo que a loja mostrou.
        pixPrice:
          i.pix_price !== undefined
            ? i.pix_price && i.pix_price < i.price
              ? i.pix_price
              : null
            : d.price === i.price
              ? d.pixPrice
              : null,
        installments:
          i.installments !== undefined
            ? i.installments
              ? {
                  count: i.installments.count,
                  value: i.installments.value,
                  interestFree: i.installments.interest_free,
                }
              : null
            : d.price === i.price
              ? d.installments
              : null,
      };
      return {
        item,
        account_id: d.liveAccount?.id ?? null,
        source: d.source,
        updates_offer_id: await openOfferFor(c.db, wsId, d.platform, d.externalId),
      };
    },
    execute: async (tx, i, p) => {
      const at = now(ctx);
      const productMap = await upsertProducts(tx.db, wsId, [p.item], at);
      const product = productMap.get(keyOf(p.item.platform, p.item.externalId));
      if (!product) throw new Error("Falha ao salvar produto");
      await recordPrices(
        tx.db,
        [{ productId: product.id, price: p.item.price, originalPrice: p.item.originalPrice }],
        "lookup",
        at,
      );
      const history = summaryOrEmpty(
        (await priceSummaries(tx.db, [product.id], at)).get(product.id),
      );
      const flags = qualityFlags({ ...p.item, couponCode: i.coupon_code }, history);
      const score = offerScore(p.item, history, flags, await workspaceNiches(tx.db, wsId));
      const values = {
        ...offerValues(p.item, score, flags),
        affiliateAccountId: p.account_id,
        status: i.status,
        couponCode: i.coupon_code ?? null,
        couponDescription: i.coupon_description ?? null,
        notes: i.notes ?? null,
        rejectReason: null,
        lastValidatedAt: at,
      };
      const [row] = p.updates_offer_id
        ? await tx.db
            .update(offers)
            .set(values)
            .where(eq(offers.id, p.updates_offer_id))
            .returning()
        : await tx.db
            .insert(offers)
            .values({ ...values, workspaceId: wsId, productId: product.id })
            .returning();
      if (!row) throw new Error("Falha ao salvar oferta");
      return toOffer(row, product);
    },
  });
}

// ── Categorias ──────────────────────────────────────────────────

/** Categorias para filtrar a busca: do catálogo do feed (com contagem) ou do simulado. */
export async function listOfferCategories(ctx: Ctx): Promise<OfferCategory[]> {
  requireScope(ctx.actor, "offers:read");
  const out: OfferCategory[] = [];
  for (const account of await activeAccounts(ctx.db, ctx.actor.workspaceId)) {
    if (account.mode === "feed") {
      const rows = await ctx.db
        .select({
          id: sql<string>`${feedItems.categoryIds}[1]`,
          name: sql<string>`max(${feedItems.topCategory})`,
          count: sql<number>`count(*)::int`,
        })
        .from(feedItems)
        .where(
          and(
            eq(feedItems.accountId, account.id),
            sql`${feedItems.categoryIds}[1] is not null`,
            // Sem nome (importado antes da coluna existir): fica de fora até a próxima importação.
            sql`${feedItems.topCategory} is not null`,
          ),
        )
        .groupBy(sql`${feedItems.categoryIds}[1]`)
        .orderBy(desc(sql`count(*)`));
      for (const r of rows) {
        out.push({
          id: r.id,
          name: SHOPEE_CATEGORY_PT[r.name] ?? r.name ?? r.id,
          platform: account.platform,
          count: r.count,
        });
      }
    } else if (account.mode === "fake") {
      for (const c of FAKE_CATEGORIES) {
        out.push({ id: c.id, name: c.name, platform: account.platform, count: null });
      }
    }
  }
  // Mesma categoria em duas contas: soma.
  const merged = new Map<string, OfferCategory>();
  for (const c of out) {
    const key = `${c.platform}:${c.id}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, count: (prev.count ?? 0) + (c.count ?? 0) } : c);
  }
  return [...merged.values()];
}
