import { FAKE_OWN_USER, fakeMessagingControls } from "@ofertas/connectors";
import { channels, limits, messagingAccounts, posts } from "@ofertas/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Ctx,
  connectAffiliateAccount,
  createCommunity,
  createGroup,
  createMessagingAccount,
  type Deps,
  getConnectionState,
  getGroup,
  handleMessagingWebhook,
  joinGroup,
  leaveGroup,
  linkCommunityGroups,
  listAlerts,
  listTeamContacts,
  manageGroupParticipants,
  resetGroupInvite,
  resolveSession,
  runHealthChecks,
  saveOffer,
  schedulePosts,
  searchOffers,
  updateGroup,
  updateGroupSettings,
  upsertSegment,
  upsertTeamContact,
} from "../src";
import { createOwner, setupTestDeps } from "./helpers";

let deps: Deps & { close: () => Promise<void> };

beforeAll(async () => {
  deps = await setupTestDeps();
});
afterAll(async () => {
  await deps.close();
});
afterEach(() => fakeMessagingControls.reset());

function done<T>(res: { status: string; result?: T }): T {
  if (res.status !== "done" || !res.result) throw new Error(`esperado done, veio ${res.status}`);
  return res.result;
}

const OWNER_PHONE = "5511988887777";
const RESERVE_PHONE = "5511977776666";

/** Workspace com número simulado conectado e equipe cadastrada. */
async function setup() {
  const s = await createOwner(deps);
  const r = await resolveSession(deps, s.sessionToken);
  if (!r) throw new Error("sessão");
  const ctx: Ctx = { ...deps, actor: r.actor };
  const account = done(await createMessagingAccount(ctx, { label: "N", provider: "fake" }));
  await getConnectionState(ctx, account.id);
  done(await upsertTeamContact(ctx, { phone: `+55 (11) 98888-7777`, label: "Dono" }));
  done(await upsertTeamContact(ctx, { phone: RESERVE_PHONE, label: "Número reserva" }));
  const agent: Ctx = { ...ctx, actor: { ...ctx.actor, type: "token" } };
  return { ctx, agent, account };
}

async function instanceOf(accountId: string) {
  const [acc] = await deps.db
    .select()
    .from(messagingAccounts)
    .where(eq(messagingAccounts.id, accountId));
  const inst = fakeMessagingControls.instances.get(acc?.instanceId ?? "");
  if (!acc || !inst) throw new Error("instância");
  return { acc, inst };
}

async function newGroup(ctx: Ctx, accountId: string, name = "Ofertas Casa") {
  return done(await createGroup(ctx, { account_id: accountId, name, participants: [OWNER_PHONE] }));
}

describe("números da equipe", () => {
  it("normaliza o telefone e só humano cadastra", async () => {
    const { ctx, agent } = await setup();
    const team = await listTeamContacts(ctx);
    expect(team.map((t) => t.phone)).toEqual([OWNER_PHONE, RESERVE_PHONE]);
    await expect(
      upsertTeamContact(agent, { phone: "5511900000000", label: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("criar grupo", () => {
  it("cria com só admins, só admins editam, link de convite e segmento", async () => {
    const { ctx, account } = await setup();
    const seg = done(await upsertSegment(ctx, { name: `casa-${Date.now()}` }));
    const res = done(
      await createGroup(ctx, {
        account_id: account.id,
        name: "Ofertas Casa #2",
        participants: [OWNER_PHONE],
        description: "Só ofertas. Política: https://x.test",
        photo_url: "https://img.test/logo.jpg",
        segment_ids: [seg.id],
      }),
    );
    expect(res.pending).toEqual([]);
    expect(res.channel).toMatchObject({
      name: "Ofertas Casa #2",
      admin_only: true,
      locked: true,
      admins_add_members: true,
      number_is_admin: true,
      segment_ids: [seg.id],
      member_count: 2,
    });
    expect(res.channel.invite_url).toMatch(/^https:\/\/chat\.whatsapp\.com\//);
    const { inst } = await instanceOf(account.id);
    const g = inst.groups.get(res.channel.external_id ?? "");
    expect(g).toMatchObject({
      adminOnly: true,
      locked: true,
      photoUrl: expect.stringMatching(/^data:image\/jpeg;base64,\/9j\//),
    });
  });

  it("se o WhatsApp demora a responder, acha o grupo criado em vez de criar outro", async () => {
    const { ctx, account } = await setup();
    fakeMessagingControls.createTimesOut = true;
    const res = await newGroup(ctx, account.id, "Lento");
    expect(res.channel).toMatchObject({ name: "Lento", admin_only: true });
    const { inst } = await instanceOf(account.id);
    expect([...inst.groups.values()].filter((g) => g.name === "Lento")).toHaveLength(1);
  });

  it("recusa participante fora da equipe, nome longo e agente", async () => {
    const { ctx, agent, account } = await setup();
    await expect(
      createGroup(ctx, { account_id: account.id, name: "X", participants: ["5521912345678"] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { not_in_team: ["5521912345678"] },
    });
    await expect(
      createGroup(ctx, {
        account_id: account.id,
        name: "a".repeat(26),
        participants: [OWNER_PHONE],
      }),
    ).rejects.toThrow(/25 caracteres/);
    await expect(
      createGroup(agent, { account_id: account.id, name: "X", participants: [OWNER_PHONE] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("editar grupo", () => {
  it("detalhes mostram admins (equipe sem máscara) e atualizam o canal", async () => {
    const { ctx, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    done(
      await manageGroupParticipants(ctx, channel.id, { action: "promote", phones: [OWNER_PHONE] }),
    );
    const { inst } = await instanceOf(account.id);
    const g = inst.groups.get(channel.external_id ?? "");
    if (!g) throw new Error("grupo");
    g.participants.push("5521912345678");
    g.admins.push("5521912345678");
    g.name = "Mudou no celular";

    const d = await getGroup(ctx, channel.id);
    expect(d.channel.name).toBe("Mudou no celular");
    expect(d.admins).toEqual([
      { phone: `+${FAKE_OWN_USER}`, is_self: true, team_label: null },
      { phone: `+${OWNER_PHONE}`, is_self: false, team_label: "Dono" },
      { phone: "+55 21 •••••-5678", is_self: false, team_label: null },
    ]);
    expect(d.team_in_group).toEqual([{ phone: OWNER_PHONE, label: "Dono", is_admin: true }]);
  });

  it("nome, descrição, foto e as 4 configurações; agente pode editar", async () => {
    const { ctx, agent, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    const dry = await updateGroup(agent, channel.id, { name: "Novo" }, { dryRun: true });
    expect(dry.status).toBe("dry_run");
    const upd = done(
      await updateGroup(agent, channel.id, {
        name: "Novo",
        description: "",
        photo_url: "https://i.test/a.jpg",
      }),
    );
    expect(upd).toMatchObject({ name: "Novo", description: null });
    const s = done(
      await updateGroupSettings(agent, channel.id, {
        admin_only: false,
        locked: false,
        approval_required: true,
        admins_add_members: false,
      }),
    );
    expect(s).toMatchObject({
      admin_only: false,
      locked: false,
      approval_required: true,
      admins_add_members: false,
    });
    const { inst } = await instanceOf(account.id);
    expect(inst.groups.get(channel.external_id ?? "")).toMatchObject({
      name: "Novo",
      adminOnly: false,
      approvalRequired: true,
      adminsAddMembers: false,
    });
    await expect(updateGroupSettings(ctx, channel.id, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("troca só a foto (convertida para JPEG)", async () => {
    const { ctx, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    const res = done(
      await updateGroup(ctx, channel.id, { photo_url: "https://img.test/foto.png" }),
    );
    expect(res.name).toBe(channel.name);
    const { inst } = await instanceOf(account.id);
    expect(inst.groups.get(channel.external_id ?? "")?.photoUrl).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it("novo link de convite revoga o anterior (só humano)", async () => {
    const { ctx, agent, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    const after = done(await resetGroupInvite(ctx, channel.id));
    expect(after.invite_url).not.toBe(channel.invite_url);
    await expect(resetGroupInvite(agent, channel.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("participantes", () => {
  it("adiciona só equipe, confirma relendo o grupo e respeita o limite diário", async () => {
    const { ctx, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    await expect(
      manageGroupParticipants(ctx, channel.id, { action: "add", phones: ["5521912345678"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const added = done(
      await manageGroupParticipants(ctx, channel.id, { action: "add", phones: [RESERVE_PHONE] }),
    );
    expect(added).toEqual({ action: "add", done: [RESERVE_PHONE], failed: [] });
    const promoted = done(
      await manageGroupParticipants(ctx, channel.id, {
        action: "promote",
        phones: [RESERVE_PHONE],
      }),
    );
    expect(promoted.done).toEqual([RESERVE_PHONE]);
    // Promover quem não está no grupo não acontece: aparece em failed.
    const ghost = done(
      await manageGroupParticipants(ctx, channel.id, {
        action: "promote",
        phones: ["5511955554444"],
      }),
    );
    expect(ghost).toMatchObject({ done: [], failed: ["5511955554444"] });

    await deps.db
      .insert(limits)
      .values({ workspaceId: ctx.actor.workspaceId, key: "groups.add_per_day", value: 1 });
    done(
      await manageGroupParticipants(ctx, channel.id, { action: "remove", phones: [RESERVE_PHONE] }),
    );
    await expect(
      manageGroupParticipants(ctx, channel.id, { action: "add", phones: [RESERVE_PHONE] }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

describe("entrar e sair", () => {
  it("entra por link e importa; sem grupo novo fica pendente", async () => {
    const { ctx, account } = await setup();
    const seg = done(await upsertSegment(ctx, { name: `parceiro-${Date.now()}` }));
    fakeMessagingControls.invites.set("CONVITE12345", {
      jid: "120363999000000001@g.us",
      name: "Grupo do parceiro",
      participantCount: 400,
      adminOnly: true,
      isAdmin: false,
    });
    const res = done(
      await joinGroup(ctx, account.id, {
        invite_url: "https://chat.whatsapp.com/CONVITE12345",
        segment_ids: [seg.id],
      }),
    );
    expect(res.status).toBe("joined");
    expect(res.channels[0]).toMatchObject({
      name: "Grupo do parceiro",
      number_is_admin: false,
      segment_ids: [seg.id],
    });
    // Entrar de novo: nada novo aparece → pendente (ou já estava no grupo).
    expect(done(await joinGroup(ctx, account.id, { invite_url: "CONVITE12345" })).status).toBe(
      "pending",
    );
    await expect(joinGroup(ctx, account.id, { invite_url: "INVALIDO000" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("sair avisa se é o único admin, arquiva e cancela agendados", async () => {
    const { ctx, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    await connectAffiliateAccount(ctx, { platform: "shopee", label: "S", mode: "fake" });
    const { items } = await searchOffers(ctx, { keyword: "air fryer", limit: 1 });
    const offer = done(await saveOffer(ctx, { product_id: items[0]?.product_id ?? "" }));
    const future = new Date(Date.now() + 86_400_000).toISOString();
    done(
      await schedulePosts(ctx, { offer_ids: [offer.id], channel_ids: [channel.id], at: future }),
    );

    const dry = await leaveGroup(ctx, channel.id, { dryRun: true });
    expect(dry).toMatchObject({ preview: { only_admin: true, scheduled_posts_canceled: 1 } });
    const res = done(await leaveGroup(ctx, channel.id));
    expect(res).toMatchObject({ channel: { status: "archived" }, scheduled_posts_canceled: 1 });
    const { inst } = await instanceOf(account.id);
    expect(inst.groups.has(channel.external_id ?? "")).toBe(false);
    const rows = await deps.db.select().from(posts).where(eq(posts.channelId, channel.id));
    expect(rows.every((p) => p.status === "canceled")).toBe(true);
  });
});

describe("comunidades", () => {
  it("cria comunidade, liga grupos e confere relendo", async () => {
    const { ctx, account } = await setup();
    const community = done(
      await createCommunity(ctx, { account_id: account.id, name: "Ofertas BR" }),
    );
    expect(community.type).toBe("wa_community");
    const { channel: g1 } = await newGroup(ctx, account.id, "Casa");
    const { channel: g2 } = await newGroup(ctx, account.id, "Tech");
    const res = done(
      await linkCommunityGroups(ctx, community.id, { channel_ids: [g1.id, g2.id], link: true }),
    );
    expect(res).toEqual({ done: ["Casa", "Tech"], failed: [] });
    const d = await getGroup(ctx, community.id);
    expect(d.linked_groups.map((g) => g.name).sort()).toEqual(["Casa", "Tech"]);
    expect((await getGroup(ctx, g1.id)).community).toEqual({
      id: community.id,
      name: "Ofertas BR",
    });

    await expect(
      linkCommunityGroups(ctx, g1.id, { channel_ids: [g2.id], link: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    done(await linkCommunityGroups(ctx, community.id, { channel_ids: [g1.id], link: false }));
    const [row] = await deps.db.select().from(channels).where(eq(channels.id, g1.id));
    expect(row?.communityJid).toBeNull();
  });
});

describe("webhook de grupo", () => {
  it("mudanças pelo celular atualizam o canal; perder admin e suspensão viram alerta", async () => {
    const { ctx, account } = await setup();
    const { channel } = await newGroup(ctx, account.id);
    const { acc } = await instanceOf(account.id);
    const send = (data: Record<string, unknown>) =>
      handleMessagingWebhook(deps, "fake", {
        event: "GroupInfo",
        instanceId: acc.instanceId,
        instanceToken: deps.secrets.decrypt(acc.token),
        data: { JID: channel.external_id, ...data },
      });

    await send({
      Name: { Name: "Nome do celular" },
      Topic: { Topic: "Nova descrição" },
      Locked: { IsLocked: false },
      NewInviteLink: "LINKNOVO1234",
      Demote: [`${FAKE_OWN_USER}:4@s.whatsapp.net`],
    });
    let [row] = await deps.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row).toMatchObject({
      name: "Nome do celular",
      description: "Nova descrição",
      locked: false,
      inviteUrl: "https://chat.whatsapp.com/LINKNOVO1234",
      numberIsAdmin: false,
    });

    await send({ Suspended: true });
    [row] = await deps.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row).toMatchObject({ providerState: "suspended", status: "paused" });

    await runHealthChecks(deps);
    const open = await listAlerts(ctx, { status: "open" });
    const kinds = open
      .filter((a) => (a.details as { channel_id?: string }).channel_id === channel.id)
      .map((a) => a.kind);
    expect(kinds).toContain("group_unavailable");

    await send({ Unsuspended: true, Promote: [`${FAKE_OWN_USER}@s.whatsapp.net`] });
    [row] = await deps.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row).toMatchObject({ providerState: "ok", numberIsAdmin: true });
  });
});
