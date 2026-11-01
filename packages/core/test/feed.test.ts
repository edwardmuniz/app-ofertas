import { affiliateAccounts, feedItems, trackedLinks } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  connectAffiliateAccount,
  createOfferLink,
  type Deps,
  deleteAffiliateAccount,
  feedRunning,
  importOfferFromLink,
  listAffiliateAccounts,
  listOfferCategories,
  listOffers,
  previewOfferFromLink,
  requestFeedSync,
  resolveSession,
  runFeedSync,
  saveOffer,
  searchOffers,
  updateAffiliateAccount,
  validateOffer,
} from "../src";
import { createOwner, fakeFiles, fakePages, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };
beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

const AFFILIATE_ID = "14354840000";
const HEADER =
  "itemid,title,description,price,sale_price,discount_percentage,item_rating,image_link,shop_name,global_category1,global_catid1,product_link,product_short link,like";
const row = (id: string, title: string, price: number, sale: number, disc: number, rating = 4.8) =>
  [
    id,
    `"${title}"`,
    // Descrição com vírgulas, aspas e quebra de linha: o leitor precisa tratar.
    `"Linha 1, com vírgula e ""aspas""\nLinha 2"`,
    price,
    sale,
    disc,
    rating,
    `https://cf.shopee.com.br/file/${id}`,
    "Loja Boa",
    "Home & Living",
    "100636",
    `https://shopee.com.br/product/99/${id}`,
    `https://shope.ee/an_redir?origin_link=https%3A%2F%2Fshopee.com.br%2Fproduct%2F99%2F${id}`,
    "120",
  ].join(",");

async function setup(tag: string) {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  const ctx: Ctx = { ...deps, actor: r.actor };
  const url = `https://affiliate.shopee.com.br/feed-${tag}`;
  fakeFiles.set(
    url,
    [
      HEADER,
      row(`${tag}1`, "Air Fryer Philco 4L", 400, 299.9, 25),
      row(`${tag}2`, "Fone Bluetooth TWS", 100, 95, 5), // pouco desconto: fica de fora
      row(`${tag}3`, "Air Fryer Mondial 3L", 300, 210, 30, 3.5), // avaliação ruim: fora
      row(`${tag}4`, "Panela de Pressão Elétrica", 500, 350, 30),
    ].join("\r\n"),
  );
  const account = done(
    await connectAffiliateAccount(ctx, {
      platform: "shopee",
      label: "Feed Shopee",
      mode: "feed",
      credentials: { affiliate_id: AFFILIATE_ID, feed_urls: url },
    }),
  );
  return { ctx, account, url };
}

describe("feed de produtos", () => {
  it("recusa ID de afiliado inválido e link que não é feed", async () => {
    const { ctx } = await setup("x");
    fakeFiles.set("https://affiliate.shopee.com.br/nao-feed", "<html>login</html>");
    await expect(
      connectAffiliateAccount(ctx, {
        platform: "shopee",
        label: "F",
        mode: "feed",
        credentials: { affiliate_id: "abc", feed_urls: "https://affiliate.shopee.com.br/feed-x" },
      }),
    ).rejects.toThrow(/ID de afiliado/);
    await expect(
      connectAffiliateAccount(ctx, {
        platform: "shopee",
        label: "F",
        mode: "feed",
        credentials: {
          affiliate_id: AFFILIATE_ID,
          feed_urls: "https://affiliate.shopee.com.br/nao-feed",
        },
      }),
    ).rejects.toThrow(/feed de produtos/);
  });

  it("importa só itens com desconto e boa avaliação, busca e gera link com sub-ids", async () => {
    const { ctx, account, url } = await setup("a");
    expect(account.feed).toMatchObject({ synced_at: null, items: 0 });

    const res = await runFeedSync(deps);
    const mine = res.find((r) => r.account_id === account.id);
    expect(mine?.info).toMatchObject({ items: 2, read: 4, files: 1, error: null });
    const [acc] = (await listAffiliateAccounts(ctx)).filter((a) => a.id === account.id);
    expect(acc?.feed).toMatchObject({ items: 2, running: false });
    expect(acc?.feed?.synced_at).toBeTruthy();

    // Já importado: não importa de novo na próxima rodada.
    expect((await runFeedSync(deps)).some((r) => r.account_id === account.id)).toBe(false);

    const { items } = await searchOffers(ctx, { keyword: "air fryer" });
    expect(items.map((i) => i.title)).toEqual(["Air Fryer Philco 4L"]);
    expect(items[0]).toMatchObject({ price: 299.9, original_price: 400, discount_pct: 25 });

    const offer = done(await saveOffer(ctx, { product_id: items[0]?.product_id ?? "" }));
    const link = done(await createOfferLink(ctx, { offer_id: offer.id, source: "wa" }));
    expect(link.affiliate_url).toMatch(
      /^https:\/\/s\.shopee\.com\.br\/an_redir\?origin_link=https%3A%2F%2Fshopee\.com\.br%2Fproduct%2F99%2Fa1&affiliate_id=14354840000&sub_id=wa-\w+$/,
    );

    // O item saiu do feed (perdeu o desconto): some do catálogo e a oferta expira.
    fakeFiles.set(url, [HEADER, row("a4", "Panela de Pressão Elétrica", 500, 350, 30)].join("\n"));
    done(await requestFeedSync(ctx, account.id));
    await runFeedSync(deps);
    const left = await deps.db.select().from(feedItems).where(eq(feedItems.accountId, account.id));
    expect(left.map((i) => i.externalId)).toEqual(["a4"]);
    const v = done(await validateOffer(ctx, offer.id));
    expect(v).toMatchObject({ ok: false, status: "expired" });
  });

  it("falha no download não apaga o catálogo e tenta de novo depois", async () => {
    const { account, url } = await setup("b");
    await runFeedSync(deps);
    fakeFiles.delete(url);
    await deps.db
      .update(affiliateAccounts)
      .set({ feedSyncedAt: null })
      .where(eq(affiliateAccounts.id, account.id));
    const [r] = (await runFeedSync(deps)).filter((x) => x.account_id === account.id);
    expect(r?.info.error).toMatch(/Falha ao importar/);
    const left = await deps.db.select().from(feedItems).where(eq(feedItems.accountId, account.id));
    expect(left).toHaveLength(2);
  });

  it("link comum colado vira link de comissão com sub-ids no link curto", async () => {
    const { ctx } = await setup("c");
    await runFeedSync(deps);
    const plain = "https://shopee.com.br/Caneca-Termica-Inox-i.77.888999";
    fakePages.set(plain, { url: plain, html: "<html></html>" });
    const p = await previewOfferFromLink(ctx, { url: plain });
    expect(p.is_affiliate_link).toBe(true);
    expect(p.affiliate_url).toContain(`affiliate_id=${AFFILIATE_ID}`);
    const offer = done(
      await importOfferFromLink(ctx, { url: plain, title: "Caneca Térmica Inox", price: 49.9 }),
    );
    expect(offer.origin).toBe("link");
    const link = done(await createOfferLink(ctx, { offer_id: offer.id, source: "ig" }));
    expect(link.affiliate_url).toMatch(/affiliate_id=14354840000&sub_id=ig-\w+$/);
    const [row] = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.id, link.link_id));
    expect(row?.destinationUrl).toBe(link.affiliate_url);
  });
});

describe("busca no catálogo e gestão da conta", () => {
  it("filtra por preço, desconto e categoria, pagina e lista categorias em português", async () => {
    const { ctx } = await setup("d");
    await runFeedSync(deps);
    const cats = await listOfferCategories(ctx);
    expect(cats).toEqual([
      { id: "100636", name: "Casa e Decoração", platform: "shopee", count: 2 },
    ]);
    const cheap = await searchOffers(ctx, { price_max: 300 });
    expect(cheap.items.map((i) => i.title)).toEqual(["Air Fryer Philco 4L"]);
    const byDiscount = await searchOffers(ctx, { sort: "discount", category_id: "100636" });
    expect(byDiscount.items.map((i) => i.discount_pct)).toEqual([30, 25]);
    const page2 = await searchOffers(ctx, { limit: 1, page: 2, sort: "discount" });
    expect(page2.items.map((i) => i.title)).toEqual(["Air Fryer Philco 4L"]);
  });

  it("edita nome e links (pede nova importação) e remove mantendo as ofertas", async () => {
    const { ctx, account, url } = await setup("e");
    await runFeedSync(deps);
    const newUrl = `${url}-novo`;
    fakeFiles.set(newUrl, [HEADER, row("e9", "Liquidificador Turbo", 200, 120, 40)].join("\n"));
    await expect(
      updateAffiliateAccount(ctx, account.id, { credentials: { affiliate_id: "x" } }),
    ).rejects.toThrow(/ID de afiliado/);
    const edited = done(
      await updateAffiliateAccount(ctx, account.id, {
        label: "Shopee feed novo",
        credentials: { feed_urls: newUrl, affiliate_id: "" },
      }),
    );
    expect(edited).toMatchObject({ label: "Shopee feed novo", feed: { synced_at: null } });
    await runFeedSync(deps);
    const { items } = await searchOffers(ctx, {});
    expect(items.map((i) => i.title)).toEqual(["Liquidificador Turbo"]);
    // O ID de afiliado antigo continua (campo em branco mantém).
    const offer = done(await saveOffer(ctx, { product_id: items[0]?.product_id ?? "" }));
    const link = done(await createOfferLink(ctx, { offer_id: offer.id, source: "wa" }));
    expect(link.affiliate_url).toContain(`affiliate_id=${AFFILIATE_ID}`);

    const removed = done(await deleteAffiliateAccount(ctx, account.id));
    expect(removed).toMatchObject({ deleted: true, offers_detached: 1 });
    expect(await listAffiliateAccounts(ctx)).toHaveLength(0);
    const left = await deps.db.select().from(feedItems).where(eq(feedItems.accountId, account.id));
    expect(left).toHaveLength(0);
    const [kept] = (await listOffers(ctx, { status: "approved" })).items;
    expect(kept).toMatchObject({ id: offer.id, origin: "link" });
  });

  it("grava o andamento durante a importação", async () => {
    const { ctx, account } = await setup("f");
    const seen: unknown[] = [];
    const spy = {
      ...deps,
      openStream: async (u: string) => {
        const opened = await deps.openStream(u);
        const body = (async function* () {
          for await (const chunk of opened.body) {
            const [acc] = await deps.db
              .select({ info: affiliateAccounts.feedInfo })
              .from(affiliateAccounts)
              .where(eq(affiliateAccounts.id, account.id));
            if (acc?.info?.progress) seen.push(acc.info.progress);
            yield chunk;
          }
        })();
        return { body, size: opened.size };
      },
    };
    await runFeedSync(spy);
    expect(seen[0]).toMatchObject({ file: 1, files: 1 });
    expect((seen[0] as { total: number }).total).toBeGreaterThan(0);
    const [after] = (await listAffiliateAccounts(ctx)).filter((a) => a.id === account.id);
    expect(after?.feed?.progress).toBeNull();
  });
});

describe("importação interrompida", () => {
  it("sem sinal de vida por 2 minutos não conta como rodando", () => {
    const now = new Date("2026-11-01T00:10:00Z");
    const base = { items: 0, read: 0, files: 0, seconds: 0 };
    expect(feedRunning({ ...base, running_since: "2026-11-01T00:09:30Z" }, now)).toBe(true);
    expect(feedRunning({ ...base, running_since: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(
      feedRunning(
        {
          ...base,
          running_since: "2026-11-01T00:00:00Z",
          progress: { file: 1, files: 1, bytes: 10, total: 100, at: "2026-11-01T00:09:59Z" },
        },
        now,
      ),
    ).toBe(true);
    expect(feedRunning({ ...base, running_since: null }, now)).toBe(false);
  });
});
