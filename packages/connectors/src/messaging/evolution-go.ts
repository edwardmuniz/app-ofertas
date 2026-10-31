import {
  type GroupSummary,
  type InstanceRef,
  type InstanceStatus,
  MessagingError,
  type MessagingEvent,
  type MessagingProvider,
  type WebhookEnvelope,
} from "./types";

// Evolution Go (whatsmeow). Autenticação no header `apikey`:
// chave global para criar/apagar instâncias; token da instância para todo o resto.
// A documentação e os exemplos divergem no formato de algumas respostas, então os leitores
// abaixo aceitam as duas formas. [VERIFICAR com a instância real]

/** Lê o primeiro caminho existente (ex.: "data.Info.ID"). */
export function pick<T = unknown>(obj: unknown, ...paths: string[]): T | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur === null || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur as T;
  }
  return undefined;
}

export const WEBHOOK_EVENTS = ["GROUP", "CONNECTION", "QRCODE"];

type Fetch = typeof fetch;

export class EvolutionGoProvider implements MessagingProvider {
  readonly name = "evolution_go" as const;

  constructor(private readonly cfg: { baseUrl: string; globalKey: string; fetch?: Fetch }) {}

  private async call<T = unknown>(
    method: string,
    path: string,
    apikey: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { apikey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MessagingError("UNAVAILABLE", `Evolution Go indisponível: ${String(err)}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401 || res.status === 403) {
      throw new MessagingError("AUTH", "Evolution Go recusou a chave (apikey).");
    }
    if (res.status === 503) {
      throw new MessagingError("UNAVAILABLE", "Evolution Go indisponível (licença não ativada?).");
    }
    if (!res.ok) {
      const msg = pick<string>(data, "error", "message", "data.error") ?? `HTTP ${res.status}`;
      const notConnected = /not connected|not logged|no session|desconect/i.test(msg);
      throw new MessagingError(notConnected ? "NOT_CONNECTED" : "INVALID", `Evolution Go: ${msg}`);
    }
    return data as T;
  }

  async createInstance(name: string): Promise<InstanceRef> {
    const token = crypto.randomUUID();
    const res = await this.call("POST", "/instance/create", this.cfg.globalKey, { name, token });
    const instanceId = pick<string>(
      res,
      "data.id",
      "data.instanceId",
      "data.ID",
      "instanceId",
      "id",
    );
    const returnedToken = pick<string>(res, "data.token", "token") ?? token;
    if (!instanceId)
      throw new MessagingError("INVALID", "Evolution Go não devolveu o id da instância.");
    return { instanceId, token: returnedToken };
  }

  async deleteInstance(instanceId: string) {
    await this.call(
      "DELETE",
      `/instance/delete/${encodeURIComponent(instanceId)}`,
      this.cfg.globalKey,
    );
  }

  async connect(ref: InstanceRef, opts: { webhookUrl: string | null }) {
    await this.call("POST", "/instance/connect", ref.token, {
      ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl, subscribe: WEBHOOK_EVENTS } : {}),
      immediate: true,
    });
  }

  async getQr(ref: InstanceRef) {
    const res = await this.call("GET", "/instance/qr", ref.token);
    const image = pick<string>(
      res,
      "data.Qrcode",
      "data.qrcode",
      "data.QRCode",
      "qrCode",
      "qrcode",
    );
    const code = pick<string>(res, "data.Code", "data.code", "code");
    return {
      image:
        image && !image.startsWith("data:") ? `data:image/png;base64,${image}` : (image ?? null),
      code: code ?? null,
    };
  }

  async pairingCode(ref: InstanceRef, phone: string) {
    const res = await this.call("POST", "/instance/pair", ref.token, {
      phone: phone.replace(/\D/g, ""),
      subscribe: WEBHOOK_EVENTS,
    });
    const code = pick<string>(res, "data.PairingCode", "data.pairingCode", "pairingCode");
    if (!code)
      throw new MessagingError("INVALID", "Evolution Go não devolveu o código de pareamento.");
    return code;
  }

  async status(ref: InstanceRef): Promise<InstanceStatus> {
    const res = await this.call("GET", "/instance/status", ref.token);
    const raw = pick<string>(res, "status");
    const connected = Boolean(
      pick<boolean>(res, "data.Connected", "data.connected") ?? raw === "open",
    );
    const loggedIn = Boolean(
      pick<boolean>(res, "data.LoggedIn", "data.loggedIn") ?? raw === "open",
    );
    return {
      connected,
      loggedIn,
      name: pick<string>(res, "data.Name", "data.name", "data.pushName") ?? null,
      jid: pick<string>(res, "data.Jid", "data.JID", "data.jid") ?? null,
    };
  }

  async logout(ref: InstanceRef) {
    await this.call("DELETE", "/instance/logout", ref.token);
  }

  async listGroups(ref: InstanceRef): Promise<GroupSummary[]> {
    const res = await this.call("GET", "/group/myall", ref.token).catch((err) => {
      if (err instanceof MessagingError && err.code === "INVALID") {
        return this.call("GET", "/group/list", ref.token);
      }
      throw err;
    });
    const list = pick<unknown[]>(res, "data", "groups") ?? [];
    return (Array.isArray(list) ? list : [])
      .map((g) => {
        const participants = pick<unknown[]>(g, "Participants", "participants");
        return {
          jid: String(pick(g, "JID", "jid", "id") ?? ""),
          name: String(pick(g, "Name", "name", "subject") ?? "Grupo sem nome"),
          participantCount:
            Number(pick(g, "ParticipantCount", "participantCount", "size")) ||
            (Array.isArray(participants) ? participants.length : 0),
          adminOnly: (pick<boolean>(g, "IsAnnounce", "isAnnounce", "announce") ?? null) as
            | boolean
            | null,
        };
      })
      .filter((g) => g.jid.endsWith("@g.us"));
  }

  async inviteLink(ref: InstanceRef, groupJid: string) {
    const res = await this.call("POST", "/group/invitelink", ref.token, { groupJid, reset: false });
    const link = pick<string>(res, "data.inviteLink", "inviteLink", "data.link", "data");
    if (typeof link !== "string")
      throw new MessagingError("INVALID", "Link de convite não retornado.");
    return link.startsWith("http") ? link : `https://chat.whatsapp.com/${link}`;
  }

  async setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean) {
    await this.call("POST", "/group/settings", ref.token, {
      groupJid,
      action: on ? "announcement" : "not_announcement",
    });
  }

  private messageId(res: unknown) {
    return {
      messageId:
        pick<string>(res, "data.Info.ID", "messageId", "data.key.id", "data.ID", "data.id") ?? null,
    };
  }

  async sendText(ref: InstanceRef, to: string, text: string) {
    return this.messageId(await this.call("POST", "/send/text", ref.token, { number: to, text }));
  }

  async sendImage(ref: InstanceRef, to: string, imageUrl: string, caption: string) {
    return this.messageId(
      await this.call("POST", "/send/media", ref.token, {
        number: to,
        type: "image",
        url: imageUrl,
        caption,
      }),
    );
  }

  async deleteMessage(ref: InstanceRef, chat: string, messageId: string) {
    await this.call("POST", "/message/delete", ref.token, { chat, messageId });
  }
}

/** Converte o corpo de um webhook da Evolution Go em evento normalizado. */
export function parseEvolutionWebhook(body: unknown): WebhookEnvelope {
  const event = String(pick(body, "event", "type") ?? "");
  const data = pick<Record<string, unknown>>(body, "data") ?? {};
  const env = {
    instanceId: pick<string>(body, "instanceId", "instance_id") ?? null,
    instanceToken: pick<string>(body, "instanceToken", "instance_token") ?? null,
  };
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  let e: MessagingEvent;
  switch (event) {
    case "Connected":
    case "PairSuccess":
      e = {
        kind: "connected",
        jid: pick<string>(data, "jid", "JID", "ID") ?? null,
        name: pick<string>(data, "pushName", "PushName") ?? null,
      };
      break;
    case "LoggedOut":
      e = { kind: "logged_out" };
      break;
    case "QRCode":
      e = {
        kind: "qr",
        image: pick<string>(data, "qrcode", "Qrcode") ?? null,
        code: pick<string>(data, "code", "Code") ?? null,
      };
      break;
    case "GroupInfo":
      e = {
        kind: "participants",
        groupJid: String(pick(data, "JID", "jid") ?? ""),
        joined: count(pick(data, "Join", "join")),
        left: count(pick(data, "Leave", "leave")),
      };
      break;
    case "JoinedGroup": {
      const participants = pick(data, "Participants", "participants");
      e = {
        kind: "joined_group",
        groupJid: String(pick(data, "JID", "jid") ?? ""),
        name: pick<string>(data, "GroupName.Name", "Name", "name") ?? null,
        participantCount: Array.isArray(participants) ? participants.length : null,
      };
      break;
    }
    default:
      e = { kind: "ignored", event };
  }
  return { ...env, event: e };
}
