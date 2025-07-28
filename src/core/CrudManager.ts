import Pocketbase from "pocketbase";
import CacheHandler from "./CacheManager";

export type BaseRecord = {
  id: string;
  created: string;
  updated: string;
};

export type ListOptions<T> = {
  page?: number;
  limit?: number;
  filter?: string;
  sort?: string;
  expand?: string[];
};

export type PaginatedResponse<T> = {
  items: T[];
  totalItems: number;
  totalPages: number;
  page: number;
  limit: number;
  cacheKey: string; // ✅ clients can store this key!
};

export class DatabaseService {
  private pb: Pocketbase;
  private cache: CacheHandler;
  private isBatchMode = false;
  private batchQueue: Array<{ action: "create" | "update" | "delete"; payload: any }> = [];

  constructor(pocketbaseInstance: Pocketbase, cacheController: CacheHandler) {
    this.pb = pocketbaseInstance;
    this.cache = cacheController;
  }

  public setBatch(enable: boolean) {
    this.isBatchMode = enable;
  }

  /** Combines parts into a normalized cache key. */
  private generateCacheKey(parts: (string | number | undefined)[]): string {
    return parts.filter(Boolean).join(":");
  }

  /** Dynamic TTL based on usage or type. */
  private getDynamicTTL(key: string, mode: "short" | "medium" | "long" = "medium"): number {
    switch (mode) {
      case "short": return 10 * 60; // 10 min
      case "medium": return 60 * 60; // 1 hour
      case "long": return 6 * 60 * 60; // 6 hours
    }
  }

  public async saveChanges() {
    for (const op of this.batchQueue) {
      switch (op.action) {
        case "create":
          await this.create(op.payload.collection, op.payload.data, false);
          break;
        case "update":
          await this.update(op.payload.collection, op.payload.id, op.payload.data);
          break;
        case "delete":
          await this.delete(op.payload.collection, op.payload.id);
          break;
      }
    }
    this.batchQueue = [];
    this.isBatchMode = false;
  }

  /** Get one record, with caching. */
  public async get<T extends BaseRecord>(
    collection: string,
    id: string,
    expand?: string[]
  ): Promise<(T & { cacheKey: string }) | null> {
    const cacheKey = this.generateCacheKey([collection, "get", id, expand?.join(",")]);
    const cached = this.cache.get<T>(cacheKey);
    if (cached) return { ...cached, cacheKey };

    try {
      const record = await this.pb.collection(collection).getOne<T>(id, {
        ...(expand && { expand: expand.join(",") }),
      });
      this.cache.set(cacheKey, record, this.getDynamicTTL(cacheKey));
      return { ...record, cacheKey };
    } catch (error: any) {
      if (error.status === 404) return null;
      console.error(`[DatabaseService] get failed: ${collection}/${id}`, error);
      throw error;
    }
  }

  /** List records with pagination + caching. */
  public async list<T extends BaseRecord>(
    collection: string,
    options: ListOptions<T>
  ): Promise<PaginatedResponse<T>> {
    const { page = 1, limit = 10, filter, sort, expand } = options;
    const cacheKey = this.generateCacheKey([collection, "list", page, limit, filter, sort, expand?.join(",")]);

    const cached = this.cache.get<PaginatedResponse<T>>(cacheKey);
    if (cached) return cached;

    const result = await this.pb.collection(collection).getList<T>(page, limit, {
      filter,
      sort,
      ...(expand && { expand: expand.join(",") }),
    });

    const response: PaginatedResponse<T> = {
      items: result.items,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
      page: result.page,
      limit: result.perPage,
      cacheKey,
    };

    this.cache.set(cacheKey, response, this.getDynamicTTL(cacheKey));
    return response;
  }

  /** Create a record. Supports batching + scaffold. */
  public async create<T extends BaseRecord>(
    collection: string,
    data: Partial<T>,
    useScaffold: boolean = false
  ): Promise<T> {
    if (this.isBatchMode && useScaffold) {
      const scaffoldId = Math.random().toString(36).substring(2, 10);
      const scaffoldRecord: any = {
        ...data,
        id: scaffoldId,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        scaffold: true,
      };

      // Prepend to any feed cache:
      this.cache.keys().forEach((key) => {
        if (key.startsWith(`${collection}:list`)) {
          const existing = this.cache.get<any>(key);
          if (existing && Array.isArray(existing.items)) {
            existing.items = [scaffoldRecord, ...existing.items];
            this.cache.set(key, existing, this.getDynamicTTL(key));
          }
        }
      });

      this.batchQueue.push({ action: "create", payload: { collection, data } });
      return scaffoldRecord;
    }

    const record = await this.pb.collection(collection).create<T>(data);
    this.cache.invalidateByPrefix(this.generateCacheKey([collection, "list"]));
    return record;
  }
 
  public async update<T extends BaseRecord>(
    collection: string,
    id: string,
    data: Partial<T>,
    expand?: string[]
  ): Promise<T> {
    if (this.isBatchMode) {
      this.batchQueue.push({ action: "update", payload: { collection, id, data } });
      return { id, created: "", updated: "", ...(data as any) };
    }

    const record = await this.pb.collection(collection).update<T>(id, data, {
      ...(expand && { expand: expand.join(",") }),
    });

    this.cache.delete(this.generateCacheKey([collection, "get", id]));
    this.cache.invalidateByPrefix(this.generateCacheKey([collection, "list"]));
    return record;
  }

  /** Delete a record. */
  public async delete(collection: string, id: string): Promise<boolean> {
    if (this.isBatchMode) {
      this.batchQueue.push({ action: "delete", payload: { collection, id } });
      return true;
    }

    const success = await this.pb.collection(collection).delete(id);
    if (success) {
      this.cache.delete(this.generateCacheKey([collection, "get", id]));
      this.cache.invalidateByPrefix(this.generateCacheKey([collection, "list"]));
    }
    return success;
  }
}
