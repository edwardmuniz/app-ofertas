import {
  type GroupSummary,
  type InstanceRef,
  MessagingError,
  type MessagingProvider,
} from "./types";

// WhatsApp simulado: instâncias, grupos e envios em memória, para testes e para testar o painel
// sem número. Conecta sozinho ao pedir o QR/código (simula o celular lendo o QR).

type FakeInstance = { token: string; connected: boolean; groups: Map<string, GroupSummary> };

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
  reset() {
    this.instances.clear();
    this.sent = [];
    this.failNext = null;
    this.autoConnect = true;
  },
  connect(instanceId: string) {
    const i = this.instances.get(instanceId);
    if (i) i.connected = true;
  },
  addGroup(instanceId: string, group: GroupSummary) {
    this.instances.get(instanceId)?.groups.set(group.jid, group);
  },
};

function seedGroups() {
  const groups = new Map<string, GroupSummary>();
  for (const [i, name] of ["Ofertas Tech #1", "Ofertas Casa #1", "Achadinhos VIP"].entries()) {
    const jid = `12036300000000000${i}@g.us`;
    groups.set(jid, { jid, name, participantCount: 100 + i * 250, adminOnly: i !== 2 });
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

  async listGroups(ref: InstanceRef) {
    return [...this.connected(ref).groups.values()];
  }

  async inviteLink(ref: InstanceRef, groupJid: string) {
    if (!this.connected(ref).groups.has(groupJid))
      throw new MessagingError("INVALID", "Grupo não encontrado.");
    return `https://chat.whatsapp.com/FAKE${groupJid.slice(-6)}`;
  }

  async setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean) {
    const g = this.connected(ref).groups.get(groupJid);
    if (!g) throw new MessagingError("INVALID", "Grupo não encontrado.");
    g.adminOnly = on;
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
