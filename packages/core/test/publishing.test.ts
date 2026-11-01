import { fakeAffiliateControls, fakeMessagingControls } from "@ofertas/connectors";
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
  type Ctx,
  cancelPost,
  connectAffiliateAccount,
  createMessagingAccount,
  type Deps,
  deleteSegment,
  deleteSentPost,
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
  syncGroups,
  updateChannel,
  updatePreferences,
  upsertAutomationRule,
  upsertSegment,
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
