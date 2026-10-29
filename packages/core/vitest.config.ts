import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile("../../.env");
} catch {
  // sem .env: usa variáveis do ambiente (CI)
}

export default defineConfig({
  test: {
    fileParallelism: false,
    env: { DATABASE_URL_TEST: process.env.DATABASE_URL_TEST ?? "" },
  },
});
