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
};

export type SentMessage = { messageId: string | null };

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
  listGroups(ref: InstanceRef): Promise<GroupSummary[]>;
  inviteLink(ref: InstanceRef, groupJid: string): Promise<string>;
  setAdminOnly(ref: InstanceRef, groupJid: string, on: boolean): Promise<void>;
  sendText(ref: InstanceRef, to: string, text: string): Promise<SentMessage>;
  sendImage(ref: InstanceRef, to: string, imageUrl: string, caption: string): Promise<SentMessage>;
  deleteMessage(ref: InstanceRef, chat: string, messageId: string): Promise<void>;
}

export type MessagingErrorCode =
  | "AUTH"
  | "NOT_CONNECTED"
  | "UNAVAILABLE"
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
  | { kind: "participants"; groupJid: string; joined: number; left: number }
  | { kind: "joined_group"; groupJid: string; name: string | null; participantCount: number | null }
  | { kind: "ignored"; event: string };

export type WebhookEnvelope = {
  instanceId: string | null;
  instanceToken: string | null;
  event: MessagingEvent;
};
