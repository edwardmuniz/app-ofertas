import { createRuntimeDeps } from "@ofertas/core";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const { deps, close } = createRuntimeDeps({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  encryptionKey: env.ENCRYPTION_KEY,
});

const app = await buildApp({
  deps,
  allowSignup: env.ALLOW_SIGNUP,
  publicUrl: env.API_PUBLIC_URL,
  secureCookies: env.NODE_ENV === "production",
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
