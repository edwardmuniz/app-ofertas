import { ClickBuffer, RedisCache, RedisCounterStore } from "@ofertas/core";
import { createDb } from "@ofertas/db";
import { Redis } from "ioredis";
import { z } from "zod";
import { buildRedirectApp } from "./app";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    REDIRECT_PORT: z.coerce.number().int().default(3002),
    REDIRECT_PUBLIC_URL: z.string().default("http://localhost:3002"),
    IP_HASH_SALT: z.string().min(16, "IP_HASH_SALT precisa de pelo menos 16 caracteres"),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .parse(process.env);

const { db, close } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const clicks = new ClickBuffer(db);

const app = await buildRedirectApp({
  deps: {
    db,
    counters: new RedisCounterStore(redis),
    cache: new RedisCache(redis),
    redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  },
  clicks,
  ipSalt: env.IP_HASH_SALT,
  trustProxy: env.TRUST_PROXY,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await clicks.close();
  await close();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.REDIRECT_PORT, host: "0.0.0.0" });
