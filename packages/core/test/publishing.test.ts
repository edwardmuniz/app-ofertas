import { fakeAffiliateControls, fakeMessagingControls } from "@ofertas/connectors";
import {
  channelStatsDaily,
  channels,
  limits,
  messagingAccounts,
  posts,
  trackedLinks,
} from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  cancelPost,
  connectAffiliateAccount,
  createMessagingAccount,
  type Deps,
  deleteSentPost,
  getConnectionState,
  handleMessagingWebhook,
  listPosts,
  nextAllowedTime,
  previewPost,
  renderTemplate,
  resolveSession,
  runAutomationRules,
  runPublisher,
  saveOffer,
  schedulePosts,
  searchOffers,
  setChannelAdminOnly,
  syncGroups,
  updatePreferences,
  upsertAutomationRule,
  upsertChannel,
  upsertSegment,
} from "../src";
import { createOwner, setupTestDeps } from "./helpers";

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
  const synced = done(await syncGroups(ctx, account.id));
  const seg = done(await upsertSegment(ctx, { name: `seg-${Date.now()}` }));
  for (const ch of synced.channels) await upsertChannel(ctx, { id: ch.id, segment_ids: [seg.id] });
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
    const again = done(await syncGroups(ctx, account.id));
    expect(again).toMatchObject({ created: 0, updated: 3 });
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
    const manual = done(await upsertChannel(ctx, { name: "Manual" }));
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
      event: "participants",
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
