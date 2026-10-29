import { RedisCounterStore } from "@ofertas/core";
import { createDb } from "@ofertas/db";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

const app = await buildApp({
  deps: { db, counters: new RedisCounterStore(redis) },
  allowSignup: env.ALLOW_SIGNUP,
  publicUrl: env.API_PUBLIC_URL,
  secureCookies: env.NODE_ENV === "production",
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await close();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
app.log.info(`API em ${env.API_PUBLIC_URL} — MCP em ${env.API_PUBLIC_URL}/mcp`);
