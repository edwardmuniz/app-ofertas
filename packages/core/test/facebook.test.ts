import { fakeAffiliateControls } from "@ofertas/connectors";
import { facebookAccounts, limits, posts } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addFacebookGroup,
  analyzeFacebookGroup,
  authenticateToken,
  browserJobImage,
  type Ctx,
  claimBrowserJob,
  completeBrowserJob,
  completeUpload,
  connectAffiliateAccount,
  createToken,
  type Deps,
  discoverFacebookGroups,
  facebookHeartbeat,
  listChannels,
  listFacebookAccounts,
  listPosts,
  prepareFacebookJoin,
  receiveUpload,
  recoverBrowserJobs,
  requestUpload,
  resolveSession,
  resumeFacebookAccount,
  runPublisher,
  saveOffer,
  schedulePosts,
  searchOffers,
  setGroupPostingPolicy,
} from "../src";
import { createOwner, fakeFetchMedia, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});
afterEach(() => {
  fakeAffiliateControls.reset();
});

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

let fbSeq = 100000;

/** Workspace com o token da extensão, um perfil do Facebook online e dois grupos. */
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
  const t = await createToken(ctx, { name: "extensão", preset: "extension" });
  const actor = await authenticateToken(deps, t.token, "rest");
  if (!actor) throw new Error("token");
  const ext: Ctx = { ...deps, actor };
  const fbUserId = String(++fbSeq);
  await facebookHeartbeat(ext, { fb_user_id: fbUserId, name: "Perfil Teste" });
  const g1 = done(
    await addFacebookGroup(ext, { fb_user_id: fbUserId, group_id: "111111", name: "Achados" }),
  );
  const g2 = done(
    await addFacebookGroup(ext, { fb_user_id: fbUserId, group_id: "222222", name: "Promoções" }),
  );
  // Grupos precisam aceitar divulgação para receber post (trava de política).
  for (const g of [g1, g2]) await setGroupPostingPolicy(ctx, g.id, { posting_policy: "allowed" });
  return { ctx, ext, fbUserId, groups: [g1, g2] };
}

const past = () => new Date(Date.now() - 60_000).toISOString();

async function postStatus(id: string) {
  const [p] = await deps.db.select().from(posts).where(eq(posts.id, id));
  return p;
}

describe("grupos do Facebook pela extensão", () => {
  it("audita a tentativa de entrada, aceita dry_run e limita a dez por dia", async () => {
    const { ext, fbUserId } = await setup();
    const input = { fb_user_id: fbUserId, group_id: "333333", name: "Grupo" };
    expect((await prepareFacebookJoin(ext, input, { dryRun: true })).status).toBe("dry_run");
    for (let n = 0; n < 10; n++) {
      const res = await prepareFacebookJoin(ext, { ...input, group_id: String(333333 + n) });
      expect(res.status).toBe("done");
    }
    await expect(prepareFacebookJoin(ext, { ...input, group_id: "444444" })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });
  it("agenda convite com imagem própria e entrega trabalho automático, sem oferta", async () => {
    const { ext, fbUserId, groups } = await setup();
    const png = (await fakeFetchMedia("x")).data;
    const ticket = done(
      await requestUpload(ext, {
        filename: "convite.png",
        mime: "image/png",
        size_bytes: png.length,
      }),
    );
    const url = new URL(ticket.put_url);
    await receiveUpload(
      deps,
      ticket.upload_id,
      Number(url.searchParams.get("e")),
      url.searchParams.get("s") ?? "",
      png,
    );
    const creative = done(await completeUpload(ext, { upload_id: ticket.upload_id }));
    const group = groups[0];
    if (!group) throw new Error("grupo");
    const planned = done(
      await schedulePosts(ext, {
        text: "Entre no grupo: https://chat.whatsapp.com/abc",
        channel_ids: [group.id],
        creative_id: creative.id,
        auto_publish: true,
        at: past(),
      }),
    );
    expect(planned.scheduled).toHaveLength(1);
    await runPublisher(deps);
    const job = await claimBrowserJob(ext, { fb_user_id: fbUserId });
    expect(job).toMatchObject({ auto_publish: true, has_image: true });
    expect(new Date(job?.lease_until ?? 0).getTime() - Date.now()).toBeGreaterThan(15 * 60_000);
    const image = await browserJobImage(ext, job?.id ?? "");
    expect(image.contentType).toBe("image/png");
  });
  it("monta buscas do nicho para a pessoa avaliar", async () => {
    const { ext } = await setup();
    const result = discoverFacebookGroups(ext, { niche: "  casa  ", location: "São Paulo" });
    expect(result.searches).toHaveLength(3);
    expect(result.searches[0]).toEqual({
      query: "casa São Paulo",
      url: "https://www.facebook.com/search/groups/?q=casa%20S%C3%A3o%20Paulo",
    });
  });
  it("registra o perfil e o grupo pela extensão", async () => {
    const { ctx, groups } = await setup();
    expect(groups[0]).toMatchObject({
      type: "fb_group",
      external_id: "111111",
      invite_url: "https://www.facebook.com/groups/111111",
    });
    const [acc] = await listFacebookAccounts(ctx);
    expect(acc).toMatchObject({
      name: "Perfil Teste",
      online: true,
      group_count: 2,
      posts_today: 0,
    });
  });

  it("publica pela extensão e grava o link do post", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    const g = groups[0];
    if (!g) throw new Error("grupo");
    const res = done(
      await schedulePosts(ctx, { text: "Oferta do dia", channel_ids: [g.id], at: past() }),
    );
    const postId = res.scheduled[0]?.id ?? "";
    const run = await runPublisher(deps);
    expect(run.find((x) => x.id === postId)?.status).toBe("queued");
    // Esperando a extensão: continua "sending" e não volta para a fila.
    expect((await postStatus(postId))?.status).toBe("sending");
    expect(await runPublisher(deps)).not.toContainEqual(expect.objectContaining({ id: postId }));

    const job = await claimBrowserJob(ext, { fb_user_id: fbUserId });
    expect(job).toMatchObject({ group_id: "111111", text: "Oferta do dia", has_image: false });
    // Ninguém pega o mesmo trabalho duas vezes.
    expect(await claimBrowserJob(ext, { fb_user_id: fbUserId })).toBeNull();

    const url = "https://www.facebook.com/groups/111111/posts/999";
    await completeBrowserJob(ext, job?.id ?? "", { ok: true, post_id: "999", post_url: url });
    const sent = (await listPosts(ctx, {})).items.find((p) => p.id === postId);
    expect(sent).toMatchObject({ status: "sent", external_url: url, error: null });
    const [acc] = await listFacebookAccounts(ctx);
    expect(acc?.posts_today).toBe(1);
  });

  it("extensão desligada não publica e avisa o motivo", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    // Último contato da extensão há 20 min: fora da janela de online.
    const [acc] = await listFacebookAccounts(ctx);
    await deps.db
      .update(facebookAccounts)
      .set({ lastSeenAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(facebookAccounts.id, acc?.id ?? ""));
    const res = done(
      await schedulePosts(ctx, { text: "Oi", channel_ids: [groups[0]?.id ?? ""], at: past() }),
    );
    const postId = res.scheduled[0]?.id ?? "";
    await runPublisher(deps);
    const p = await postStatus(postId);
    expect(p?.status).toBe("scheduled");
    expect(p?.error).toContain("Extensão desligada");
    // Nada na fila da extensão enquanto ela está offline.
    await facebookHeartbeat(ext, { fb_user_id: fbUserId });
    expect(await claimBrowserJob(ext, { fb_user_id: fbUserId })).toBeNull();
  });

  it("respeita 1 post por grupo por dia e o intervalo entre posts do perfil", async () => {
    const { ctx, groups } = await setup();
    const [g1, g2] = groups;
    if (!g1 || !g2) throw new Error("grupos");
    const a = done(await schedulePosts(ctx, { text: "A", channel_ids: [g1.id], at: past() }));
    await runPublisher(deps);
    expect((await postStatus(a.scheduled[0]?.id ?? ""))?.status).toBe("sending");

    const b = done(
      await schedulePosts(ctx, { text: "B", channel_ids: [g1.id, g2.id], at: past() }),
    );
    await runPublisher(deps);
    const same = await postStatus(b.scheduled.find((x) => x.channel_id === g1.id)?.id ?? "");
    const other = await postStatus(b.scheduled.find((x) => x.channel_id === g2.id)?.id ?? "");
    // Mesmo grupo: só daqui a ~24 h. Outro grupo: depois do intervalo de 3 a 8 min.
    expect(same?.status).toBe("scheduled");
    expect((same?.scheduledAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(other?.status).toBe("scheduled");
    const wait = (other?.scheduledAt.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(2 * 60_000);
    expect(wait).toBeLessThan(9 * 60_000);
  });

  it("bloqueio do Facebook pausa o perfil por 24 h e só pessoa religa", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    const res = done(
      await schedulePosts(ctx, { text: "X", channel_ids: [groups[0]?.id ?? ""], at: past() }),
    );
    const postId = res.scheduled[0]?.id ?? "";
    await runPublisher(deps);
    const job = await claimBrowserJob(ext, { fb_user_id: fbUserId });
    await completeBrowserJob(ext, job?.id ?? "", {
      ok: false,
      error_kind: "blocked",
      error: "Você está temporariamente bloqueado",
    });
    const [acc] = await listFacebookAccounts(ctx);
    expect(acc?.paused_until).not.toBeNull();
    expect(acc?.pause_reason).toContain("bloqueado");
    // O post volta para depois da pausa, sem contar como falha.
    const p = await postStatus(postId);
    expect(p?.status).toBe("scheduled");
    expect((p?.scheduledAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await claimBrowserJob(ext, { fb_user_id: fbUserId })).toBeNull();

    await expect(resumeFacebookAccount(ext, acc?.id ?? "")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    done(await resumeFacebookAccount(ctx, acc?.id ?? ""));
    expect((await listFacebookAccounts(ctx))[0]?.paused_until).toBeNull();
  });

  it("grupo que não deixa postar é pausado e não recebe mais posts", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    const g = groups[0];
    if (!g) throw new Error("grupo");
    const res = done(await schedulePosts(ctx, { text: "W", channel_ids: [g.id], at: past() }));
    await runPublisher(deps);
    const job = await claimBrowserJob(ext, { fb_user_id: fbUserId });
    await completeBrowserJob(ext, job?.id ?? "", {
      ok: false,
      error_kind: "not_member",
      error: "Grupo não deixa postar.",
    });
    const p = await postStatus(res.scheduled[0]?.id ?? "");
    expect(p?.status).toBe("failed");
    const channel = (await listChannels(ctx)).find((c) => c.id === g.id);
    expect(channel?.status).toBe("paused");
  });

  it("trabalho pego e sem resposta vira falha sem repetir (pode ter saído)", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    const res = done(
      await schedulePosts(ctx, { text: "Z", channel_ids: [groups[0]?.id ?? ""], at: past() }),
    );
    const postId = res.scheduled[0]?.id ?? "";
    await runPublisher(deps);
    await claimBrowserJob(ext, { fb_user_id: fbUserId });
    const later = new Date(Date.now() + 6 * 60_000);
    const r = await recoverBrowserJobs({ ...deps, now: () => later });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const p = await postStatus(postId);
    expect(p?.status).toBe("failed");
    expect(p?.error).toContain("pode ter saído");
  });

  it("não agenda ofertas nos grupos do Facebook", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    await connectAffiliateAccount(ctx, { platform: "shopee", label: "Shopee", mode: "fake" });
    const { items } = await searchOffers(ctx, { keyword: "air fryer", limit: 1 });
    const offer = done(await saveOffer(ctx, { product_id: items[0]?.product_id ?? "" }));
    const planned = done(
      await schedulePosts(ctx, {
        offer_ids: [offer.id],
        channel_ids: [groups[0]?.id ?? ""],
        at: past(),
      }),
    );
    expect(planned.scheduled).toHaveLength(0);
    expect(planned.skipped[0]?.reason).toContain("apenas convites");
    expect(await claimBrowserJob(ext, { fb_user_id: fbUserId })).toBeNull();
  });

  it("token sem o escopo da extensão não pega trabalhos", async () => {
    const { ctx, fbUserId } = await setup();
    const t = await createToken(ctx, { name: "leitura", preset: "read_only" });
    const actor = await authenticateToken(deps, t.token, "mcp");
    if (!actor) throw new Error("token");
    await expect(
      claimBrowserJob({ ...deps, actor }, { fb_user_id: fbUserId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SCOPE" });
  });

  it("analisa um grupo e bloqueia o agendamento em grupo que não aceita divulgação", async () => {
    const { ctx, ext, fbUserId } = await setup();
    const res = done(
      await analyzeFacebookGroup(ext, {
        fb_user_id: fbUserId,
        group_id: "333333",
        name: "Só assuntos do bairro",
        collected: {
          rules_text: "É proibida a divulgação de links e vendas. Quem divulgar será removido.",
          post_texts: ["bom dia", "reunião amanhã"],
        },
      }),
    );
    expect(res.policy).toBe("forbidden");
    const channel = (await listChannels(ctx)).find((c) => c.external_id === "333333");
    expect(channel?.posting_policy).toBe("forbidden");
    // Agendar nesse grupo é recusado na prévia.
    const sched = done(
      await schedulePosts(ctx, { text: "oi", channel_ids: [channel?.id ?? ""], at: past() }),
    );
    expect(sched.scheduled).toHaveLength(0);
    expect(sched.skipped[0]?.reason).toContain("não aceita divulgação");
  });

  it("grupo com membros divulgando é detectado como allowed e pode receber post", async () => {
    const { ctx, ext, fbUserId } = await setup();
    const res = done(
      await analyzeFacebookGroup(ext, {
        fb_user_id: fbUserId,
        group_id: "444444",
        name: "Achadinhos SP",
        collected: {
          rules_text: "Grupo de achadinhos.",
          post_texts: [
            "air fryer na shopee R$ 199 🔥",
            "cupom amazon 10% off",
            "meli.la/x oferta",
            "bom dia pessoal",
          ],
        },
      }),
    );
    expect(res.policy).toBe("allowed");
    const channel = (await listChannels(ctx)).find((c) => c.external_id === "444444");
    const sched = done(
      await schedulePosts(ctx, { text: "convite", channel_ids: [channel?.id ?? ""], at: past() }),
    );
    expect(sched.scheduled).toHaveLength(1);
  });

  it("correção humana da política não é trocada pela detecção automática", async () => {
    const { ctx, ext, fbUserId, groups } = await setup();
    const g = groups[0];
    if (!g) throw new Error("grupo");
    // Pessoa marca como proibido.
    done(
      await setGroupPostingPolicy(ctx, g.id, { posting_policy: "forbidden", notes: "dono pediu" }),
    );
    // Nova análise diz "allowed", mas a decisão humana manda.
    const res = done(
      await analyzeFacebookGroup(ext, {
        fb_user_id: fbUserId,
        group_id: g.external_id ?? "",
        name: g.name,
        collected: { rules_text: "Divulgação liberada.", post_texts: [] },
      }),
    );
    expect(res.kept_human).toBe(true);
    const channel = (await listChannels(ctx)).find((c) => c.id === g.id);
    expect(channel?.posting_policy).toBe("forbidden");
  });
});
