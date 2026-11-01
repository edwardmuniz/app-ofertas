import { afterEach, describe, expect, it } from "vitest";
import {
  EvolutionGoProvider,
  FakeMessagingProvider,
  fakeMessagingControls,
  parseEvolutionWebhook,
} from "../src";

afterEach(() => fakeMessagingControls.reset());

function evo(responses: Record<string, unknown>) {
  const calls: {
    method: string;
    path: string;
    apikey: string;
    contentType: string;
    body: unknown;
  }[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? "GET",
      path,
      apikey: headers.get("apikey") ?? "",
      contentType: headers.get("content-type") ?? "",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[`${init.method} ${path}`];
    if (r instanceof Response) return r;
    return Response.json(r ?? { message: "success" });
  }) as unknown as typeof fetch;
  const p = new EvolutionGoProvider({
    baseUrl: "http://evo:4010/",
    globalKey: "GLOBAL",
    fetch: fetchMock,
  });
  return { p, calls };
}

const ref = { instanceId: "inst-1", token: "TOKEN-1" };

describe("Evolution Go", () => {
  it("cria instância com a chave global e usa o token da instância no resto", async () => {
    const { p, calls } = evo({
      "POST /instance/create": { data: { id: "inst-1", token: "TOKEN-1" } },
    });
    expect(await p.createInstance("ofertas")).toEqual(ref);
    await p.connect(ref, { webhookUrl: "https://app/webhooks/evolution" });
    expect(calls[0]?.apikey).toBe("GLOBAL");
    expect(calls[1]).toMatchObject({
      path: "/instance/connect",
      apikey: "TOKEN-1",
      body: {
        webhookUrl: "https://app/webhooks/evolution",
        subscribe: ["GROUP", "CONNECTION", "QRCODE"],
      },
    });
  });

  it("lê QR, status e grupos nos dois formatos documentados", async () => {
    const a = evo({
      "GET /instance/qr": { data: { Qrcode: "data:image/png;base64,AAA", Code: "2@xyz" } },
      "GET /instance/status": { data: { Connected: true, LoggedIn: true, Name: "Loja" } },
      "GET /group/list": {
        data: [
          { JID: "1@g.us", Name: "Tech", ParticipantCount: 300, IsAnnounce: true },
          { JID: "5511@s.whatsapp.net", Name: "não é grupo" },
        ],
      },
    });
    expect(await a.p.getQr(ref)).toEqual({ image: "data:image/png;base64,AAA", code: "2@xyz" });
    expect(await a.p.status(ref)).toMatchObject({ connected: true, loggedIn: true, name: "Loja" });
    expect(await a.p.listGroups(ref)).toEqual([
      { jid: "1@g.us", name: "Tech", participantCount: 300, adminOnly: true, isAdmin: null },
    ]);

    // Descobre se o número é admin pelos participantes (JID com aparelho ou só telefone).
    const c = evo({
      "GET /group/list": {
        data: [
          {
            JID: "3@g.us",
            Name: "Admin",
            Participants: [{ JID: "5511999@s.whatsapp.net", IsAdmin: true }],
          },
          {
            JID: "4@g.us",
            Name: "Membro",
            Participants: [{ JID: "abc@lid", PhoneNumber: "5511999@s.whatsapp.net" }],
          },
          { JID: "5@g.us", Name: "Sem mim", Participants: [{ JID: "5521@s.whatsapp.net" }] },
        ],
      },
    });
    const own = await c.p.listGroups(ref, { ownJid: "5511999:7@s.whatsapp.net" });
    expect(own.map((g) => g.isAdmin)).toEqual([true, false, null]);

    const b = evo({
      "GET /instance/qr": { success: true, qrCode: "BBB" },
      "GET /group/list": { groups: [{ JID: "2@g.us", Name: "Casa", Participants: [{}, {}] }] },
    });
    expect((await b.p.getQr(ref)).image).toBe("data:image/png;base64,BBB");
    expect((await b.p.listGroups(ref))[0]?.participantCount).toBe(2);
  });

  it("envia imagem com legenda e devolve o id da mensagem", async () => {
    const { p, calls } = evo({ "POST /send/media": { data: { Info: { ID: "MSG1" } } } });
    expect(await p.sendImage(ref, "1@g.us", "https://img/1.jpg", "Oferta")).toEqual({
      messageId: "MSG1",
    });
    expect(calls[0]?.body).toEqual({
      number: "1@g.us",
      type: "image",
      url: "https://img/1.jpg",
      caption: "Oferta",
    });
  });

  it("gestão de grupos: rotas e campos da Evolution Go", async () => {
    const { p, calls } = evo({
      "POST /group/create": { data: { jid: "9@g.us", name: "Ofertas", failed: [] } },
      // JID real sem o 9º dígito (número brasileiro antigo).
      "POST /user/check": {
        data: {
          Users: [
            { Query: "+5521988887777", IsInWhatsapp: true, JID: "552188887777@s.whatsapp.net" },
          ],
        },
      },
      "POST /group/info": {
        data: {
          JID: "9@g.us",
          Name: "Ofertas",
          Topic: "Regras",
          IsAnnounce: true,
          IsLocked: true,
          IsJoinApprovalRequired: false,
          MemberAddMode: "admin_add",
          LinkedParentJID: "8@g.us",
          Participants: [
            { JID: "5511999@s.whatsapp.net", IsAdmin: true },
            { JID: "abc@lid", PhoneNumber: "5521888@s.whatsapp.net", IsSuperAdmin: true },
            { JID: "5531777@s.whatsapp.net" },
          ],
        },
      },
      "POST /group/invitelink": { data: "https://chat.whatsapp.com/NOVO" },
      "POST /community/create": { data: { JID: "8@g.us" } },
    });
    expect(await p.createGroup(ref, "Ofertas", ["5521988887777"])).toEqual({
      jid: "9@g.us",
      failed: [],
    });
    const info = await p.getGroupInfo(ref, "9@g.us", { ownJid: "5511999:2@s.whatsapp.net" });
    expect(info).toMatchObject({
      description: "Regras",
      adminOnly: true,
      locked: true,
      approvalRequired: false,
      adminsAddMembers: true,
      communityJid: "8@g.us",
      isAdmin: true,
      participants: ["5511999", "5521888", "5531777"],
      admins: ["5511999", "5521888"],
    });
    expect(await p.inviteLink(ref, "9@g.us", { reset: true })).toBe(
      "https://chat.whatsapp.com/NOVO",
    );
    await p.setGroupSetting(ref, "9@g.us", "approval_on");
    await p.updateParticipants(ref, "9@g.us", ["5521988887777"], "promote");
    await p.joinGroup(ref, " https://chat.whatsapp.com/XYZ ");
    expect(await p.createCommunity(ref, "Comunidade")).toEqual({ jid: "8@g.us" });
    await p.linkCommunityGroups(ref, "8@g.us", ["9@g.us"], true);
    const byPath = Object.fromEntries(calls.map((c) => [c.path, c.body]));
    expect(byPath["/user/check"]).toEqual({ number: ["+5521988887777"], formatJid: false });
    expect(byPath["/group/create"]).toEqual({
      groupName: "Ofertas",
      participants: ["552188887777@s.whatsapp.net"],
    });
    expect(byPath["/group/invitelink"]).toEqual({ groupJid: "9@g.us", reset: true });
    expect(byPath["/group/settings"]).toEqual({ groupJid: "9@g.us", action: "approval_on" });
    expect(byPath["/group/participant"]).toEqual({
      groupJid: "9@g.us",
      participants: ["552188887777@s.whatsapp.net"],
      action: "promote",
    });
    expect(calls.find((c) => c.path === "/group/participant")?.contentType).toBe("text/plain");

    // Número sem WhatsApp: recusa antes de chamar a criação.
    const none = evo({ "POST /user/check": { data: { Users: [] } } });
    await expect(none.p.createGroup(ref, "X", ["5511900000000"])).rejects.toMatchObject({
      code: "INVALID",
    });
    expect(none.calls.map((c) => c.path)).toEqual(["/user/check"]);
    expect(byPath["/group/join"]).toEqual({ code: "https://chat.whatsapp.com/XYZ" });
    expect(byPath["/community/add"]).toMatchObject({
      communityJid: "8@g.us",
      groupJid: ["9@g.us"],
    });
  });

  it("converte erros", async () => {
    const { p } = evo({ "GET /instance/status": new Response("", { status: 401 }) });
    await expect(p.status(ref)).rejects.toMatchObject({ code: "AUTH" });
    const q = evo({
      "POST /send/text": Response.json({ error: "client not connected" }, { status: 400 }),
    });
    await expect(q.p.sendText(ref, "1@g.us", "x")).rejects.toMatchObject({ code: "NOT_CONNECTED" });

    // Sem resposta a tempo é diferente de servidor fora do ar: o envio pode ter acontecido.
    const timeout = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const t = new EvolutionGoProvider({ baseUrl: "http://evo", globalKey: "G", fetch: timeout });
    await expect(t.sendText(ref, "1@g.us", "x")).rejects.toMatchObject({ code: "TIMEOUT" });
    const r = new EvolutionGoProvider({ baseUrl: "http://evo", globalKey: "G", fetch: refused });
    await expect(r.sendText(ref, "1@g.us", "x")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("normaliza webhooks de conexão, QR e entrada/saída de membros", () => {
    const base = { instanceId: "inst-1", instanceToken: "TOKEN-1" };
    expect(
      parseEvolutionWebhook({
        ...base,
        event: "Connected",
        data: { status: "open", jid: "55@s", pushName: "Loja" },
      }),
    ).toEqual({ ...base, event: { kind: "connected", jid: "55@s", name: "Loja" } });
    expect(
      parseEvolutionWebhook({
        ...base,
        event: "GroupInfo",
        data: { JID: "1@g.us", Join: ["a", "b"], Leave: ["c"] },
      }).event,
    ).toEqual({
      kind: "group_update",
      groupJid: "1@g.us",
      joined: 2,
      left: 1,
      promoted: [],
      demoted: [],
    });
    // Mudanças feitas pelo celular: nome, descrição, configurações, admin, link, suspensão.
    expect(
      parseEvolutionWebhook({
        ...base,
        event: "GroupInfo",
        data: {
          JID: "1@g.us",
          Name: { Name: "Novo nome" },
          Topic: { Topic: "" },
          Announce: { IsAnnounce: true },
          Locked: { IsLocked: false },
          MembershipApprovalMode: { IsJoinApprovalRequired: true },
          Demote: ["5511999:3@s.whatsapp.net"],
          NewInviteLink: "ABCDEF123456",
          Suspended: true,
        },
      }).event,
    ).toEqual({
      kind: "group_update",
      groupJid: "1@g.us",
      joined: 0,
      left: 0,
      promoted: [],
      demoted: ["5511999"],
      name: "Novo nome",
      description: "",
      adminOnly: true,
      locked: false,
      approvalRequired: true,
      inviteLink: "https://chat.whatsapp.com/ABCDEF123456",
      suspended: true,
    });
    expect(
      parseEvolutionWebhook({ ...base, event: "QRCode", data: { qrcode: "data:x", code: "2@" } })
        .event,
    ).toEqual({ kind: "qr", image: "data:x", code: "2@" });
    expect(
      parseEvolutionWebhook({ ...base, event: "LoggedOut", data: { Reason: "logged_out" } }).event
        .kind,
    ).toBe("logged_out");
    expect(parseEvolutionWebhook({ event: "Message", data: {} }).event).toEqual({
      kind: "ignored",
      event: "Message",
    });
  });
});

describe("WhatsApp simulado", () => {
  it("conecta ao ler o QR, lista grupos, envia e apaga", async () => {
    const p = new FakeMessagingProvider();
    const r = await p.createInstance("x");
    await expect(p.listGroups(r)).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await p.getQr(r);
    const groups = await p.listGroups(r);
    expect(groups).toHaveLength(3);
    const g = groups[0];
    if (!g) throw new Error("sem grupo");
    const sent = await p.sendImage(r, g.jid, "https://img", "Oi");
    expect(fakeMessagingControls.sent[0]).toMatchObject({
      to: g.jid,
      text: "Oi",
      imageUrl: "https://img",
    });
    await p.deleteMessage(r, g.jid, sent.messageId ?? "");
    expect(fakeMessagingControls.sent[0]?.deleted).toBe(true);
  });
});
