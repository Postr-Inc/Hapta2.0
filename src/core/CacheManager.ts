//@ts-nocheck
const COMPRESSION_THRESHOLD = 1024;

interface CacheSyncMessage {
  action: "set" | "delete" | "invalidate";
  key: string;
  data?: any; // For 'set'
  expiresAt?: number;
  source: number;
}

export default class CacheHandler {
  private cache = new Map<string, { data: any; ttl: number; compressed?: boolean }>();
  private broadcastCallback?: (msg: CacheSyncMessage) => void;

  constructor() {
    this.startExpirationCheck();
  }

  public setBroadcastCallback(callback: (msg: CacheSyncMessage) => void) {
    this.broadcastCallback = callback;
  }
  public timesVisited = new Map<string, { incremental: number }>();
  /** Store data in cache, compress if large */
  public set(key: string, data: any, ttlSeconds = 0, isInternal = false): any {
    if (!key.includes("undefined") && !key.includes("null")) {
      const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
      try {
        const jsonStr = JSON.stringify(data);
        if (jsonStr.length > COMPRESSION_THRESHOLD) {
          const compressed = Bun.gzipSync(new TextEncoder().encode(jsonStr));
          this.cache.set(key, { data: compressed, ttl: expiresAt, compressed: true });
        } else {
          this.cache.set(key, { data, ttl: expiresAt });
        }
      } catch {
        this.cache.set(key, { data, ttl: expiresAt });
      }

      if (this.broadcastCallback && !isInternal) {
        this.broadcastCallback({ action: "set", key, data, expiresAt, source: parseInt(config.Server.NodeId as any) });
      }
    } else {
      console.warn(`[CacheHandler] Invalid cache key: ${key}`);
    }
    return data;
  }
  public getDynamicTTL(key: string, mode: "immediate" | "short" | "medium" | "long" | "dynamic" = "dynamic"): number {
    if (mode !== "dynamic") {
      switch (mode) {
        case "immediate": return 5 * 60 * 1000;
        case "short": return 30 * 60 * 1000;
        case "medium": return 2 * 60 * 60 * 1000;
        case "long": return 6 * 60 * 60 * 1000;
      }
    }
    let status = this.timesVisited.get(key) ?? { incremental: 0 };
    status.incremental++;
    this.timesVisited.set(key, status);

    if (status.incremental > 5) {
      return 30 * 60 * 1000; // 30 mins
    } else if (status.incremental > 0) {
      return 2 * 60 * 60 * 1000; // 2 hrs
    } else {
      return 6 * 60 * 60 * 1000; // 6 hrs default
    }
  }
  public get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.ttl > 0 && entry.ttl < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    if (entry.compressed) {
      try {
        const decompressed = Bun.gunzipSync(entry.data);
        return JSON.parse(new TextDecoder().decode(decompressed));
      } catch {
        this.cache.delete(key);
        return null;
      }
    }
    return entry.data;
  }

  public delete(key: string): boolean {
    if (this.broadcastCallback) {
      this.broadcastCallback({ action: "delete", key, source: parseInt(config.Server.NodeId as any) });
    }
    return this.cache.delete(key);
  }

  /** Invalidate all keys starting with prefix */
  public invalidateByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        if (this.broadcastCallback) {
          this.broadcastCallback({ action: "invalidate", key, source: parseInt(config.Server.NodeId as any) });
        }
      }
    }
  }

  private startExpirationCheck() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, { ttl }] of this.cache.entries()) {
        if (ttl > 0 && ttl < now) {
          this.cache.delete(key);
        }
      }
    }, 60000);
  }
}
