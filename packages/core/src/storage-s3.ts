import { createHash, createHmac } from "node:crypto";
import type { ObjectStorage } from "./storage";

export type S3Config = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Sem região, descobre pelo próprio bucket na primeira chamada. */
  region?: string;
};

/** Lê a configuração do S3 das variáveis AWS_*; null se faltar alguma obrigatória. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const bucket = env.AWS_S3_BUCKET?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    region: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || undefined,
  };
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** URL pré-assinada (AWS SigV4, assinatura na query). Só o header host é assinado. */
export function presignS3Url(input: {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  bucket: string;
  region: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresSeconds: number;
  now?: Date;
}) {
  const { bucket, region } = input;
  // Bucket com ponto quebra o certificado no estilo virtual-host: usa o estilo de caminho.
  const pathStyle = bucket.includes(".");
  const base = region === "us-east-1" ? "s3.amazonaws.com" : `s3.${region}.amazonaws.com`;
  const host = pathStyle ? base : `${bucket}.${base}`;
  const keyPath = input.key.split("/").map(enc).join("/");
  const path = pathStyle ? `/${bucket}/${keyPath}` : `/${keyPath}`;
  const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  if (input.sessionToken) params["X-Amz-Security-Token"] = input.sessionToken;
  const query = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k] as string)}`)
    .join("&");
  const canonical = [input.method, path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join(
    "\n",
  );
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/**
 * Arquivos no S3. Lê também de um armazenamento antigo (disco local) para os arquivos
 * gravados antes do S3; ao gerar link público, sobe o arquivo antigo para o S3.
 */
export class S3Storage implements ObjectStorage {
  private region: Promise<string> | null;

  constructor(
    private readonly cfg: S3Config,
    private readonly legacy: ObjectStorage | null = null,
  ) {
    this.region = cfg.region ? Promise.resolve(cfg.region) : null;
  }

  private getRegion() {
    this.region ??= fetch(`https://${this.cfg.bucket}.s3.amazonaws.com/`, { method: "HEAD" })
      .then((r) => r.headers.get("x-amz-bucket-region") ?? "us-east-1")
      .catch((err) => {
        this.region = null;
        throw err;
      });
    return this.region;
  }

  private async url(method: "GET" | "PUT" | "DELETE" | "HEAD", key: string, expiresSeconds = 300) {
    return presignS3Url({
      ...this.cfg,
      method,
      key,
      region: await this.getRegion(),
      expiresSeconds,
    });
  }

  async put(key: string, data: Buffer) {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const res = await fetch(await this.url("PUT", key), {
      method: "PUT",
      body: new Uint8Array(data),
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
    if (!res.ok) throw new Error(`S3: falha ao gravar ${key} (HTTP ${res.status})`);
  }

  async get(key: string) {
    const res = await fetch(await this.url("GET", key));
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status !== 404 && res.status !== 403) {
      throw new Error(`S3: falha ao ler ${key} (HTTP ${res.status})`);
    }
    return this.legacy ? this.legacy.get(key) : null;
  }

  async delete(key: string) {
    await fetch(await this.url("DELETE", key), { method: "DELETE" });
    await this.legacy?.delete(key);
  }

  /** Link direto e temporário (máx. 7 dias), acessível de fora (ex.: Evolution Go). */
  async signedUrl(key: string, expiresSeconds: number) {
    if (this.legacy) {
      const head = await fetch(await this.url("HEAD", key), { method: "HEAD" });
      if (!head.ok) {
        const old = await this.legacy.get(key);
        if (old) await this.put(key, old);
      }
    }
    return this.url("GET", key, Math.min(expiresSeconds, 7 * 86_400));
  }
}
