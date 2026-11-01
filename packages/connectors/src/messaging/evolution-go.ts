import {
  type GroupDetails,
  type GroupSetting,
  type GroupSummary,
  type InstanceRef,
  type InstanceStatus,
  MessagingError,
  type MessagingEvent,
  type MessagingProvider,
  type ParticipantAction,
  samePhone,
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

/** JID vem como texto ("123@g.us") ou, em versões antigas, como objeto { User, Server }. */
function jidString(v: unknown): string {
  if (typeof v === "string") return v;
  const user = pick<string>(v, "User", "user");
  const server = pick<string>(v, "Server", "server");
  return user && server ? `${user}@${server}` : "";
}

/** Parte do usuário do JID, sem servidor nem aparelho ("5511...:5@s.whatsapp.net" → "5511..."). */
const jidUser = (v: unknown) => (jidString(v).split("@")[0] ?? "").split(":")[0] ?? "";

/** O número é admin entre os participantes? null se ele não aparece na lista (ex.: só LID). */
function adminIn(participants: unknown[], me: string): boolean | null {
  const p = participants.find((x) =>
    [pick(x, "JID", "jid"), pick(x, "PhoneNumber", "phoneNumber")].some(
      (j) => j !== undefined && samePhone(jidUser(j), me),
    ),
  );
  if (!p) return null;
  return Boolean(pick(p, "IsAdmin", "isAdmin") || pick(p, "IsSuperAdmin", "isSuperAdmin"));
}

/** Prazo das operações de grupo: o WhatsApp responde mais devagar que no envio de texto. */
const GROUP_TIMEOUT = 45_000;

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
    timeoutMs = 20_000,
    /** Corpo JSON enviado como text/plain (contorna a validação de /group/participant) */
    asText = false,
  ): Promise<T> {
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          apikey,
          ...(body !== undefined
            ? { "content-type": asText ? "text/plain" : "application/json" }
            : {}),
        },
        body:
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new MessagingError(
          "TIMEOUT",
          `Evolution Go não respondeu em ${Math.round(timeoutMs / 1000)} s.`,
        );
      }
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

  async listGroups(
    ref: InstanceRef,
    opts: { ownJid?: string | null } = {},
  ): Promise<GroupSummary[]> {
    // `/group/list` devolve todos os grupos em que o número está (uma consulta ao WhatsApp).
    // `/group/myall` só filtra os criados pelo número e está marcado como "not working" no código
    // da Evolution Go. Com muitos grupos a resposta é grande: prazo maior.
    const res = await this.call("GET", "/group/list", ref.token, undefined, 60_000);
    const list = pick<unknown[]>(res, "data", "groups") ?? [];
    const me = opts.ownJid ? jidUser(opts.ownJid) : null;
    return (Array.isArray(list) ? list : [])
      .map((g) => {
        const participants = pick<unknown[]>(g, "Participants", "participants");
        return {
          jid: jidString(pick(g, "JID", "jid", "id")),
          name: String(pick(g, "Name", "name", "subject") ?? "Grupo sem nome"),
          participantCount:
            Number(pick(g, "ParticipantCount", "participantCount", "size")) ||
            (Array.isArray(participants) ? participants.length : 0),
          adminOnly: (pick<boolean>(g, "IsAnnounce", "isAnnounce", "announce") ?? null) as
            | boolean
            | null,
          isAdmin: me && Array.isArray(participants) ? adminIn(participants, me) : null,
        };
      })
      .filter((g) => g.jid.endsWith("@g.us"));
  }

  async inviteLink(ref: InstanceRef, groupJid: string, opts: { reset?: boolean } = {}) {
    const res = await this.call(
      "POST",
      "/group/invitelink",
      ref.token,
      { groupJid, reset: opts.reset ?? false },
      GROUP_TIMEOUT,
    );
    const link = pick<string>(res, "data.inviteLink", "inviteLink", "data.link", "data");
    if (typeof link !== "string")
      throw new MessagingError("INVALID", "Link de convite não retornado.");
    return link.startsWith("http") ? link : `https://chat.whatsapp.com/${link}`;
  }

  async setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean) {
    await this.setGroupSetting(ref, groupJid, on ? "announcement" : "not_announcement");
  }

  async setGroupSetting(ref: InstanceRef, groupJid: string, setting: GroupSetting) {
    await this.call(
      "POST",
      "/group/settings",
      ref.token,
      { groupJid, action: setting },
      GROUP_TIMEOUT,
    );
  }

  async getGroupInfo(
    ref: InstanceRef,
    groupJid: string,
    opts: { ownJid?: string | null } = {},
  ): Promise<GroupDetails> {
    const res = await this.call("POST", "/group/info", ref.token, { groupJid }, GROUP_TIMEOUT);
    const g = pick<Record<string, unknown>>(res, "data") ?? {};
    const participants = pick<unknown[]>(g, "Participants", "participants") ?? [];
    const list = Array.isArray(participants) ? participants : [];
    const me = opts.ownJid ? jidUser(opts.ownJid) : null;
    const userOfParticipant = (x: unknown) =>
      jidUser(pick(x, "PhoneNumber", "phoneNumber") ?? pick(x, "JID", "jid"));
    const addMode = pick<string>(g, "MemberAddMode", "memberAddMode");
    return {
      jid: jidString(pick(g, "JID", "jid")) || groupJid,
      name: String(pick(g, "Name", "name", "subject") ?? "Grupo sem nome"),
      participantCount:
        Number(pick(g, "ParticipantCount", "participantCount", "size")) || list.length,
      adminOnly: pick<boolean>(g, "IsAnnounce", "isAnnounce", "announce") ?? null,
      isAdmin: me ? adminIn(list, me) : null,
      description: pick<string>(g, "Topic", "topic", "desc") ?? null,
      locked: pick<boolean>(g, "IsLocked", "isLocked") ?? null,
      approvalRequired:
        pick<boolean>(g, "IsJoinApprovalRequired", "isJoinApprovalRequired") ?? null,
      adminsAddMembers: addMode ? addMode === "admin_add" : null,
      isCommunity: Boolean(pick(g, "IsParent", "isParent")),
      communityJid: jidString(pick(g, "LinkedParentJID", "linkedParentJid")) || null,
      participants: list.map(userOfParticipant).filter(Boolean),
      admins: list
        .filter((x) => pick(x, "IsAdmin", "isAdmin") || pick(x, "IsSuperAdmin", "isSuperAdmin"))
        .map(userOfParticipant)
        .filter(Boolean),
    };
  }

  /**
   * Telefones → JID real no WhatsApp (`/user/check`). Resolve o 9º dígito dos números
   * brasileiros: mandar o telefone cru faz criar grupo/adicionar travar ou falhar.
   */
  private async resolveJids(ref: InstanceRef, phones: string[]) {
    const res = await this.call(
      "POST",
      "/user/check",
      ref.token,
      { number: phones.map((p) => `+${p.replace(/\D/g, "")}`), formatJid: false },
      GROUP_TIMEOUT,
    );
    const users = pick<unknown[]>(res, "data.Users", "data.users", "Users") ?? [];
    const found = new Map<string, string>();
    for (const u of Array.isArray(users) ? users : []) {
      const query = String(pick(u, "Query", "query") ?? "").replace(/\D/g, "");
      const jid = jidString(pick(u, "JID", "jid"));
      if (query && jid && pick(u, "IsInWhatsapp", "isInWhatsapp") !== false) found.set(query, jid);
    }
    const missing = phones.filter((p) => !found.has(p));
    if (missing.length) {
      throw new MessagingError("INVALID", `Estes números não têm WhatsApp: ${missing.join(", ")}.`);
    }
    return phones.map((p) => found.get(p) as string);
  }

  async createGroup(ref: InstanceRef, name: string, participants: string[]) {
    const jids = await this.resolveJids(ref, participants);
    // Criar grupo é a operação mais lenta do WhatsApp.
    const res = await this.call(
      "POST",
      "/group/create",
      ref.token,
      { groupName: name, participants: jids },
      90_000,
    );
    const jid = jidString(pick(res, "data.jid", "data.JID", "data.id"));
    if (!jid)
      throw new MessagingError("INVALID", "Evolution Go não devolveu o id do grupo criado.");
    const failed = pick<unknown[]>(res, "data.failed") ?? [];
    return {
      jid,
      failed: (Array.isArray(failed) ? failed : []).map((f) => jidUser(pick(f, "JID", "jid") ?? f)),
    };
  }

  async setGroupName(ref: InstanceRef, groupJid: string, name: string) {
    await this.call("POST", "/group/name", ref.token, { groupJid, name }, GROUP_TIMEOUT);
  }

  async setGroupDescription(ref: InstanceRef, groupJid: string, description: string) {
    await this.call(
      "POST",
      "/group/description",
      ref.token,
      { groupJid, description },
      GROUP_TIMEOUT,
    );
  }

  async setGroupPhoto(ref: InstanceRef, groupJid: string, imageUrl: string) {
    // A Evolution Go baixa a imagem antes de responder.
    await this.call("POST", "/group/photo", ref.token, { groupJid, image: imageUrl }, 60_000);
  }

  async updateParticipants(
    ref: InstanceRef,
    groupJid: string,
    phones: string[],
    action: ParticipantAction,
  ) {
    const jids = await this.resolveJids(ref, phones);
    // A validação da rota recusa a lista quando o corpo vem como application/json, mas o
    // handler lê JSON de qualquer jeito: mandamos o mesmo JSON como text/plain.
    await this.call(
      "POST",
      "/group/participant",
      ref.token,
      JSON.stringify({ groupJid, participants: jids, action }),
      GROUP_TIMEOUT,
      true,
    );
  }

  async joinGroup(ref: InstanceRef, invite: string) {
    await this.call("POST", "/group/join", ref.token, { code: invite.trim() }, GROUP_TIMEOUT);
  }

  async leaveGroup(ref: InstanceRef, groupJid: string) {
    await this.call("POST", "/group/leave", ref.token, { groupJid }, GROUP_TIMEOUT);
  }

  async createCommunity(ref: InstanceRef, name: string) {
    const res = await this.call(
      "POST",
      "/community/create",
      ref.token,
      { communityName: name },
      90_000,
    );
    const jid = jidString(pick(res, "data.JID", "data.jid", "JID", "jid"));
    if (!jid) throw new MessagingError("INVALID", "Evolution Go não devolveu o id da comunidade.");
    return { jid };
  }

  async linkCommunityGroups(
    ref: InstanceRef,
    communityJid: string,
    groupJids: string[],
    link: boolean,
  ) {
    // A resposta de sucesso/falha da Evolution Go não é confiável (bug no código dela):
    // quem chama confere relendo os grupos. `communityId` vai junto por causa da validação dela.
    await this.call(
      "POST",
      link ? "/community/add" : "/community/remove",
      ref.token,
      { communityJid, communityId: communityJid, groupJid: groupJids },
      90_000,
    );
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
      // A Evolution Go baixa a imagem e sobe para o WhatsApp antes de responder.
      await this.call(
        "POST",
        "/send/media",
        ref.token,
        { number: to, type: "image", url: imageUrl, caption },
        60_000,
      ),
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
    case "GroupInfo": {
      const users = (v: unknown) => (Array.isArray(v) ? v.map(jidUser).filter(Boolean) : []);
      const has = (...keys: string[]) => keys.some((k) => pick(data, k) !== undefined);
      const update: Extract<MessagingEvent, { kind: "group_update" }> = {
        kind: "group_update",
        groupJid: jidString(pick(data, "JID", "jid")),
        joined: count(pick(data, "Join", "join")),
        left: count(pick(data, "Leave", "leave")),
        promoted: users(pick(data, "Promote", "promote")),
        demoted: users(pick(data, "Demote", "demote")),
      };
      const name = pick<string>(data, "Name.Name", "name.name");
      if (name) update.name = name;
      if (has("Topic", "topic")) {
        update.description = pick<string>(data, "Topic.Topic", "topic.topic") ?? "";
      }
      const announce = pick<boolean>(data, "Announce.IsAnnounce", "announce.isAnnounce");
      if (announce !== undefined) update.adminOnly = announce;
      const locked = pick<boolean>(data, "Locked.IsLocked", "locked.isLocked");
      if (locked !== undefined) update.locked = locked;
      const approval = pick<boolean>(
        data,
        "MembershipApprovalMode.IsJoinApprovalRequired",
        "membershipApprovalMode.isJoinApprovalRequired",
      );
      if (approval !== undefined) update.approvalRequired = approval;
      const link = pick<string>(data, "NewInviteLink", "newInviteLink");
      if (link)
        update.inviteLink = link.startsWith("http") ? link : `https://chat.whatsapp.com/${link}`;
      if (has("Delete", "delete")) update.deleted = true;
      if (pick<boolean>(data, "Suspended", "suspended")) update.suspended = true;
      if (pick<boolean>(data, "Unsuspended", "unsuspended")) update.suspended = false;
      e = update;
      break;
    }
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
