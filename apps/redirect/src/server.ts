import { resolve } from "node:path";
import { ClickBuffer, createRuntimeDeps } from "@ofertas/core";
import { z } from "zod";
import { buildRedirectApp } from "./app";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    REDIRECT_PORT: z.coerce.number().int().default(3002),
    REDIRECT_PUBLIC_URL: z.string().default("http://localhost:3002"),
    ENCRYPTION_KEY: z.string().min(40),
    IP_HASH_SALT: z.string().min(16, "IP_HASH_SALT precisa de pelo menos 16 caracteres"),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .parse(process.env);

const { deps, close } = createRuntimeDeps({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  mediaDir: resolve(process.cwd(), process.env.MEDIA_DIR ?? "../../data/media"),
  publicApiUrl: process.env.API_PUBLIC_URL ?? "http://localhost:3001",
});
const clicks = new ClickBuffer(deps.db);

const app = await buildRedirectApp({
  deps,
  clicks,
  ipSalt: env.IP_HASH_SALT,
  trustProxy: env.TRUST_PROXY,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await clicks.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.REDIRECT_PORT, host: "0.0.0.0" });
