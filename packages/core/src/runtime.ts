import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import { createDb } from "@ofertas/db";
import { Redis } from "ioredis";
import { RedisCache } from "./cache";
import type { Deps } from "./context";
import { RedisCounterStore } from "./limits";
import { createSafeFetcher } from "./safe-fetch";
import { SecretBox } from "./secrets";
import { LocalStorage } from "./storage";

export type RuntimeConfig = {
  databaseUrl: string;
  redisUrl: string;
  redirectBaseUrl: string;
  encryptionKey: string;
  evolutionGo?: { baseUrl: string; globalKey: string } | null;
  messagingWebhookUrl?: string | null;
  /** Pasta dos arquivos (armazenamento local) */
  mediaDir: string;
  publicApiUrl: string;
  dbPoolSize?: number;
};

/** Monta as dependências reais (Postgres, Redis, cifra, conectores) usadas pelos apps. */
export function createRuntimeDeps(cfg: RuntimeConfig) {
  const { db, close: closeDb } = createDb(cfg.databaseUrl, { max: cfg.dbPoolSize });
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 });
  const deps: Deps = {
    db,
    counters: new RedisCounterStore(redis),
    cache: new RedisCache(redis),
    redirectBaseUrl: cfg.redirectBaseUrl,
    secrets: new SecretBox(cfg.encryptionKey),
    affiliateConnectors: defaultAffiliateConnectorFactory,
    messaging: createMessagingProviderFactory({ evolutionGo: cfg.evolutionGo }),
    messagingWebhookUrl: cfg.messagingWebhookUrl ?? null,
    storage: new LocalStorage(cfg.mediaDir),
    fetchMedia: createSafeFetcher(),
    publicApiUrl: cfg.publicApiUrl,
  };
  const close = async () => {
    await closeDb();
    redis.disconnect();
  };
  return { deps, close };
}
