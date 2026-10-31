import {
  createRuntimeDeps,
  runAutomationRules,
  runDueSavedSearches,
  runPublisher,
} from "@ofertas/core";
import { z } from "zod";

/**
 * Processo de tarefas contínuas. Nesta fase: buscas salvas (curadoria automática) e expiração
 * de ofertas vencidas. Também envia a fila de publicação e roda as regras automáticas.
 */
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    REDIRECT_PUBLIC_URL: z.string().default("http://localhost:3002"),
    ENCRYPTION_KEY: z.string().min(40),
    WORKER_TICK_SECONDS: z.coerce.number().int().min(10).default(60),
    PUBLISH_TICK_SECONDS: z.coerce.number().int().min(2).default(5),
    EVOLUTION_GO_URL: z.string().optional(),
    EVOLUTION_GO_API_KEY: z.string().optional(),
  })
  .parse(process.env);

const { deps, close } = createRuntimeDeps({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redirectBaseUrl: env.REDIRECT_PUBLIC_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  evolutionGo:
    env.EVOLUTION_GO_URL && env.EVOLUTION_GO_API_KEY
      ? { baseUrl: env.EVOLUTION_GO_URL, globalKey: env.EVOLUTION_GO_API_KEY }
      : null,
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
    if (res.ran.length || res.expired) log("buscas salvas", res);
    const rules = await runAutomationRules(deps);
    if (rules.scheduled) log("regras automáticas", rules);
  } catch (err) {
    log("erro na rodada", { error: String(err) });
  } finally {
    running = false;
  }
}

let publishing = false;
/** Fila de publicação: envia os posts vencidos com pausa entre envios. */
async function publishTick() {
  if (publishing || stopping) return;
  const lock = await deps.cache.setIfAbsent("lock:worker:publish", String(process.pid), 60);
  if (!lock) return;
  publishing = true;
  try {
    const results = await runPublisher(deps, { batch: 10, pauseMs: 2000 });
    if (results.length) log("publicação", results);
  } catch (err) {
    log("erro na publicação", { error: String(err) });
  } finally {
    await deps.cache.del("lock:worker:publish");
    publishing = false;
  }
}

const timer = setInterval(() => void tick(), env.WORKER_TICK_SECONDS * 1000);
const publishTimer = setInterval(() => void publishTick(), env.PUBLISH_TICK_SECONDS * 1000);
void tick();
log(`worker iniciado (a cada ${env.WORKER_TICK_SECONDS}s)`);

const shutdown = async () => {
  stopping = true;
  clearInterval(timer);
  clearInterval(publishTimer);
  while (running || publishing) await new Promise((r) => setTimeout(r, 200));
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
