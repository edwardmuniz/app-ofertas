import {
  createMessagingProviderFactory,
  defaultAffiliateConnectorFactory,
} from "@ofertas/connectors";
import { createDb } from "@ofertas/db";
import { Redis } from "ioredis";
import { RedisCache } from "./cache";
import type { Deps } from "./context";
import { RedisCounterStore } from "./limits";
import {
  createSafeFetcher,
  createSafeNotifier,
  createSafePageFetcher,
  createSafeStreamOpener,
} from "./safe-fetch";
import { SecretBox } from "./secrets";
import { LocalStorage } from "./storage";
import { type S3Config, S3Storage } from "./storage-s3";

export type RuntimeConfig = {
  databaseUrl: string;
  redisUrl: string;
  redirectBaseUrl: string;
  encryptionKey: string;
  evolutionGo?: { baseUrl: string; globalKey: string } | null;
  messagingWebhookUrl?: string | null;
  /** Pasta dos arquivos (armazenamento local) */
  mediaDir: string;
  /** Com S3, os arquivos vão para o bucket (o disco local continua sendo lido para os antigos). */
  s3?: S3Config | null;
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
    storage: cfg.s3
      ? new S3Storage(cfg.s3, new LocalStorage(cfg.mediaDir))
      : new LocalStorage(cfg.mediaDir),
    fetchMedia: createSafeFetcher(),
    fetchPage: createSafePageFetcher(),
    openStream: createSafeStreamOpener(),
    notify: createSafeNotifier(),
    publicApiUrl: cfg.publicApiUrl,
  };
  const close = async () => {
    await closeDb();
    redis.disconnect();
  };
  return { deps, close };
}
