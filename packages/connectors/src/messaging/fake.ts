import {
  type GroupDetails,
  type GroupSetting,
  type GroupSummary,
  type InstanceRef,
  MessagingError,
  type MessagingProvider,
  type ParticipantAction,
} from "./types";

// WhatsApp simulado: instâncias, grupos e envios em memória, para testes e para testar o painel
// sem número. Conecta sozinho ao pedir o QR/código (simula o celular lendo o QR).

/** Grupo simulado: o resumo mais os detalhes que a gestão de grupos edita. */
export type FakeGroup = GroupSummary &
  Omit<GroupDetails, keyof GroupSummary> & { photoUrl: string | null; inviteCode: number };

type FakeInstance = { token: string; connected: boolean; groups: Map<string, FakeGroup> };

/** Número simulado (parte do usuário do JID que o status devolve). */
export const FAKE_OWN_USER = "5511999990000";

type SentRecord = {
  instanceId: string;
  to: string;
  text: string;
  imageUrl: string | null;
  messageId: string;
  deleted: boolean;
};

let seq = 0;

export const fakeMessagingControls = {
  instances: new Map<string, FakeInstance>(),
  sent: [] as SentRecord[],
  /** Próxima chamada falha com este código */
  failNext: null as null | MessagingError["code"],
  /** Se false, ler o QR não conecta automaticamente */
  autoConnect: true,
  /** Próximo createGroup cria o grupo mas responde TIMEOUT (como a instância real lenta) */
  createTimesOut: false,
  reset() {
    this.instances.clear();
    this.sent = [];
    this.failNext = null;
    this.autoConnect = true;
    this.invites.clear();
    this.createTimesOut = false;
  },
  connect(instanceId: string) {
    const i = this.instances.get(instanceId);
    if (i) i.connected = true;
  },
  addGroup(instanceId: string, group: GroupSummary & Partial<FakeGroup>) {
    this.instances.get(instanceId)?.groups.set(group.jid, fakeGroup(group));
  },
  /** Convites pendentes para `joinGroup` (código → grupo que aparece ao entrar). */
  invites: new Map<string, GroupSummary>(),
};

function fakeGroup(g: GroupSummary & Partial<FakeGroup>): FakeGroup {
  return {
    description: null,
    locked: false,
    approvalRequired: false,
    adminsAddMembers: false,
    isCommunity: false,
    communityJid: null,
    participants: [FAKE_OWN_USER],
    admins: g.isAdmin === false ? [] : [FAKE_OWN_USER],
    photoUrl: null,
    inviteCode: 1,
    ...g,
  };
}

function seedGroups() {
  const groups = new Map<string, FakeGroup>();
  for (const [i, name] of ["Ofertas Tech #1", "Ofertas Casa #1", "Achadinhos VIP"].entries()) {
    const jid = `12036300000000000${i}@g.us`;
    groups.set(
      jid,
      fakeGroup({ jid, name, participantCount: 100 + i * 250, adminOnly: i !== 2, isAdmin: true }),
    );
  }
  return groups;
}

export class FakeMessagingProvider implements MessagingProvider {
  readonly name = "fake" as const;

  private inst(ref: InstanceRef) {
    const code = fakeMessagingControls.failNext;
    if (code) {
      fakeMessagingControls.failNext = null;
      throw new MessagingError(code, `Falha simulada (${code}).`);
    }
    const i = fakeMessagingControls.instances.get(ref.instanceId);
    if (!i || i.token !== ref.token)
      throw new MessagingError("AUTH", "Instância simulada inválida.");
    return i;
  }

  private connected(ref: InstanceRef) {
    const i = this.inst(ref);
    if (!i.connected) throw new MessagingError("NOT_CONNECTED", "Número simulado não conectado.");
    return i;
  }

  async createInstance(_name: string) {
    const instanceId = `fake-${++seq}-${Date.now()}`;
    const token = crypto.randomUUID();
    fakeMessagingControls.instances.set(instanceId, {
      token,
      connected: false,
      groups: seedGroups(),
    });
    return { instanceId, token };
  }

  async deleteInstance(instanceId: string) {
    fakeMessagingControls.instances.delete(instanceId);
  }

  async connect(ref: InstanceRef) {
    this.inst(ref);
  }

  async getQr(ref: InstanceRef) {
    const i = this.inst(ref);
    if (fakeMessagingControls.autoConnect) i.connected = true;
    // PNG 1x1 transparente: suficiente para o painel exibir algo.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    return { image: `data:image/png;base64,${png}`, code: `fake-qr-${ref.instanceId}` };
  }

  async pairingCode(ref: InstanceRef, _phone: string) {
    const i = this.inst(ref);
    if (fakeMessagingControls.autoConnect) i.connected = true;
    return "ABCD-1234";
  }

  async status(ref: InstanceRef) {
    const i = this.inst(ref);
    return {
      connected: i.connected,
      loggedIn: i.connected,
      name: i.connected ? "Ofertas (simulado)" : null,
      jid: i.connected ? "5511999990000@s.whatsapp.net" : null,
    };
  }

  async logout(ref: InstanceRef) {
    this.inst(ref).connected = false;
  }

  async listGroups(ref: InstanceRef): Promise<GroupSummary[]> {
    return [...this.connected(ref).groups.values()].map((g) => ({
      jid: g.jid,
      name: g.name,
      participantCount: g.participantCount,
      adminOnly: g.adminOnly,
      isAdmin: g.admins.includes(FAKE_OWN_USER),
    }));
  }

  private group(ref: InstanceRef, groupJid: string) {
    const g = this.connected(ref).groups.get(groupJid);
    if (!g) throw new MessagingError("INVALID", "Grupo não encontrado.");
    return g;
  }

  private requireAdmin(g: FakeGroup) {
    if (!g.admins.includes(FAKE_OWN_USER)) {
      throw new MessagingError("INVALID", "O número não é admin do grupo.");
    }
  }

  async inviteLink(ref: InstanceRef, groupJid: string, opts: { reset?: boolean } = {}) {
    const g = this.group(ref, groupJid);
    if (opts.reset) {
      this.requireAdmin(g);
      g.inviteCode++;
    }
    return `https://chat.whatsapp.com/FAKE${groupJid.slice(-6)}${g.inviteCode > 1 ? `R${g.inviteCode}` : ""}`;
  }

  async setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean) {
    await this.setGroupSetting(ref, groupJid, on ? "announcement" : "not_announcement");
  }

  async setGroupSetting(ref: InstanceRef, groupJid: string, setting: GroupSetting) {
    const g = this.group(ref, groupJid);
    this.requireAdmin(g);
    if (setting === "announcement" || setting === "not_announcement")
      g.adminOnly = setting === "announcement";
    if (setting === "locked" || setting === "unlocked") g.locked = setting === "locked";
    if (setting === "approval_on" || setting === "approval_off")
      g.approvalRequired = setting === "approval_on";
    if (setting === "admin_add" || setting === "all_member_add")
      g.adminsAddMembers = setting === "admin_add";
  }

  async getGroupInfo(ref: InstanceRef, groupJid: string): Promise<GroupDetails> {
    const { photoUrl: _p, inviteCode: _i, ...g } = this.group(ref, groupJid);
    return {
      ...g,
      isAdmin: g.admins.includes(FAKE_OWN_USER),
      participants: [...g.participants],
      admins: [...g.admins],
    };
  }

  async createGroup(ref: InstanceRef, name: string, participants: string[]) {
    const i = this.connected(ref);
    if (!participants.length)
      throw new MessagingError("INVALID", "Informe ao menos um participante.");
    if (name.length > 25) throw new MessagingError("INVALID", "Evolution Go: 406 not acceptable");
    const jid = `1203639${String(++seq).padStart(11, "0")}@g.us`;
    i.groups.set(
      jid,
      fakeGroup({
        jid,
        name,
        participantCount: participants.length + 1,
        adminOnly: false,
        isAdmin: true,
        participants: [FAKE_OWN_USER, ...participants],
      }),
    );
    if (fakeMessagingControls.createTimesOut) {
      fakeMessagingControls.createTimesOut = false;
      throw new MessagingError("TIMEOUT", "Evolution Go não respondeu em 90 s.");
    }
    return { jid, failed: [] };
  }

  async setGroupName(ref: InstanceRef, groupJid: string, name: string) {
    const g = this.group(ref, groupJid);
    if (g.locked) this.requireAdmin(g);
    g.name = name;
  }

  async setGroupDescription(ref: InstanceRef, groupJid: string, description: string) {
    const g = this.group(ref, groupJid);
    if (g.locked) this.requireAdmin(g);
    g.description = description || null;
  }

  async setGroupPhoto(ref: InstanceRef, groupJid: string, imageUrl: string) {
    const g = this.group(ref, groupJid);
    if (g.locked) this.requireAdmin(g);
    g.photoUrl = imageUrl;
  }

  async updateParticipants(
    ref: InstanceRef,
    groupJid: string,
    phones: string[],
    action: ParticipantAction,
  ) {
    const g = this.group(ref, groupJid);
    this.requireAdmin(g);
    for (const p of phones) {
      if (action === "add" && !g.participants.includes(p)) {
        g.participants.push(p);
        g.participantCount++;
      }
      if (action === "remove") {
        g.participants = g.participants.filter((x) => x !== p);
        g.admins = g.admins.filter((x) => x !== p);
        g.participantCount = Math.max(0, g.participantCount - 1);
      }
      if (action === "promote" && g.participants.includes(p) && !g.admins.includes(p))
        g.admins.push(p);
      if (action === "demote") g.admins = g.admins.filter((x) => x !== p);
    }
  }

  async joinGroup(ref: InstanceRef, invite: string) {
    const i = this.connected(ref);
    const code = invite.replace(/^https:\/\/chat\.whatsapp\.com\//, "");
    const g = fakeMessagingControls.invites.get(code);
    if (!g) throw new MessagingError("INVALID", "Convite inválido ou expirado.");
    i.groups.set(g.jid, fakeGroup({ ...g, isAdmin: false }));
  }

  async leaveGroup(ref: InstanceRef, groupJid: string) {
    this.group(ref, groupJid);
    this.connected(ref).groups.delete(groupJid);
  }

  async createCommunity(ref: InstanceRef, name: string) {
    const i = this.connected(ref);
    const jid = `1203638${String(++seq).padStart(11, "0")}@g.us`;
    i.groups.set(
      jid,
      fakeGroup({
        jid,
        name,
        participantCount: 1,
        adminOnly: true,
        isAdmin: true,
        isCommunity: true,
      }),
    );
    return { jid };
  }

  async linkCommunityGroups(
    ref: InstanceRef,
    communityJid: string,
    groupJids: string[],
    link: boolean,
  ) {
    const c = this.group(ref, communityJid);
    if (!c.isCommunity) throw new MessagingError("INVALID", "Não é uma comunidade.");
    for (const j of groupJids) {
      const g = this.group(ref, j);
      g.communityJid = link ? communityJid : null;
    }
  }

  private record(ref: InstanceRef, to: string, text: string, imageUrl: string | null) {
    const i = this.connected(ref);
    if (!i.groups.has(to) && !to.endsWith("@s.whatsapp.net")) {
      throw new MessagingError("INVALID", `Destino desconhecido: ${to}`);
    }
    const messageId = `FAKEMSG${++seq}`;
    fakeMessagingControls.sent.push({
      instanceId: ref.instanceId,
      to,
      text,
      imageUrl,
      messageId,
      deleted: false,
    });
    return { messageId };
  }

  async sendText(ref: InstanceRef, to: string, text: string) {
    return this.record(ref, to, text, null);
  }

  async sendImage(ref: InstanceRef, to: string, imageUrl: string, caption: string) {
    return this.record(ref, to, caption, imageUrl);
  }

  async deleteMessage(ref: InstanceRef, _chat: string, messageId: string) {
    this.connected(ref);
    const m = fakeMessagingControls.sent.find((s) => s.messageId === messageId);
    if (!m) throw new MessagingError("INVALID", "Mensagem não encontrada.");
    m.deleted = true;
  }
}
