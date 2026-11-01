import {
  type AffiliateConnector,
  ConnectorError,
  isShopeeAffiliateId,
  type ProductOffer,
  readCsvRecords,
  type SearchQuery,
  type SearchResult,
  shopeeAffiliateLink,
  shopeeFeedItem,
} from "@ofertas/connectors";
import { affiliateAccounts, type DbOrTx, type FeedInfo, feedItems } from "@ofertas/db";
import { and, asc, desc, eq, gte, ilike, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { type Deps, now } from "./context";
import type { StreamOpener } from "./safe-fetch";

type AccountRow = typeof affiliateAccounts.$inferSelect;
type FeedRow = typeof feedItems.$inferSelect;

/** Só entram no catálogo produtos com este desconto (%) e sem avaliação ruim. */
export const FEED_MIN_DISCOUNT = 10;
export const FEED_MIN_RATING = 4;
/** Intervalo entre importações do feed (a Shopee atualiza o arquivo uma vez por dia). */
export const FEED_REFRESH_HOURS = 20;
const BATCH = 500;

export type FeedCredentials = { affiliate_id: string; feed_urls: string };

export const feedUrlsOf = (creds: Partial<FeedCredentials> | null) =>
  (creds?.feed_urls ?? "")
    .split(/\s+/)
    .map((u) => u.trim())
    .filter((u) => /^https:\/\//.test(u));

const toOffer = (r: FeedRow, affiliateId: string): ProductOffer => ({
  platform: "shopee",
  externalId: r.externalId,
  title: r.title,
  url: r.url,
  affiliateUrl: shopeeAffiliateLink(r.url, affiliateId),
  imageUrls: r.imageUrls,
  price: r.price,
  originalPrice: r.originalPrice,
  discountPct: r.discountPct,
  commissionRate: null,
  commissionValue: null,
  rating: r.rating,
  soldCount: null,
  shopName: r.shopName,
  categoryIds: r.categoryIds,
  categoryName: r.categoryName,
  available: true,
  validUntil: null,
});

/**
 * Conta em modo feed: busca e consulta no catálogo local importado do feed de produtos;
 * links de comissão montados com o ID de afiliado (com sub-ids).
 */
export class FeedConnector implements AffiliateConnector {
  readonly platform = "shopee" as const;
  readonly capabilities = {
    search: true,
    lookup: true,
    linkGeneration: true,
    subIds: 5,
    conversionsReport: false,
  };

  constructor(
    private readonly db: DbOrTx,
    private readonly accountId: string,
    private readonly creds: Partial<FeedCredentials> | null,
    private readonly open: StreamOpener,
  ) {}

  private get affiliateId() {
    return this.creds?.affiliate_id?.trim() ?? "";
  }

  async ping() {
    await pingFeed(this.creds, this.open);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const limit = Math.min(q.limit ?? 20, 50);
    const page = Math.max(q.page ?? 1, 1);
    const conds: SQL[] = [eq(feedItems.accountId, this.accountId)];
    for (const word of (q.keyword ?? "").split(/\s+/).filter((w) => w.length >= 2)) {
      conds.push(ilike(feedItems.title, `%${word}%`));
    }
    if (q.categoryId) conds.push(sql`${q.categoryId} = any(${feedItems.categoryIds})`);
    if (q.minDiscount) conds.push(gte(feedItems.discountPct, q.minDiscount));
    if (q.priceMin !== undefined) conds.push(gte(feedItems.price, q.priceMin));
    if (q.priceMax !== undefined) conds.push(lte(feedItems.price, q.priceMax));
    if (q.minRating) conds.push(gte(feedItems.rating, q.minRating));
    const order = {
      relevance: [
        desc(sql`coalesce(${feedItems.discountPct}, 0) * coalesce(${feedItems.rating}, 4)`),
      ],
      sales: [desc(sql`coalesce(${feedItems.likes}, 0)`)],
      price_asc: [asc(feedItems.price)],
      price_desc: [desc(feedItems.price)],
      commission: [desc(sql`coalesce(${feedItems.discountPct}, 0)`)],
      discount: [desc(sql`coalesce(${feedItems.discountPct}, 0)`)],
    }[q.sort ?? "relevance"];
    const rows = await this.db
      .select()
      .from(feedItems)
      .where(and(...conds))
      .orderBy(...order, asc(feedItems.externalId))
      .limit(limit + 1)
      .offset((page - 1) * limit);
    return {
      items: rows.slice(0, limit).map((r) => toOffer(r, this.affiliateId)),
      hasMore: rows.length > limit,
    };
  }

  /** Fora do catálogo = saiu do feed ou perdeu o desconto. */
  async lookup(externalId: string) {
    const [row] = await this.db
      .select()
      .from(feedItems)
      .where(and(eq(feedItems.accountId, this.accountId), eq(feedItems.externalId, externalId)));
    return row ? toOffer(row, this.affiliateId) : null;
  }

  async generateLink(productUrl: string, subIds: string[]) {
    if (!isShopeeAffiliateId(this.affiliateId)) {
      throw new ConnectorError("shopee", "AUTH", "ID de afiliado da Shopee inválido.");
    }
    return shopeeAffiliateLink(productUrl, this.affiliateId, subIds);
  }
}

/** Confere ID de afiliado e se o primeiro link do feed responde com um CSV de produtos. */
export async function pingFeed(creds: Partial<FeedCredentials> | null, open: StreamOpener) {
  if (!isShopeeAffiliateId(creds?.affiliate_id ?? "")) {
    throw new ConnectorError(
      "shopee",
      "AUTH",
      "ID de afiliado inválido: use só os números (aparece como an_<número> nos seus links).",
    );
  }
  const urls = feedUrlsOf(creds);
  if (!urls.length) throw new ConnectorError("shopee", "AUTH", "Cole ao menos um link do feed.");
  for (const url of urls) {
    let header = "";
    try {
      const decoder = new TextDecoder();
      for await (const chunk of (await open(url)).body) {
        header += decoder.decode(chunk, { stream: true });
        if (header.includes("\n") || header.length > 4096) break;
      }
    } catch (err) {
      throw new ConnectorError(
        "shopee",
        "UNAVAILABLE",
        `Não foi possível baixar o feed: ${String(err)}`,
      );
    }
    if (!/itemid/.test(header.split("\n")[0] ?? "")) {
      throw new ConnectorError(
        "shopee",
        "AUTH",
        "O link não devolveu o feed de produtos. Copie de novo em Criativo › Feed de Produtos.",
      );
    }
  }
}

async function setInfo(db: DbOrTx, id: string, info: FeedInfo, synced?: Date) {
  await db
    .update(affiliateAccounts)
    .set({ feedInfo: info, ...(synced ? { feedSyncedAt: synced } : {}) })
    .where(eq(affiliateAccounts.id, id));
}

/**
 * Importa o feed: lê os CSVs em fluxo, guarda só os itens com desconto e boa avaliação e
 * apaga do catálogo o que não veio nesta rodada.
 */
export async function syncFeedAccount(
  deps: Pick<Deps, "db" | "secrets" | "now" | "openStream">,
  account: AccountRow,
): Promise<FeedInfo> {
  const open = deps.openStream;
  const started = now(deps);
  const creds = account.credentials
    ? deps.secrets.decryptJson<Partial<FeedCredentials>>(account.credentials)
    : null;
  const urls = feedUrlsOf(creds);
  const info: FeedInfo = {
    items: 0,
    read: 0,
    files: 0,
    seconds: 0,
    running_since: started.toISOString(),
  };
  await setInfo(deps.db, account.id, {
    ...(account.feedInfo ?? info),
    running_since: info.running_since,
  });

  // Andamento gravado a cada poucos segundos para o painel acompanhar.
  let lastReport = 0;
  const report = async (progress: NonNullable<FeedInfo["progress"]>, force = false) => {
    if (!force && Date.now() - lastReport < 2000) return;
    lastReport = Date.now();
    await setInfo(deps.db, account.id, {
      ...(account.feedInfo ?? info),
      running_since: info.running_since,
      progress: { ...progress, at: new Date().toISOString() },
      read: info.read,
      items: info.items,
    });
  };

  try {
    for (const [index, url] of urls.entries()) {
      let batch: (typeof feedItems.$inferInsert)[] = [];
      const flush = async () => {
        if (!batch.length) return;
        // O mesmo item pode vir repetido no arquivo: fica o último.
        const unique = [...new Map(batch.map((b) => [b.externalId, b])).values()];
        batch = [];
        await deps.db
          .insert(feedItems)
          .values(unique)
          .onConflictDoUpdate({
            target: [feedItems.accountId, feedItems.externalId],
            set: {
              title: sql`excluded.title`,
              url: sql`excluded.url`,
              imageUrls: sql`excluded.image_urls`,
              price: sql`excluded.price`,
              originalPrice: sql`excluded.original_price`,
              discountPct: sql`excluded.discount_pct`,
              rating: sql`excluded.rating`,
              likes: sql`excluded.likes`,
              shopName: sql`excluded.shop_name`,
              categoryIds: sql`excluded.category_ids`,
              categoryName: sql`excluded.category_name`,
              topCategory: sql`excluded.top_category`,
              seenAt: sql`excluded.seen_at`,
            },
          });
      };
      const opened = await open(url);
      const progress = { file: index + 1, files: urls.length, bytes: 0, total: opened.size };
      await report(progress, true);
      const counted = (async function* () {
        for await (const chunk of opened.body) {
          progress.bytes += chunk.length;
          // Grava o andamento pelo tempo (a cada ~2 s), mesmo com linhas grandes.
          await report(progress);
          yield chunk;
        }
      })();
      for await (const rec of readCsvRecords(counted)) {
        info.read++;
        const item = shopeeFeedItem(rec);
        if (!item) continue;
        if ((item.discountPct ?? 0) < FEED_MIN_DISCOUNT) continue;
        if (item.rating !== null && item.rating < FEED_MIN_RATING) continue;
        const likes = Number(rec.like);
        batch.push({
          accountId: account.id,
          externalId: item.externalId,
          title: item.title.slice(0, 300),
          url: item.url,
          imageUrls: item.imageUrls,
          price: item.price,
          originalPrice: item.originalPrice,
          discountPct: item.discountPct,
          rating: item.rating,
          likes: Number.isFinite(likes) ? likes : null,
          shopName: item.shopName,
          categoryIds: item.categoryIds,
          categoryName: item.categoryName,
          topCategory: (rec.global_category1 ?? "").trim() || null,
          seenAt: started,
        });
        info.items++;
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      info.files++;
    }
    // Só limpa quando todos os arquivos vieram: falha no meio não esvazia o catálogo.
    await deps.db
      .delete(feedItems)
      .where(and(eq(feedItems.accountId, account.id), lt(feedItems.seenAt, started)));
    const [{ count = 0 } = {}] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(feedItems)
      .where(eq(feedItems.accountId, account.id));
    const done: FeedInfo = {
      ...info,
      items: count,
      seconds: Math.round((now(deps).getTime() - started.getTime()) / 1000),
      running_since: null,
      progress: null,
      error: null,
    };
    await setInfo(deps.db, account.id, done, started);
    await deps.db
      .update(affiliateAccounts)
      .set({ status: "active", lastError: null })
      .where(and(eq(affiliateAccounts.id, account.id), eq(affiliateAccounts.status, "error")));
    return done;
  } catch (err) {
    const failed: FeedInfo = {
      ...(account.feedInfo ?? info),
      running_since: null,
      progress: null,
      error: `Falha ao importar o feed: ${String((err as Error).message ?? err)}`,
    };
    // Não tenta de novo a cada minuto: volta a tentar em ~1 hora.
    const retry = new Date(started.getTime() - (FEED_REFRESH_HOURS - 1) * 3_600_000);
    await setInfo(deps.db, account.id, failed, retry);
    await deps.db
      .update(affiliateAccounts)
      .set({ lastError: failed.error })
      .where(eq(affiliateAccounts.id, account.id));
    return failed;
  }
}

/** Sem sinal de vida por este tempo, a importação é considerada interrompida. */
export const FEED_STALE_MS = 2 * 60_000;

/** A importação está de fato rodando (tem sinal de vida recente)? */
export function feedRunning(info: FeedInfo | null | undefined, at = new Date()) {
  if (!info?.running_since) return false;
  const last = Date.parse(info.progress?.at ?? info.running_since);
  return at.getTime() - last < FEED_STALE_MS;
}

/** Contas em modo feed que precisam importar (nunca importaram, pediram ou passou um dia). */
export async function dueFeedAccounts(deps: Pick<Deps, "db" | "now">) {
  const limit = new Date(now(deps).getTime() - FEED_REFRESH_HOURS * 3_600_000);
  return deps.db
    .select()
    .from(affiliateAccounts)
    .where(
      and(
        eq(affiliateAccounts.mode, "feed"),
        or(eq(affiliateAccounts.status, "active"), eq(affiliateAccounts.status, "error")),
        or(isNull(affiliateAccounts.feedSyncedAt), lt(affiliateAccounts.feedSyncedAt, limit)),
      ),
    )
    .orderBy(asc(affiliateAccounts.createdAt));
}

/** Rodada do worker: importa os feeds pendentes, um de cada vez. */
export async function runFeedSync(deps: Pick<Deps, "db" | "secrets" | "now" | "openStream">) {
  const results: { account_id: string; info: FeedInfo }[] = [];
  for (const account of await dueFeedAccounts(deps)) {
    results.push({ account_id: account.id, info: await syncFeedAccount(deps, account) });
  }
  return results;
}
