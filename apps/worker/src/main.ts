import { createRuntimeDeps, runDueSavedSearches } from "@ofertas/core";
import { z } from "zod";

/**
 * Processo de tarefas contínuas. Nesta fase: buscas salvas (curadoria automática) e expiração
 * de ofertas vencidas. Na Fase 3 entra a fila de publicação (BullMQ).
 */
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    REDIRECT_PUBLIC_URL: z.string().default("http://localhost:3002"),
    ENCRYPTION_KEY: z.string().min(40),
    WORKER_TICK_SECONDS: z.coerce.number().int().min(10).default(60),
  })
  .parse(process.env);

const { deps, close } = createRuntimeDeps({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  dbPoolSize: 4,
});

const log = (msg: string, extra?: unknown) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(extra ? { extra } : {}) }));

let running = false;
let stopping = false;

async function tick() {
  if (running || stopping) return;
  // Trava no Redis: com mais de um worker, só um roda a rodada.
  const lock = await deps.cache.setIfAbsent(
    "lock:worker:harvest",
    String(process.pid),
    env.WORKER_TICK_SECONDS - 5,
  );
  if (!lock) return;
  running = true;
  try {
    const res = await runDueSavedSearches(deps);
    if (res.ran.length || res.expired) log("rodada concluída", res);
  } catch (err) {
    log("erro na rodada", { error: String(err) });
  } finally {
    running = false;
  }
}

const timer = setInterval(() => void tick(), env.WORKER_TICK_SECONDS * 1000);
void tick();
log(`worker iniciado (a cada ${env.WORKER_TICK_SECONDS}s)`);

const shutdown = async () => {
  stopping = true;
  clearInterval(timer);
  while (running) await new Promise((r) => setTimeout(r, 200));
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
