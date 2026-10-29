import { clicks, type Db } from "@ofertas/db";
import { sha256 } from "./crypto";

export type NewClick = typeof clicks.$inferInsert;

// Robôs e geradores de prévia (WhatsApp, Telegram, Facebook etc. abrem o link para montar o card).
// Navegadores embutidos de apps (Instagram, Facebook FBAN/FBAV) são pessoas e NÃO entram aqui.
const BOT_UA =
  /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|facebot|whatsapp\/|telegrambot|slack|discord|skypeuri|embedly|pinterest|vkshare|headless|python-requests|python-urllib|curl\/|wget|go-http-client|axios|node-fetch|undici|okhttp|java\/|libwww|httpclient/i;

export function isBotUserAgent(ua: string | undefined | null): boolean {
  if (!ua?.trim()) return true;
  return BOT_UA.test(ua);
}

/** IP anonimizado (LGPD): hash com segredo do servidor, nunca o IP puro. */
export const hashIp = (ip: string, salt: string) => sha256(`${salt}:${ip}`).slice(0, 32);

/**
 * Junta cliques em memória e grava em lote, para o redirecionamento não esperar o banco.
 * Em caso de queda do processo, perde no máximo o último intervalo (padrão 1s).
 */
export class ClickBuffer {
  private buffer: NewClick[] = [];
  private readonly timer: NodeJS.Timeout;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: { flushMs?: number; maxBatch?: number } = {},
  ) {
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 1000);
    this.timer.unref();
  }

  push(click: NewClick) {
    this.buffer.push(click);
    if (this.buffer.length >= (this.opts.maxBatch ?? 500)) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.flushing = this.db
      .insert(clicks)
      .values(batch)
      .then(() => {})
      .catch((err) => {
        console.error(`Falha ao gravar ${batch.length} clique(s):`, err);
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
