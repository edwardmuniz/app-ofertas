import { runMigrations } from "./migrate";

const url = process.argv[2] === "--test" ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida (copie .env.example para .env).");
  process.exit(1);
}

await runMigrations(url);
console.log("Migrations aplicadas.");
