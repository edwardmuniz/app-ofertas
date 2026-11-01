import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors";

export type FetchedMedia = { data: Buffer; contentType: string | null };
export type MediaFetcher = (url: string) => Promise<FetchedMedia>;
/** Página HTML já com os redirecionamentos seguidos (url = endereço final). */
export type FetchedPage = { url: string; status: number; html: string };
export type PageFetcher = (url: string) => Promise<FetchedPage>;
/** Abre um arquivo grande em fluxo (o feed de produtos tem centenas de MB). */
export type OpenedStream = { body: AsyncIterable<Uint8Array>; size: number | null };
export type StreamOpener = (url: string) => Promise<OpenedStream>;

function isPrivateIp(ip: string) {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("::ffff:")
  );
}

async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR", "URL inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR", "Só URLs http(s) são aceitas.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0)
    throw new AppError("VALIDATION_ERROR", `Não foi possível resolver ${host}.`);
  if (addresses.some(isPrivateIp)) {
    throw new AppError("VALIDATION_ERROR", "Endereços internos da rede não são permitidos.", {
      hint: "Use uma URL pública da imagem.",
    });
  }
  return url;
}

/**
 * Baixa mídia de uma URL pública: bloqueia endereços internos (inclusive em redirecionamentos),
 * limita tamanho e tempo.
 */
export function createSafeFetcher(
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): MediaFetcher {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  return async (raw) => {
    let current = raw;
    for (let hop = 0; hop < 4; hop++) {
      const url = await assertPublicUrl(current);
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new AppError("PROVIDER_ERROR", `Não foi possível baixar a imagem: ${String(err)}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location") ?? "", url).toString();
        continue;
      }
      if (!res.ok) throw new AppError("PROVIDER_ERROR", `A URL respondeu ${res.status}.`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes)
        throw new AppError("VALIDATION_ERROR", "Arquivo grande demais (máx. 10 MB).");
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes)
        throw new AppError("VALIDATION_ERROR", "Arquivo grande demais (máx. 10 MB).");
      return { data, contentType: res.headers.get("content-type") };
    }
    throw new AppError("VALIDATION_ERROR", "Redirecionamentos demais.");
  };
}

/**
 * As lojas bloqueiam robôs, mas liberam os de prévia de link: a página é pedida como o WhatsApp
 * pede para montar a prévia (Open Graph).
 */
const PREVIEW_UA = "WhatsApp/2.23.20.0 A";

/**
 * Baixa a página de um produto para ler título, foto e preço. Segue redirecionamentos (links
 * curtos de afiliado), inclusive meta refresh, sempre bloqueando endereços internos.
 */
export function createSafePageFetcher(
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): PageFetcher {
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  return async (raw) => {
    let current = raw;
    for (let hop = 0; hop < 8; hop++) {
      const url = await assertPublicUrl(current);
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "manual",
          headers: { "user-agent": PREVIEW_UA, accept: "text/html", "accept-language": "pt-BR" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
        });
      } catch (err) {
        throw new AppError("PROVIDER_ERROR", `Não foi possível abrir o link: ${String(err)}`);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, url).toString();
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const html = buf.subarray(0, maxBytes).toString("utf8");
      const refresh = html.match(
        /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+\s*;\s*url=([^"'>\s]+)/i,
      )?.[1];
      if (refresh && res.ok) {
        current = new URL(refresh.replace(/&amp;/g, "&"), url).toString();
        continue;
      }
      return { url: url.toString(), status: res.status, html };
    }
    throw new AppError("VALIDATION_ERROR", "Redirecionamentos demais.");
  };
}

/**
 * Baixa arquivos grandes em fluxo (feed de produtos), seguindo redirecionamentos e bloqueando
 * endereços internos. O tempo limite vale para a conexão; a leitura pode levar minutos.
 */
export function createSafeStreamOpener(opts: { connectTimeoutMs?: number } = {}): StreamOpener {
  return async (raw) => {
    let current = raw;
    for (let hop = 0; hop < 6; hop++) {
      const url = await assertPublicUrl(current);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.connectTimeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, url).toString();
        continue;
      }
      if (!res.ok || !res.body) {
        throw new AppError("PROVIDER_ERROR", `O link respondeu ${res.status}.`);
      }
      const size = Number(res.headers.get("content-length"));
      return {
        body: res.body as unknown as AsyncIterable<Uint8Array>,
        size: Number.isFinite(size) && size > 0 ? size : null,
      };
    }
    throw new AppError("VALIDATION_ERROR", "Redirecionamentos demais.");
  };
}

/** Envia o alerta (POST JSON) para o webhook configurado, com a mesma proteção de endereços. */
export function createSafeNotifier(opts: { timeoutMs?: number } = {}) {
  return async (raw: string, payload: unknown) => {
    const url = await assertPublicUrl(raw);
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`webhook de alerta respondeu ${res.status}`);
  };
}
