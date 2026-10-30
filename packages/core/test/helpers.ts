import { defaultAffiliateConnectorFactory } from "@ofertas/connectors";
import { createDb, runMigrations } from "@ofertas/db";
import { resetDb } from "@ofertas/db/testing";
import { type Deps, MemoryCache, MemoryCounterStore, SecretBox, signup } from "../src";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** Conecta no banco de teste, aplica migrations e limpa os dados. */
export async function setupTestDeps(): Promise<Deps & { close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST não definida");
  await runMigrations(url);
  const { db, close } = createDb(url, { max: 5 });
  await resetDb(db);
  return {
    db,
    counters: new MemoryCounterStore(),
    cache: new MemoryCache(),
    redirectBaseUrl: "http://go.test",
    secrets: new SecretBox(TEST_KEY),
    affiliateConnectors: defaultAffiliateConnectorFactory,
    close,
  };
}

let n = 0;
export async function createOwner(deps: Deps) {
  n++;
  return signup(
    deps,
    {
      name: `Dono ${n}`,
      email: `dono${n}-${Date.now()}@teste.com`,
      password: "senha-forte-123",
      workspace_name: `Loja ${n}`,
    },
    { allowSignup: true },
  );
}
