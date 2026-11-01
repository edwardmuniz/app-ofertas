import { resolve } from "node:path";
import { createRuntimeDeps, s3ConfigFromEnv } from "@ofertas/core";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const { deps, close } = createRuntimeDeps({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  evolutionGo:
    env.EVOLUTION_GO_URL && env.EVOLUTION_GO_API_KEY
      ? { baseUrl: env.EVOLUTION_GO_URL, globalKey: env.EVOLUTION_GO_API_KEY }
      : null,
  messagingWebhookUrl: env.MESSAGING_WEBHOOK_URL ?? `${env.API_PUBLIC_URL}/webhooks/whatsapp`,
  mediaDir: resolve(process.cwd(), process.env.MEDIA_DIR ?? "../../data/media"),
  s3: s3ConfigFromEnv(process.env),
  gemini: process.env.GOOGLE_API_KEY
    ? { apiKey: process.env.GOOGLE_API_KEY, model: process.env.GEMINI_MODEL }
    : null,
  publicApiUrl: env.API_PUBLIC_URL,
});

const app = await buildApp({
  deps,
  allowSignup: env.ALLOW_SIGNUP,
  publicUrl: env.API_PUBLIC_URL,
  secureCookies: env.NODE_ENV === "production",
  trustProxy: env.TRUST_PROXY,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
app.log.info(`API em ${env.API_PUBLIC_URL} — MCP em ${env.API_PUBLIC_URL}/mcp`);
