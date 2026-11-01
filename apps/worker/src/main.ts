import { resolve } from "node:path";
import {
  createRuntimeDeps,
  recordWorkerHeartbeat,
  refreshMessagingStatuses,
  rollupClicks,
  runAutomationRules,
  runDueSavedSearches,
  runFeedSync,
  runHealthChecks,
  runPublisher,
  s3ConfigFromEnv,
} from "@ofertas/core";
import { z } from "zod";

/**
 * Processo de tarefas contínuas: buscas salvas e expiração de ofertas, regras automáticas,
 * fila de publicação, consolidação de métricas e verificação de saúde (alertas).
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
  mediaDir: resolve(process.cwd(), process.env.MEDIA_DIR ?? "../../data/media"),
  s3: s3ConfigFromEnv(process.env),
  publicApiUrl: process.env.API_PUBLIC_URL ?? "http://localhost:3001",
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
  }
  await maintenance();
  try {
    await recordWorkerHeartbeat(deps);
  } finally {
    running = false;
  }
}

let lastSlow = 0;
/** Métricas e saúde: consolida cliques, confere números (a cada 5 min) e abre/resolve alertas. */
async function maintenance() {
  const slow = Date.now() - lastSlow >= 5 * 60_000;
  try {
    if (slow) {
      lastSlow = Date.now();
      const r = await rollupClicks(deps);
      if (r.rows) log("métricas consolidadas", r);
      const st = await refreshMessagingStatuses(deps);
      if (st.changed) log("status dos números atualizado", st);
    }
    const h = await runHealthChecks(deps);
    if (h.opened || h.resolved) log("alertas", h);
  } catch (err) {
    log("erro na manutenção", { error: String(err) });
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
    await recordWorkerHeartbeat(deps);
  } catch (err) {
    log("erro na publicação", { error: String(err) });
  } finally {
    await deps.cache.del("lock:worker:publish");
    publishing = false;
  }
}

let feeding = false;
/**
 * Feed de produtos: baixa e importa os CSVs das contas em modo feed (uma vez por dia).
 * Pode levar minutos, então roda à parte, sem segurar as buscas, regras e a fila.
 */
async function feedTick() {
  if (feeding || stopping) return;
  // Trava curta, renovada enquanto importa: se o worker morrer, ela some em até 90 s.
  const lock = await deps.cache.setIfAbsent("lock:worker:feed", String(process.pid), 90);
  if (!lock) return;
  feeding = true;
  const renew = setInterval(() => {
    void deps.cache.set("lock:worker:feed", String(process.pid), 90).catch(() => undefined);
  }, 30_000);
  try {
    const results = await runFeedSync(deps);
    if (results.length) log("feed de produtos", results);
  } catch (err) {
    log("erro no feed de produtos", { error: String(err) });
  } finally {
    clearInterval(renew);
    await deps.cache.del("lock:worker:feed");
    feeding = false;
  }
}

const timer = setInterval(() => void tick(), env.WORKER_TICK_SECONDS * 1000);
const feedTimer = setInterval(() => void feedTick(), 60_000);
void feedTick();
const publishTimer = setInterval(() => void publishTick(), env.PUBLISH_TICK_SECONDS * 1000);
void tick();
log(`worker iniciado (a cada ${env.WORKER_TICK_SECONDS}s)`);

const shutdown = async () => {
  stopping = true;
  clearInterval(timer);
  clearInterval(publishTimer);
  clearInterval(feedTimer);
  // Importação do feed em andamento é interrompida: solta a trava para recomeçar logo.
  if (feeding) await deps.cache.del("lock:worker:feed").catch(() => undefined);
  while (running || publishing) await new Promise((r) => setTimeout(r, 200));
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
