// CLI `ofertas`: camada fina sobre a API REST, pensada para agentes de código e scripts.
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";

const CONFIG_DIR = join(homedir(), ".ofertas");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Config = { url: string; token: string };

const HELP = `ofertas — CLI da plataforma de ofertas

Uso:
  ofertas login --url <API_URL> --token <ofk_...>
  ofertas whoami
  ofertas offers search <termo> [--min-discount N] [--limit N]
  ofertas offers list [--status new|approved|rejected|expired]
  ofertas creatives generate <offer_id> [--template card_preco|cupom_destaque] [--format wa_image,feed_4x5,story_9x16]
  ofertas upload <arquivo> [--offer <offer_id>] [--title T] [--ai]

Opções gerais:
  --json   saída em JSON (para scripts e agentes)
  --dry    prévia sem alterar nada (comandos que alteram)
`;

async function loadConfig(): Promise<Config> {
  const envUrl = process.env.OFERTAS_URL;
  const envToken = process.env.OFERTAS_TOKEN;
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Config;
  } catch {
    throw new Error("Sem login. Rode: ofertas login --url http://localhost:3001 --token ofk_...");
  }
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const e = (body as { error?: { message?: string; hint?: string } })?.error;
    super(e ? `${e.message}${e.hint ? ` (${e.hint})` : ""}` : `HTTP ${status}`);
  }
}

async function call<T>(cfg: Config, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "x-client": "cli",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiFailure(res.status, data);
  return data as T;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const brl = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean", default: false },
      dry: { type: "boolean", default: false },
      "min-discount": { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
      template: { type: "string" },
      format: { type: "string" },
      offer: { type: "string" },
      title: { type: "string" },
      ai: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  const out = (data: unknown, human: () => void) =>
    values.json ? console.log(JSON.stringify(data, null, 2)) : human();
  const dry = values.dry ? "?dry_run=true" : "";

  if (!cmd || values.help) return console.log(HELP);

  if (cmd === "login") {
    if (!values.url || !values.token) throw new Error("Informe --url e --token.");
    const cfg = { url: values.url, token: values.token };
    const ov = await call<{ workspace: { name: string } }>(cfg, "GET", "/v1/workspace/overview");
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    await chmod(CONFIG_FILE, 0o600).catch(() => {});
    return console.log(
      `Conectado ao workspace "${ov.workspace.name}". Configuração em ${CONFIG_FILE}`,
    );
  }

  const cfg = await loadConfig();

  if (cmd === "whoami") {
    const ov = await call<{
      workspace: { name: string };
      modules: { name: string; status: string }[];
    }>(cfg, "GET", "/v1/workspace/overview");
    return out(ov, () => {
      console.log(`Workspace: ${ov.workspace.name}`);
      for (const m of ov.modules)
        console.log(`  ${m.status === "available" ? "✓" : "·"} ${m.name}`);
    });
  }

  if (cmd === "offers" && sub === "search") {
    const keyword = rest.join(" ");
    const res = await call<{
      items: {
        product_id: string;
        score: number;
        title: string;
        price: number;
        discount_pct: number | null;
        flags: string[];
      }[];
    }>(cfg, "POST", "/v1/offers/search", {
      keyword: keyword || undefined,
      min_discount: values["min-discount"] ? Number(values["min-discount"]) : undefined,
      limit: values.limit ? Number(values.limit) : 10,
    });
    return out(res, () => {
      for (const i of res.items) {
        console.log(
          `${String(i.score).padStart(3)}  ${brl(i.price).padStart(12)}  -${i.discount_pct ?? 0}%  ${i.title}`,
        );
        console.log(
          `     product_id=${i.product_id}${i.flags.length ? `  [${i.flags.join(", ")}]` : ""}`,
        );
      }
    });
  }

  if (cmd === "offers" && sub === "list") {
    const q = new URLSearchParams({
      limit: values.limit ?? "20",
      ...(values.status ? { status: values.status } : {}),
    });
    const res = await call<{
      items: { id: string; status: string; score: number; title: string; price: number }[];
    }>(cfg, "GET", `/v1/offers?${q}`);
    return out(res, () => {
      for (const o of res.items)
        console.log(
          `${o.status.padEnd(9)} ${String(o.score).padStart(3)}  ${brl(o.price).padStart(12)}  ${o.title}\n          offer_id=${o.id}`,
        );
    });
  }

  if (cmd === "creatives" && sub === "generate") {
    const offerId = rest[0];
    if (!offerId) throw new Error("Informe o offer_id.");
    const res = await call<{
      status: string;
      result?: {
        id: string;
        variants: { format: string; url: string; preview_url: string | null }[];
      };
    }>(cfg, "POST", `/v1/creatives/generate${dry}`, {
      offer_id: offerId,
      template: values.template ?? "card_preco",
      formats: values.format ? values.format.split(",") : ["wa_image"],
    });
    return out(res, () => {
      if (!res.result) return console.log(JSON.stringify(res, null, 2));
      console.log(`Criativo ${res.result.id}`);
      for (const v of res.result.variants) console.log(`  ${v.format}: ${v.url}`);
    });
  }

  if (cmd === "upload") {
    const file = sub;
    if (!file) throw new Error("Informe o arquivo.");
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime) throw new Error("Use PNG, JPEG ou WebP.");
    const size = (await stat(file)).size;
    const ticket = await call<{ result: { upload_id: string; put_url: string } }>(
      cfg,
      "POST",
      "/v1/creatives/uploads",
      {
        filename: basename(file),
        mime,
        size_bytes: size,
      },
    );
    const put = await fetch(ticket.result.put_url, {
      method: "PUT",
      headers: { "content-type": mime },
      body: await readFile(file),
    });
    if (!put.ok) throw new ApiFailure(put.status, await put.json().catch(() => null));
    const res = await call<{
      result: {
        id: string;
        variants: { format: string; url: string; validation: { message: string }[] }[];
      };
    }>(cfg, "POST", `/v1/creatives/uploads/${ticket.result.upload_id}/complete`, {
      offer_id: values.offer,
      title: values.title ?? basename(file),
      ai_generated: values.ai || undefined,
    });
    return out(res, () => {
      console.log(`Criativo ${res.result.id}`);
      for (const v of res.result.variants) {
        console.log(`  ${v.format}: ${v.url}`);
        for (const i of v.validation) console.log(`    ! ${i.message}`);
      }
    });
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
