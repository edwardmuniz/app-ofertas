import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** Apaga todos os dados das tabelas da aplicação. Uso exclusivo em testes. */
export async function resetDb(db: Db) {
  await db.execute(sql`
    DO $$ DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}
