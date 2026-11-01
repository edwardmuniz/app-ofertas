import { FakeCopyWriter, fakeAffiliateControls, fakeMessagingControls } from "@ofertas/connectors";
import {
  automationRules,
  channelStatsDaily,
  channels,
  limits,
  messagingAccounts,
  posts,
  trackedLinks,
} from "@ofertas/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authenticateToken,
  type Ctx,
  cancelPost,
  connectAffiliateAccount,
  createMessagingAccount,
  createToken,
  type Deps,
  deleteSegment,
  deleteSentPost,
  generateOfferCopy,
  getConnectionState,
  handleMessagingWebhook,
  importOfferFromLink,
  listChannels,
  listMessagingAccounts,
  listPosts,
  listSegments,
  nextAllowedTime,
  previewOfferFromLink,
  previewPost,
  removeMessagingAccount,
  renderTemplate,
  resolveSession,
  runAutomationRules,
  runPublisher,
  saveOffer,
  schedulePosts,
  searchOffers,
  setChannelAdminOnly,
  setOfferCopy,
  syncGroups,
  updateChannel,
  updatePreferences,
  upsertAutomationRule,
  upsertSegment,
  validateOffer,
} from "../src";
import { createOwner, fakePages, importAllGroups, insertChannel, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});
afterEach(() => {
  fakeAffiliateControls.reset();
  fakeMessagingControls.reset();
});

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

/** Workspace com Shopee simulada, WhatsApp simulado conectado, grupos importados e sem atraso aleatório. */
async function setup() {
  // O publicador atende todos os workspaces: limpa a fila deixada por outros testes.
  await deps.db.update(posts).set({ status: "canceled" }).where(eq(posts.status, "scheduled"));
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  const ctx: Ctx = { ...deps, actor: r.actor };
  await deps.db
    .insert(limits)
    .values([{ workspaceId: ctx.actor.workspaceId, key: "posts.jitter_seconds", value: 0 }]);
  await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee", mode: "fake" });
  const account = done(await createMessagingAccount(ctx, { label: "Número", provider: "fake" }));
  const conn = await getConnectionState(ctx, account.id);
  expect(conn.account.status).toBe("connected");
  const synced = await importAllGroups(ctx, account.id);
  const seg = done(await upsertSegment(ctx, { name: `seg-${Date.now()}` }));
  for (const ch of synced.channels) await updateChannel(ctx, ch.id, { segment_ids: [seg.id] });
  return { ctx, account, channels: synced.channels, seg };
}

async function approvedOffer(ctx: Ctx, keyword = "air fryer", index = 0) {
  const { items } = await searchOffers(ctx, { keyword, limit: 10 });
  const c = items[index];
  if (!c) throw new Error("busca vazia");
  return { offer: done(await saveOffer(ctx, { product_id: c.product_id })), candidate: c };
}

const past = () => new Date(Date.now() - 60_000).toISOString();

describe("número e grupos", () => {
  it("conecta, importa grupos com link de convite e liga 'só admins'", async () => {
    const { ctx, channels: chs } = await setup();
    expect(chs).toHaveLength(3);
    expect(chs.every((c) => c.external_id?.endsWith("@g.us") && c.invite_url)).toBe(true);
    const target = chs.find((c) => c.admin_only === false);
    if (!target) throw new Error("sem grupo aberto");
    const updated = done(await setChannelAdminOnly(ctx, target.id, true));
    expect(updated.admin_only).toBe(true);
  });

  it("reimportar não duplica canais", async () => {
    const { ctx, account } = await setup();
    const again = await importAllGroups(ctx, account.id);
    expect(again).toMatchObject({ created: 0, updated: 3 });
  });
});

describe("importação com escolha de grupos", () => {
  async function fresh() {
    const s = await createOwner(deps);
    const r = await resolveSession(deps, s.sessionToken);
    if (!r) throw new Error("sessão");
    const ctx: Ctx = { ...deps, actor: r.actor };
    const account = done(await createMessagingAccount(ctx, { label: "N", provider: "fake" }));
    await getConnectionState(ctx, account.id);
    return { ctx, account };
  }
  const preview = (res: { status: string; preview?: unknown }) => {
    if (res.status !== "dry_run") throw new Error("esperado dry_run");
    return res.preview as {
      groups: {
        jid: string;
        name: string;
        channel_id: string | null;
        number_is_admin: boolean | null;
      }[];
      left: { channel_id: string; name: string }[];
      to_create: number;
    };
  };

  it("prévia lista os grupos sem criar nada; importa só os escolhidos com segmento", async () => {
    const { ctx, account } = await fresh();
    const p = preview(await syncGroups(ctx, account.id, {}, { dryRun: true }));
    expect(p.groups).toHaveLength(3);
    expect(p.to_create).toBe(0);
    expect(await listChannels(ctx)).toHaveLength(0);

    const seg = done(await upsertSegment(ctx, { name: `casa-${Date.now()}` }));
    const pick = p.groups[1];
    if (!pick) throw new Error("sem grupo");
    const res = done(
      await syncGroups(ctx, account.id, { group_jids: [pick.jid], segment_ids: [seg.id] }),
    );
    expect(res).toMatchObject({ created: 1, updated: 0, no_invite: [] });
    const chs = await listChannels(ctx);
    expect(chs.map((c) => c.external_id)).toEqual([pick.jid]);
    expect(chs[0]?.segment_ids).toEqual([seg.id]);
    expect(chs[0]?.number_is_admin).toBe(true);

    // Sem lista: só atualiza o que já está na plataforma.
    expect(done(await syncGroups(ctx, account.id))).toMatchObject({ created: 0, updated: 1 });
    await expect(syncGroups(ctx, account.id, { group_jids: ["999@g.us"] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("remover grupo arquiva, cancela agendados e some da lista; reimportar traz de volta", async () => {
    const { ctx, account, channels: chs, seg } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer } = await approvedOffer(ctx);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: future }));

    const dry = await updateChannel(ctx, ch.id, { status: "archived" }, { dryRun: true });
    expect(dry).toMatchObject({ preview: { scheduled_posts_canceled: 1 } });
    done(await updateChannel(ctx, ch.id, { status: "archived" }));
    expect((await listChannels(ctx)).map((c) => c.id)).not.toContain(ch.id);
    expect((await listChannels(ctx, { include_archived: true })).map((c) => c.id)).toContain(ch.id);
    // O segmento deixa de contar o grupo removido.
    const segRow = (await listSegments(ctx)).find((x) => x.id === seg.id);
    expect(segRow?.channel_count).toBe(2);
    const rows = await deps.db.select().from(posts).where(eq(posts.channelId, ch.id));
    expect(rows.every((p) => p.status === "canceled")).toBe(true);

    // Atualizar sem escolher não ressuscita; escolher de novo, sim.
    done(await syncGroups(ctx, account.id));
    expect((await listChannels(ctx)).map((c) => c.id)).not.toContain(ch.id);
    done(await syncGroups(ctx, account.id, { group_jids: [ch.external_id ?? ""] }));
    expect((await listChannels(ctx)).find((c) => c.id === ch.id)?.status).toBe("active");
  });

  it("aponta grupos que o número deixou", async () => {
    const { ctx, account, channels: chs } = await setup();
    const gone = chs[0];
    if (!gone) throw new Error("sem canal");
    const [acc] = await deps.db
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.id, account.id));
    fakeMessagingControls.instances
      .get(acc?.instanceId ?? "")
      ?.groups.delete(gone.external_id ?? "");
    const p = preview(await syncGroups(ctx, account.id, {}, { dryRun: true }));
    expect(p.left).toEqual([{ channel_id: gone.id, name: gone.name }]);
  });
});

describe("segmentos", () => {
  it("apaga segmento livre e recusa o usado por regra", async () => {
    const { ctx, channels: chs, seg } = await setup();
    const free = done(await upsertSegment(ctx, { name: `livre-${Date.now()}` }));
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    done(await updateChannel(ctx, ch.id, { segment_ids: [seg.id, free.id] }));
    expect(done(await deleteSegment(ctx, free.id))).toMatchObject({
      deleted: true,
      channel_count: 1,
    });
    const after = (await listChannels(ctx)).find((c) => c.id === ch.id);
    expect(after?.segment_ids).toEqual([seg.id]);

    await deps.db
      .insert(automationRules)
      .values({ workspaceId: ctx.actor.workspaceId, name: "Regra X", segmentIds: [seg.id] });
    await expect(deleteSegment(ctx, seg.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("remover número", () => {
  it("prévia não apaga; remover mantém os grupos e cancela os agendados", async () => {
    const { ctx, account, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer } = await approvedOffer(ctx);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: future }));

    const dry = await removeMessagingAccount(ctx, account.id, { dryRun: true });
    expect(dry).toMatchObject({
      status: "dry_run",
      preview: { channels_kept: 3, scheduled_posts_canceled: 1 },
    });
    expect((await listMessagingAccounts(ctx)).map((a) => a.id)).toContain(account.id);

    const res = done(await removeMessagingAccount(ctx, account.id));
    expect(res).toEqual({ removed: true, channels_kept: 3, scheduled_posts_canceled: 1 });
    expect((await listMessagingAccounts(ctx)).map((a) => a.id)).not.toContain(account.id);
    expect(fakeMessagingControls.instances.size).toBe(0);
    const [chRow] = await deps.db.select().from(channels).where(eq(channels.id, ch.id));
    expect(chRow?.messagingAccountId).toBeNull();
    const pending = await deps.db.select().from(posts).where(eq(posts.channelId, ch.id));
    expect(pending.every((p) => p.status === "canceled")).toBe(true);
  });
});

describe("agendamento", () => {
  it("planeja no segmento, dry_run não grava e bloqueia repetição em 7 dias", async () => {
    const { ctx, seg } = await setup();
    const { offer } = await approvedOffer(ctx);
    const dry = await schedulePosts(
      ctx,
      { offer_ids: [offer.id], segment_ids: [seg.id] },
      { dryRun: true },
    );
    expect(dry.status).toBe("dry_run");
    if (dry.status === "dry_run") {
      expect(dry.preview.posts).toHaveLength(3);
      expect(dry.preview.posts[0]?.body).toContain("http://go.test/");
    }
    expect((await listPosts(ctx)).items).toHaveLength(0);

    const res = done(await schedulePosts(ctx, { offer_ids: [offer.id], segment_ids: [seg.id] }));
    expect(res.scheduled).toHaveLength(3);
    const again = done(await schedulePosts(ctx, { offer_ids: [offer.id], segment_ids: [seg.id] }));
    expect(again.scheduled).toHaveLength(0);
    expect(again.skipped).toHaveLength(3);
    expect(again.skipped[0]?.reason).toContain("7 dias");
  });

  it("respeita janelas de envio e espaça posts no mesmo grupo", async () => {
    const { ctx, channels: chs } = await setup();
    const first = chs[0];
    if (!first) throw new Error("sem canal");
    await updatePreferences(ctx, { posting_windows: ["03:00-03:30"] });
    const a = await approvedOffer(ctx, "fone", 0);
    const b = await approvedOffer(ctx, "fone", 1);
    const res = done(
      await schedulePosts(ctx, {
        offer_ids: [a.offer.id, b.offer.id],
        channel_ids: [first.id],
        spacing_minutes: 15,
      }),
    );
    const [p1, p2] = res.scheduled.map((p) => new Date(p.scheduled_at));
    if (!p1 || !p2) throw new Error("posts não agendados");
    expect(
      new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(p1),
    ).toBe("03:00");
    expect(p2.getTime() - p1.getTime()).toBe(15 * 60_000);
  });

  it("recusa oferta não aprovada e canal sem WhatsApp", async () => {
    const { ctx } = await setup();
    const manual = await insertChannel(ctx, ctx.actor.workspaceId, { name: "Manual" });
    const { items } = await searchOffers(ctx, { keyword: "panelas", limit: 1 });
    const pending = done(
      await saveOffer(ctx, { product_id: items[0]?.product_id ?? "", status: "new" }),
    );
    const res = done(
      await schedulePosts(ctx, { offer_ids: [pending.id], channel_ids: [manual.id] }),
    );
    expect(res.scheduled).toHaveLength(0);
    expect(res.skipped.map((s) => s.reason).join(" ")).toMatch(/WhatsApp/);
    expect(res.skipped.map((s) => s.reason).join(" ")).toMatch(/aprovada/);
  });
});

describe("oferta por link", () => {
  const SHORT = "https://s.shopee.com.br/AbC123";
  fakePages.set(SHORT, {
    // A Shopee devolve uma página genérica: o título sai do próprio endereço final.
    url: "https://shopee.com.br/Fone-Bluetooth-TWS-Pro-i.111.222333?utm_source=an_123",
    html: '<meta property="og:title" content="Shopee Brasil | Ofertas incríveis. Melhores preços do mercado"/>',
  });

  it("lê o link curto, cria a oferta com o link colado e publica sem API da loja", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");

    const p = await previewOfferFromLink(ctx, { url: SHORT });
    expect(p).toMatchObject({
      platform: "shopee",
      external_id: "222333",
      title: "Fone Bluetooth TWS Pro",
      is_affiliate_link: true,
      source: "page",
      missing: ["image", "price"],
      existing_offer_id: null,
    });

    const offer = done(
      await importOfferFromLink(ctx, {
        url: SHORT,
        title: "Fone Bluetooth TWS Pro",
        image_url: "https://cdn.test/fone.jpg",
        price: 79.9,
        original_price: 159.8,
      }),
    );
    expect(offer).toMatchObject({
      origin: "link",
      status: "approved",
      affiliate_url: SHORT,
      discount_pct: 50,
      image_url: "https://cdn.test/fone.jpg",
    });

    // Colar de novo atualiza a mesma oferta.
    expect((await previewOfferFromLink(ctx, { url: SHORT })).existing_offer_id).toBe(offer.id);
    const again = done(
      await importOfferFromLink(ctx, { url: SHORT, title: "Fone TWS Pro", price: 69.9 }),
    );
    expect(again.id).toBe(offer.id);

    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: past() }));
    expect((await runPublisher(deps)).map((r) => r.status)).toEqual(["sent"]);
    expect(fakeMessagingControls.sent[0]?.text).toContain("Fone TWS Pro");
    const [post] = (await listPosts(ctx, { status: "sent" })).items;
    const [link] = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.postId, post?.id ?? ""));
    expect(link?.destinationUrl).toBe(SHORT);

    // Filtro por data do envio.
    const day = 86_400_000;
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect((await listPosts(ctx, { from: iso(-day), to: iso(day) })).items).toHaveLength(1);
    expect((await listPosts(ctx, { from: iso(day) })).items).toHaveLength(0);
    expect((await listPosts(ctx, { to: iso(-day) })).items).toHaveLength(0);
  });

  it("recusa link que não é de loja conhecida", async () => {
    const { ctx } = await setup();
    await expect(previewOfferFromLink(ctx, { url: "https://exemplo.com/produto" })).rejects.toThrow(
      /não reconhecido/,
    );
  });
});

describe("Mercado Livre por link (dados vistos pelo agente)", () => {
  const MELI = "https://meli.la/1AbCdEf";
  fakePages.set(MELI, {
    // A página bloqueia a leitura: só o título e a logo da loja no lugar da foto.
    url: "https://www.mercadolivre.com.br/fritadeira-air-fryer-mondial-4l/p/MLB15209590?matt_tool=123&matt_word=loja",
    html: `<meta property="og:title" content="Fritadeira Air Fryer Mondial 4L | Mercado Livre"/>
<meta property="og:image" content="https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/6.7.0/mercadolibre/pt_logo_large_plus@2x.webp"/>`,
  });

  it("aceita meli.la, ignora a logo e grava Pix e parcelas informados", async () => {
    const { ctx } = await setup();
    const p = await previewOfferFromLink(ctx, { url: MELI });
    expect(p).toMatchObject({
      platform: "mercadolivre",
      external_id: "MLB15209590",
      is_affiliate_link: true,
      image_url: null,
    });
    expect(p.missing).toEqual(expect.arrayContaining(["image", "price"]));

    const offer = done(
      await importOfferFromLink(ctx, {
        url: MELI,
        product_url: "https://www.mercadolivre.com.br/fritadeira-mondial/p/MLB15209590",
        title: "Fritadeira Air Fryer Mondial 4L",
        image_url: "https://http2.mlstatic.com/D_NQ_NP_123-O.webp",
        price: 279.9,
        original_price: 399.9,
        pix_price: 265.9,
        installments: { count: 10, value: 27.99, interest_free: true },
      }),
    );
    expect(offer).toMatchObject({
      platform: "mercadolivre",
      affiliate_url: MELI,
      discount_pct: 30,
      pix_price: 265.9,
      installments: { count: 10, value: 27.99, interest_free: true },
    });
    // Pix maior ou igual ao preço não vale.
    const noPix = done(
      await importOfferFromLink(ctx, {
        url: MELI,
        title: "Fritadeira Air Fryer Mondial 4L",
        price: 279.9,
        pix_price: 279.9,
      }),
    );
    expect(noPix.pix_price).toBeNull();

    // meli.la que não revela o produto: product_url dá o id e evita duplicar.
    const SOCIAL = "https://meli.la/2gApnZZ";
    fakePages.set(SOCIAL, {
      url: SOCIAL,
      html: '<meta property="og:url" content="https://www.mercadolivre.com.br/social/loja?matt_word=loja"/>',
    });
    const viaSocial = done(
      await importOfferFromLink(ctx, {
        url: SOCIAL,
        product_url: "https://www.mercadolivre.com.br/fritadeira-mondial/p/MLB15209590?x=1",
        title: "Fritadeira Air Fryer Mondial 4L",
        price: 279.9,
      }),
    );
    expect(viaSocial.id).toBe(offer.id);
    expect(viaSocial.affiliate_url).toBe(SOCIAL);
    await expect(
      importOfferFromLink(ctx, {
        url: SOCIAL,
        product_url: "https://www.amazon.com.br/dp/B0BTYCJXBK",
        title: "Outra loja",
        price: 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("Amazon (associado só com a tag)", () => {
  const ASIN = "B0BTYCJXBK";
  const PASTED = `https://www.amazon.com.br/Fone-Anker/dp/${ASIN}?ref=sr_1_1&tag=outro-20`;
  const PAGE_URL = `https://www.amazon.com.br/dp/${ASIN}`;
  const page = (price: string) =>
    `<span id="productTitle"> Fone Anker P20i </span>
<img data-old-hires="https://m.media-amazon.com/images/I/fone._AC_SL1500_.jpg">
<span class="basisPrice"><span class="a-offscreen">R$249,00</span></span>
<span class="apex-pricetopay-value"><span class="a-offscreen">R$146,20</span></span>
<span> no Pix ou NuPay </span> <span> 5x de R$ 30,78 sem juros</span>
<div id="availability"><span> Em estoque </span></div>
<script>{"priceAmount":${price}}</script>`;
  const serve = (html: string) => {
    fakePages.set(PASTED, { url: PASTED, html });
    fakePages.set(PAGE_URL, { url: PAGE_URL, html });
  };

  it("sem Creators API a busca lê a página de resultados da Amazon", async () => {
    const s = await createOwner(deps);
    const r = await resolveSession(deps, s.sessionToken);
    if (!r) throw new Error("sessão");
    const ctx: Ctx = { ...deps, actor: r.actor };
    const acc = done(
      await connectAffiliateAccount(ctx, {
        platform: "amazon",
        label: "Amazon",
        mode: "live",
        credentials: { partner_tag: "minhaloja-20", credential_id: " ", credential_secret: "" },
      }),
    );
    expect(acc.capabilities).toMatchObject({ search: true, lookup: true, subIds: 0 });
    const SEARCH = "https://www.amazon.com.br/s?k=fone";
    fakePages.set(SEARCH, {
      url: SEARCH,
      html: `<div data-asin="${ASIN}" data-component-type="s-search-result">
<img class="s-image" src="https://m.media-amazon.com/images/I/fone._AC_UL320_.jpg"/>
<h2 aria-label="Fone Anker P20i"><span>Fone Anker P20i</span></h2>
<span class="a-price" data-a-size="xl"><span class="a-offscreen">R$ 153,90</span></span>
<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">R$ 249,00</span></span></div>`,
    });
    const found = await searchOffers(ctx, { keyword: "fone" });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      platform: "amazon",
      external_id: ASIN,
      price: 153.9,
      discount_pct: 38,
    });
    await expect(
      connectAffiliateAccount(ctx, {
        platform: "amazon",
        label: "x",
        mode: "live",
        credentials: { partner_tag: "sem-formato" },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("link colado ganha a sua tag, o preço é conferido e o post leva o link direto", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    done(
      await connectAffiliateAccount(ctx, {
        platform: "amazon",
        label: "Amazon",
        mode: "live",
        credentials: { partner_tag: "minhaloja-20" },
      }),
    );
    serve(page("153.90"));

    const p = await previewOfferFromLink(ctx, { url: PASTED });
    expect(p).toMatchObject({
      platform: "amazon",
      external_id: ASIN,
      source: "platform",
      affiliate_url: `${PAGE_URL}?tag=minhaloja-20`,
      price: 153.9,
      original_price: 249,
      image_url: "https://m.media-amazon.com/images/I/fone._AC_SL1500_.jpg",
      missing: [],
    });
    const offer = done(
      await importOfferFromLink(ctx, {
        url: PASTED,
        title: "Fone Anker P20i",
        price: 153.9,
        original_price: 249,
      }),
    );
    expect(offer).toMatchObject({
      origin: "platform",
      status: "approved",
      discount_pct: 38,
      pix_price: 146.2,
      installments: { count: 5, value: 30.78, interest_free: true },
    });

    // Prévia já mostra o link da Amazon (sem encurtador).
    const preview = await previewPost(ctx, { offer_id: offer.id });
    expect(preview.body).toContain(`${PAGE_URL}?tag=minhaloja-20`);

    // Página com captcha: não expira a oferta; o post tenta de novo depois.
    serve("<p>captcha</p>");
    await expect(validateOffer(ctx, offer.id)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    serve(page("149.90"));
    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: past() }));
    expect((await runPublisher(deps)).map((r) => r.status)).toEqual(["sent"]);
    const text = fakeMessagingControls.sent[0]?.text ?? "";
    expect(text).toContain(`${PAGE_URL}?tag=minhaloja-20`);
    expect(text).not.toContain("go.test");
    expect(text).toMatch(/no pix/i);
    expect(text).toContain("5x de R$\u00a030,78 sem juros");

    // Preço subiu mais de 5%: a oferta expira na validação.
    serve(page("199.00"));
    const v = done(await validateOffer(ctx, offer.id));
    expect(v).toMatchObject({ ok: false, status: "expired", price_now: 199 });
  });
});

describe("texto próprio da oferta e cards", () => {
  it("IA só pelo painel: sugere em dry_run, salva e o envio usa o formato chamada + preço", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer } = await approvedOffer(ctx);

    await expect(generateOfferCopy(ctx, offer.id)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    const writer = new FakeCopyWriter();
    const aiCtx: Ctx = { ...ctx, copywriter: writer };
    await updatePreferences(ctx, { tone_of_voice: "divertido" });

    const dry = await generateOfferCopy(
      aiCtx,
      offer.id,
      { hint: "para quem cozinha" },
      { dryRun: true },
    );
    expect(dry.status).toBe("dry_run");
    expect(writer.calls[0]).toMatchObject({ tone: "divertido", hint: "para quem cozinha" });
    expect(writer.calls[0]?.price).toMatch(/^R\$/);

    const saved = await generateOfferCopy(aiCtx, offer.id);
    expect(saved.status).toBe("done");
    const copy = saved.status === "done" ? saved.result?.copy : null;
    expect(copy).toMatchObject({ source: "ai" });

    // Agente não usa a IA da plataforma: escreve o próprio texto.
    const t = await createToken(ctx, { name: "agente", preset: "full" });
    const actor = await authenticateToken(deps, t.token, "mcp");
    if (!actor) throw new Error("token");
    const agentCtx: Ctx = { ...deps, copywriter: writer, actor };
    await expect(generateOfferCopy(agentCtx, offer.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      setOfferCopy(agentCtx, offer.id, {
        copy: { headline: "Só hoje por R$ 10", body: "Corre que acaba" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const byAgent = done(
      await setOfferCopy(agentCtx, offer.id, {
        copy: {
          headline: "Fritadeira sem óleo que cabe na sua cozinha!",
          body: "Batata crocante sem sujeira e sem cheiro de fritura.",
          extra: "Aproveite antes que acabe.",
        },
      }),
    );
    expect(byAgent.copy).toMatchObject({ source: "agent" });

    const preview = await previewPost(ctx, { offer_id: offer.id });
    expect(preview.body.split("\n")[0]).toBe("*Fritadeira sem óleo que cabe na sua cozinha!*");
    expect(preview.body).toMatch(/Por \*R\$|De ~R\$/);
    expect(preview.body).toContain("Aproveite antes que acabe.");

    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: past() }));
    expect((await runPublisher(deps)).map((r) => r.status)).toEqual(["sent"]);
    expect(fakeMessagingControls.sent[0]?.text).toContain("Batata crocante");

    // null volta ao modelo padrão
    const cleared = done(await setOfferCopy(ctx, offer.id, { copy: null }));
    expect(cleared.copy).toBeNull();
  });

  it("cards desligados nas Preferências: envia só a foto do produto", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer } = await approvedOffer(ctx, "fone");
    await updatePreferences(ctx, { creative_cards: false });
    done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [ch.id],
        at: past(),
        creative_template: "card_preco",
      }),
    );
    expect((await runPublisher(deps)).map((r) => r.status)).toEqual(["sent"]);
    expect(fakeMessagingControls.sent[0]?.imageUrl).toBe(offer.image_url);
  });
});

describe("envio", () => {
  it("revalida, gera link rastreado, envia foto com legenda e conta no dia", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const { offer } = await approvedOffer(ctx);
    done(await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [ch.id], at: past() }));

    const results = await runPublisher(deps);
    expect(results.map((r) => r.status)).toEqual(["sent"]);
    const sent = fakeMessagingControls.sent[0];
    expect(sent?.to).toBe(ch.external_id);
    expect(sent?.imageUrl).toMatch(/^https:/);
    expect(sent?.text).toMatch(/http:\/\/go\.test\/\w{7}/);

    const [post] = (await listPosts(ctx, { status: "sent" })).items;
    expect(post?.short_url).toBeTruthy();
    const [link] = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.postId, post?.id ?? ""));
    expect(link?.channelId).toBe(ch.id);
    const [stats] = await deps.db
      .select()
      .from(channelStatsDaily)
      .where(eq(channelStatsDaily.channelId, ch.id));
    expect(stats?.messagesSent).toBe(1);

    // Apagar a mensagem enviada.
    const deleted = done(await deleteSentPost(ctx, post?.id ?? ""));
    expect(deleted.status).toBe("deleted");
    expect(fakeMessagingControls.sent[0]?.deleted).toBe(true);
  });

  it("pula a oferta se o preço subiu na hora do envio", async () => {
    const { ctx, channels: chs } = await setup();
    const { offer, candidate } = await approvedOffer(ctx);
    done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [chs[0]?.id ?? ""],
        at: past(),
      }),
    );
    fakeAffiliateControls.setPrice(candidate.external_id, candidate.price * 1.3);
    const [r] = await runPublisher(deps);
    expect(r?.status).toBe("skipped");
    expect(fakeMessagingControls.sent).toHaveLength(0);
  });

  it("número desconectado reagenda; intervalo mínimo no grupo é respeitado", async () => {
    const { ctx, account, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    await deps.db
      .update(messagingAccounts)
      .set({ status: "disconnected" })
      .where(eq(messagingAccounts.id, account.id));
    done(await schedulePosts(ctx, { text: "Bom dia, grupo!", channel_ids: [ch.id], at: past() }));
    expect((await runPublisher(deps))[0]?.status).toBe("rescheduled");

    await deps.db
      .update(messagingAccounts)
      .set({ status: "connected" })
      .where(eq(messagingAccounts.id, account.id));
    await deps.db
      .update(posts)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(posts.channelId, ch.id));
    expect((await runPublisher(deps))[0]?.status).toBe("sent");

    // Segundo post forçado para agora: o grupo ainda está no intervalo mínimo.
    await deps.db.insert(posts).values({
      workspaceId: ctx.actor.workspaceId,
      channelId: ch.id,
      customText: "outra",
      scheduledAt: new Date(Date.now() - 1000),
      createdBy: "teste",
    });
    const [r] = await runPublisher(deps);
    expect(r).toMatchObject({ status: "rescheduled", reason: "intervalo do grupo" });
  });

  it("falha do provedor tenta de novo e cancela pela fila", async () => {
    const { ctx, channels: chs } = await setup();
    done(await schedulePosts(ctx, { text: "Oi", channel_ids: [chs[0]?.id ?? ""], at: past() }));
    fakeMessagingControls.failNext = "UNAVAILABLE";
    const [r] = await runPublisher(deps);
    expect(r?.status).toBe("rescheduled");
    const [p] = (await listPosts(ctx, { status: "scheduled" })).items;
    expect(p?.error).toContain("simulada");
    const canceled = done(await cancelPost(ctx, p?.id ?? ""));
    expect(canceled.status).toBe("canceled");
  });
});

describe("webhooks", () => {
  it("conta entradas e saídas e recusa token errado", async () => {
    const { account, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const [row] = await deps.db
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.id, account.id));
    const token = deps.secrets.decrypt(row?.token ?? "");
    const body = (t: string) => ({
      event: "GroupInfo",
      instanceId: row?.instanceId,
      instanceToken: t,
      data: { JID: ch.external_id, Join: ["a@s", "b@s"], Leave: ["c@s"] },
    });

    expect(await handleMessagingWebhook(deps, "fake", body("errado"))).toMatchObject({ ok: false });
    expect(await handleMessagingWebhook(deps, "fake", body(token))).toEqual({
      ok: true,
      event: "group_update",
    });

    const [after] = await deps.db.select().from(channels).where(eq(channels.id, ch.id));
    expect(after?.memberCount).toBe(ch.member_count + 1);
    const [stats] = await deps.db
      .select()
      .from(channelStatsDaily)
      .where(eq(channelStatsDaily.channelId, ch.id));
    expect(stats).toMatchObject({ joins: 2, leaves: 1 });

    await handleMessagingWebhook(deps, "fake", {
      event: "LoggedOut",
      instanceId: row?.instanceId,
      instanceToken: token,
      data: {},
    });
    const [acc] = await deps.db
      .select()
      .from(messagingAccounts)
      .where(eq(messagingAccounts.id, account.id));
    expect(acc?.status).toBe("logged_out");
  });
});

describe("regras automáticas", () => {
  it("agenda 1 oferta por grupo, filtra por palavra-chave e não repete enquanto há pendente", async () => {
    const { ctx, seg } = await setup();
    await approvedOffer(ctx, "air fryer", 0);
    await approvedOffer(ctx, "fone", 0);
    done(
      await upsertAutomationRule(ctx, {
        name: "Cozinha",
        segment_ids: [seg.id],
        filters: { keywords: ["air fryer"] },
        windows: [],
      }),
    );
    const first = await runAutomationRules(deps);
    expect(first.scheduled).toBe(3);
    const planned = (await listPosts(ctx, { status: "scheduled" })).items;
    expect(planned.every((p) => p.title?.toLowerCase().includes("air fryer"))).toBe(true);
    expect((await runAutomationRules(deps)).scheduled).toBe(0);
  });
});

describe("modelos e fuso", () => {
  it("remove linhas com variável vazia", () => {
    const out = renderTemplate(
      "*{{titulo}}*\nDe ~{{preco_original}}~\nPor {{preco}}\n🎟️ {{cupom}}",
      {
        titulo: "Fone",
        preco: "R$ 10,00",
        preco_original: null,
        cupom: "",
      },
    );
    expect(out).toBe("*Fone*\nPor R$ 10,00");
  });

  it("prévia usa o modelo padrão com link de exemplo", async () => {
    const { ctx } = await setup();
    const { offer } = await approvedOffer(ctx);
    const p = await previewPost(ctx, { offer_id: offer.id });
    expect(p.body).toContain(offer.title);
    expect(p.image_url).toMatch(/^https:/);
  });

  it("próxima janela no fuso de São Paulo", () => {
    // 10:00 em SP (13:00 UTC) com janela 20:00-23:00 → 20:00 SP (23:00 UTC) do mesmo dia.
    const at = new Date("2026-11-10T13:00:00Z");
    expect(nextAllowedTime(at, ["20:00-23:00"], "America/Sao_Paulo").toISOString()).toBe(
      "2026-11-10T23:00:00.000Z",
    );
    // 23:30 SP → 20:00 do dia seguinte.
    const late = new Date("2026-11-11T02:30:00Z");
    expect(nextAllowedTime(late, ["20:00-23:00"], "America/Sao_Paulo").toISOString()).toBe(
      "2026-11-11T23:00:00.000Z",
    );
  });
});

describe("envio sem mensagem dobrada", () => {
  it("timeout depois de chamar o envio vira falha sem nova tentativa", async () => {
    const { ctx, channels: chs } = await setup();
    done(await schedulePosts(ctx, { text: "Oi", channel_ids: [chs[0]?.id ?? ""], at: past() }));
    fakeMessagingControls.failNext = "TIMEOUT";
    const [r] = await runPublisher(deps);
    expect(r?.status).toBe("failed");
    expect(r?.reason).toContain("pode ter saído");
    expect((await listPosts(ctx, { status: "scheduled" })).items).toHaveLength(0);
  });

  it("post travado em 'sending': reenvia só se o envio não tinha começado", async () => {
    const { ctx, channels: chs } = await setup();
    const ch = chs[0];
    if (!ch) throw new Error("sem canal");
    const old = new Date(Date.now() - 10 * 60_000);
    const base = {
      workspaceId: ctx.actor.workspaceId,
      channelId: ch.id,
      status: "sending" as const,
      scheduledAt: old,
      createdBy: "teste",
    };
    const [started] = await deps.db
      .insert(posts)
      .values({ ...base, customText: "já chamou o WhatsApp", sendStartedAt: old })
      .returning();
    const [notStarted] = await deps.db
      .insert(posts)
      .values({ ...base, customText: "caiu antes de enviar" })
      .returning();
    // Envelhece updated_at pelo SQL (o $onUpdate do Drizzle sobrescreveria) para simular o processo que caiu.
    await deps.db.execute(
      sql`update posts set updated_at = ${old.toISOString()} where channel_id = ${ch.id}`,
    );

    const results = await runPublisher(deps);
    expect(results.map((x) => x.id)).toEqual([notStarted?.id]);
    expect(results[0]?.status).toBe("sent");
    const [lost] = await deps.db
      .select()
      .from(posts)
      .where(eq(posts.id, started?.id ?? ""));
    expect(lost).toMatchObject({ status: "failed" });
    expect(lost?.error).toContain("pode ter saído");
    expect(
      fakeMessagingControls.sent.filter((m) => m.text === "já chamou o WhatsApp"),
    ).toHaveLength(0);
  });

  it("retentativa reaproveita o link rastreado do post", async () => {
    const { ctx, channels: chs } = await setup();
    const { offer } = await approvedOffer(ctx);
    const ch = chs[0];
    done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [ch?.id ?? ""],
        at: past(),
        with_image: false,
      }),
    );
    fakeMessagingControls.failNext = "UNAVAILABLE";
    expect((await runPublisher(deps))[0]?.status).toBe("rescheduled");
    await deps.db
      .update(posts)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(posts.channelId, ch?.id ?? ""));
    expect((await runPublisher(deps))[0]?.status).toBe("sent");

    const [p] = (await listPosts(ctx, { status: "sent" })).items;
    const links = await deps.db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.postId, p?.id ?? ""));
    expect(links).toHaveLength(1);
  });
});
