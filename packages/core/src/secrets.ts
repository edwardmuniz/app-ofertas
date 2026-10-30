import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Cifra segredos de terceiros em repouso com AES-256-GCM. Formato: v1.<iv>.<tag>.<dados> (base64). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) {
      throw new Error(
        "ENCRYPTION_KEY precisa ter 32 bytes em base64 (gere com: openssl rand -base64 32).",
      );
    }
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, data]
      .map((p) => (typeof p === "string" ? p : p.toString("base64")))
      .join(".");
  }

  decrypt(box: string): string {
    const [version, iv, tag, data] = box.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Segredo em formato inválido.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
      "utf8",
    );
  }

  encryptJson(value: unknown) {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(box: string): T {
    return JSON.parse(this.decrypt(box)) as T;
  }
}
