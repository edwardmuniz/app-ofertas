import postgres from "postgres";
import { runMigrations } from "./migrate";

const url = process.argv[2] === "--test" ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida (copie .env.example para .env).");
  process.exit(1);
}

/** Espera o Postgres aceitar conexões (logo depois do `infra:up` ele ainda está subindo). */
async function waitForDb(dbUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = postgres(dbUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      await client`select 1`;
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      await client.end({ timeout: 1 });
    }
  }
}

await waitForDb(url);
await runMigrations(url);
console.log("Migrations aplicadas.");
