import type { Redis } from "ioredis";

/** Cache chave/valor com expiração. */
export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Grava só se a chave não existir. Retorna true se gravou. */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export class MemoryCache implements KeyValueCache {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSec: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSec: number) {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSec);
    return true;
  }

  async del(key: string) {
    this.store.delete(key);
  }
}

export class RedisCache implements KeyValueCache {
  constructor(private readonly redis: Redis) {}

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSec: number) {
    await this.redis.set(key, value, "EX", ttlSec);
  }

  async setIfAbsent(key: string, value: string, ttlSec: number) {
    return (await this.redis.set(key, value, "EX", ttlSec, "NX")) === "OK";
  }

  async del(key: string) {
    await this.redis.del(key);
  }
}
