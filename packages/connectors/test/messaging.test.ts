import { afterEach, describe, expect, it } from "vitest";
import {
  EvolutionGoProvider,
  FakeMessagingProvider,
  fakeMessagingControls,
  parseEvolutionWebhook,
} from "../src";

afterEach(() => fakeMessagingControls.reset());

function evo(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; apikey: string; body: unknown }[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? "GET",
      path,
      apikey: headers.get("apikey") ?? "",
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
      "GET /group/myall": {
        data: [
          { JID: "1@g.us", Name: "Tech", ParticipantCount: 300, IsAnnounce: true },
          { JID: "5511@s.whatsapp.net", Name: "não é grupo" },
        ],
      },
    });
    expect(await a.p.getQr(ref)).toEqual({ image: "data:image/png;base64,AAA", code: "2@xyz" });
    expect(await a.p.status(ref)).toMatchObject({ connected: true, loggedIn: true, name: "Loja" });
    expect(await a.p.listGroups(ref)).toEqual([
      { jid: "1@g.us", name: "Tech", participantCount: 300, adminOnly: true },
    ]);

    const b = evo({
      "GET /instance/qr": { success: true, qrCode: "BBB" },
      "GET /group/myall": { groups: [{ JID: "2@g.us", Name: "Casa", Participants: [{}, {}] }] },
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

  it("converte erros", async () => {
    const { p } = evo({ "GET /instance/status": new Response("", { status: 401 }) });
    await expect(p.status(ref)).rejects.toMatchObject({ code: "AUTH" });
    const q = evo({
      "POST /send/text": Response.json({ error: "client not connected" }, { status: 400 }),
    });
    await expect(q.p.sendText(ref, "1@g.us", "x")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
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
    ).toEqual({ kind: "participants", groupJid: "1@g.us", joined: 2, left: 1 });
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
