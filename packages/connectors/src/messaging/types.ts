export const MESSAGING_PROVIDERS = ["evolution_go", "fake"] as const;
export type MessagingProviderName = (typeof MESSAGING_PROVIDERS)[number];

/** Credenciais de uma instância (número) no provedor. */
export type InstanceRef = { instanceId: string; token: string };

export type InstanceStatus = {
  connected: boolean;
  loggedIn: boolean;
  name: string | null;
  jid: string | null;
};

export type GroupSummary = {
  jid: string;
  name: string;
  participantCount: number;
  /** Só administradores enviam */
  adminOnly: boolean | null;
  /** O número conectado é admin do grupo (null quando não dá para saber) */
  isAdmin: boolean | null;
};

/** Configurações do grupo (ação da Evolution Go em `/group/settings`). */
export type GroupSetting =
  | "announcement"
  | "not_announcement"
  | "locked"
  | "unlocked"
  | "approval_on"
  | "approval_off"
  | "admin_add"
  | "all_member_add";

export type ParticipantAction = "add" | "remove" | "promote" | "demote";

/** Detalhes de um grupo (lidos na hora do provedor). */
export type GroupDetails = GroupSummary & {
  description: string | null;
  /** Só admins editam nome, descrição e foto */
  locked: boolean | null;
  /** Entrada precisa de aprovação de um admin */
  approvalRequired: boolean | null;
  /** Só admins adicionam membros */
  adminsAddMembers: boolean | null;
  isCommunity: boolean;
  /** Comunidade a que o grupo está ligado */
  communityJid: string | null;
  /** Parte do usuário (telefone ou LID) de cada participante */
  participants: string[];
  /** Parte do usuário dos admins */
  admins: string[];
};

export type SentMessage = { messageId: string | null };

/**
 * Mesmo telefone? Ignora o 9º dígito de celulares brasileiros: o JID real de muitos números
 * antigos não tem o 9 (5511988887777 e 551188887777 são o mesmo WhatsApp).
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.startsWith("55") &&
    b.startsWith("55") &&
    a.slice(0, 4) === b.slice(0, 4) &&
    a.slice(-8) === b.slice(-8)
  );
}

export interface MessagingProvider {
  readonly name: MessagingProviderName;
  createInstance(name: string): Promise<InstanceRef>;
  deleteInstance(instanceId: string): Promise<void>;
  /** Inicia a conexão e registra o webhook com os eventos desejados. */
  connect(ref: InstanceRef, opts: { webhookUrl: string | null }): Promise<void>;
  /** QR code atual como data URL (image/png) e o texto bruto, quando disponível. */
  getQr(ref: InstanceRef): Promise<{ image: string | null; code: string | null }>;
  /** Código de pareamento para digitar no celular (alternativa ao QR). */
  pairingCode(ref: InstanceRef, phone: string): Promise<string>;
  status(ref: InstanceRef): Promise<InstanceStatus>;
  logout(ref: InstanceRef): Promise<void>;
  /** Grupos em que o número está. `ownJid` permite descobrir se ele é admin de cada um. */
  listGroups(ref: InstanceRef, opts?: { ownJid?: string | null }): Promise<GroupSummary[]>;
  /** Link de convite; `reset` revoga o atual e gera outro. */
  inviteLink(ref: InstanceRef, groupJid: string, opts?: { reset?: boolean }): Promise<string>;
  setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean): Promise<void>;
  getGroupInfo(
    ref: InstanceRef,
    groupJid: string,
    opts?: { ownJid?: string | null },
  ): Promise<GroupDetails>;
  /** Cria o grupo com os participantes (telefones só com dígitos). */
  createGroup(
    ref: InstanceRef,
    name: string,
    participants: string[],
  ): Promise<{ jid: string; failed: string[] }>;
  setGroupName(ref: InstanceRef, groupJid: string, name: string): Promise<void>;
  setGroupDescription(ref: InstanceRef, groupJid: string, description: string): Promise<void>;
  /** Foto por URL pública (http/https). */
  setGroupPhoto(ref: InstanceRef, groupJid: string, imageUrl: string): Promise<void>;
  setGroupSetting(ref: InstanceRef, groupJid: string, setting: GroupSetting): Promise<void>;
  updateParticipants(
    ref: InstanceRef,
    groupJid: string,
    phones: string[],
    action: ParticipantAction,
  ): Promise<void>;
  /** Entra pelo link ou código de convite. */
  joinGroup(ref: InstanceRef, invite: string): Promise<void>;
  leaveGroup(ref: InstanceRef, groupJid: string): Promise<void>;
  createCommunity(ref: InstanceRef, name: string): Promise<{ jid: string }>;
  /** Liga (link=true) ou desliga grupos de uma comunidade. */
  linkCommunityGroups(
    ref: InstanceRef,
    communityJid: string,
    groupJids: string[],
    link: boolean,
  ): Promise<void>;
  sendText(ref: InstanceRef, to: string, text: string): Promise<SentMessage>;
  sendImage(ref: InstanceRef, to: string, imageUrl: string, caption: string): Promise<SentMessage>;
  deleteMessage(ref: InstanceRef, chat: string, messageId: string): Promise<void>;
}

export type MessagingErrorCode =
  | "AUTH"
  | "NOT_CONNECTED"
  | "UNAVAILABLE"
  /** Pedido saiu mas a resposta não chegou: a ação pode ter acontecido no provedor. */
  | "TIMEOUT"
  | "INVALID"
  | "NOT_CONFIGURED";

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  constructor(code: MessagingErrorCode, message: string) {
    super(message);
    this.name = "MessagingError";
    this.code = code;
  }
}

export const isMessagingError = (e: unknown): e is MessagingError => e instanceof MessagingError;

/** Eventos de webhook normalizados (independentes do provedor). */
export type MessagingEvent =
  | { kind: "connected"; jid: string | null; name: string | null }
  | { kind: "logged_out" }
  | { kind: "qr"; image: string | null; code: string | null }
  | {
      kind: "group_update";
      groupJid: string;
      joined: number;
      left: number;
      /** Parte do usuário de quem virou / deixou de ser admin */
      promoted: string[];
      demoted: string[];
      name?: string;
      description?: string;
      adminOnly?: boolean;
      locked?: boolean;
      approvalRequired?: boolean;
      inviteLink?: string;
      deleted?: boolean;
      /** true = suspenso pelo WhatsApp; false = suspensão retirada */
      suspended?: boolean;
    }
  | { kind: "joined_group"; groupJid: string; name: string | null; participantCount: number | null }
  | { kind: "ignored"; event: string };

export type WebhookEnvelope = {
  instanceId: string | null;
  instanceToken: string | null;
  event: MessagingEvent;
};
