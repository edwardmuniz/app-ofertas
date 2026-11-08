import { limits as limitsTable } from "@ofertas/db";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Deps } from "./context";
import { AppError } from "./errors";

/** Contador com janela de tempo (rate limit). */
export interface CounterStore {
  incr(key: string, windowSec: number): Promise<{ count: number; ttlSec: number }>;
}

export class MemoryCounterStore implements CounterStore {
  private store = new Map<string, { count: number; resetAt: number }>();

  async incr(key: string, windowSec: number) {
    const nowMs = Date.now();
    let entry = this.store.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      entry = { count: 0, resetAt: nowMs + windowSec * 1000 };
      this.store.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, ttlSec: Math.ceil((entry.resetAt - nowMs) / 1000) };
  }
}

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: Redis) {}

  async incr(key: string, windowSec: number) {
    const res = await this.redis.multi().incr(key).expire(key, windowSec, "NX").ttl(key).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSec);
    return { count, ttlSec: ttl > 0 ? ttl : windowSec };
  }
}

/** Limites padrão. Cada workspace pode sobrescrever na tabela `limits`. */
export const DEFAULT_LIMITS = {
  /** Por token (agentes, extensão, integrações) */
  "api.requests_per_minute": 120,
  /** Por pessoa logada no painel: cada tela faz várias chamadas de uma vez */
  "api.session_requests_per_minute": 600,
  /** Intervalo mínimo entre mensagens no mesmo grupo (piso; cada regra escolhe o seu) */
  "posts.min_interval_minutes": 1,
  /** Máximo de mensagens por hora em um mesmo número */
  "posts.per_hour.account": 60,
  /** Atraso aleatório máximo somado a cada envio (parece mais humano) */
  "posts.jitter_seconds": 45,
  /** Tentativas de login por IP a cada 15 min (antes de existir workspace, não sobrescrevível) */
  "auth.login_per_ip": 20,
  /** Tentativas de login por e-mail a cada 15 min */
  "auth.login_per_email": 10,
  /** Pessoas da equipe adicionadas a grupos por dia, por número (adicionar demais = banimento) */
  "groups.add_per_day": 20,
} as const satisfies Record<string, number>;

export type LimitKey = keyof typeof DEFAULT_LIMITS;

export async function getLimit(deps: Pick<Deps, "db">, workspaceId: string, key: LimitKey) {
  const [row] = await deps.db
    .select({ value: limitsTable.value })
    .from(limitsTable)
    .where(and(eq(limitsTable.workspaceId, workspaceId), eq(limitsTable.key, key)))
    .limit(1);
  return row?.value ?? DEFAULT_LIMITS[key];
}

/** Consome 1 unidade do limite. Lança LIMIT_EXCEEDED quando passa do máximo. */
export async function consumeLimit(
  deps: Pick<Deps, "counters">,
  opts: { key: LimitKey; bucket: string; max: number; windowSec: number },
) {
  const { count, ttlSec } = await deps.counters.incr(
    `limit:${opts.key}:${opts.bucket}`,
    opts.windowSec,
  );
  if (count > opts.max) {
    throw new AppError("LIMIT_EXCEEDED", `Limite "${opts.key}" atingido (${opts.max}).`, {
      hint: `Aguarde ${ttlSec}s antes de tentar de novo.`,
      details: { limit: opts.key, max: opts.max, retry_after_seconds: ttlSec },
    });
  }
}
