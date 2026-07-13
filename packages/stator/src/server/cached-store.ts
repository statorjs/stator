import type { Store } from './store.ts'

interface CacheEntry {
  snapshot: unknown
  /** Epoch ms after which this entry is considered expired. */
  expiresAt: number
}

export interface CachedStoreOptions {
  /** Max number of (sessionId, machineName) entries kept in memory. LRU
   *  eviction when exceeded. Defaults to 10_000. */
  maxEntries?: number
  /** Memory cache TTL per entry, in seconds. Capped at the backing TTL
   *  on a per-set basis — memory never out-lives backing. Defaults to 300
   *  (5 minutes). */
  memoryTtlSeconds?: number
}

/**
 * Write-through, read-cached `Store` decorator.
 *
 * Wraps any backing `Store` and keeps a small in-process LRU of recent
 * reads to reduce backing-store traffic (Upstash command counts, Redis
 * hops, etc.) on hot sessions.
 *
 * Properties:
 *   - **Writes go to backing first**, then update memory. No data loss on
 *     crash; durability matches backing.
 *   - **Memory TTL ≤ backing TTL** per entry. When `set` is called with
 *     `ttlSeconds`, the memory entry's expiry is `min(memoryTtlMs, ttlMs)`.
 *     Memory cannot hold a value that backing would have expired.
 *   - **Bounded by `maxEntries`**, LRU evicted via Map insertion-order
 *     plus delete-then-set on access (`populate` and successful `get`).
 *   - **Safe in single-replica deployments** where this process is the
 *     only writer to the backing store. Not safe across replicas — would
 *     need an invalidation channel (Redis pub/sub) for that.
 */
export class CachedStore implements Store {
  private cache = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly memoryTtlMs: number

  constructor(
    private readonly backing: Store,
    opts: CachedStoreOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? 10_000
    this.memoryTtlMs = (opts.memoryTtlSeconds ?? 300) * 1000
  }

  private key(sid: string, name: string): string {
    return `${sid}:${name}`
  }

  async get(sid: string, name: string): Promise<unknown | null> {
    const k = this.key(sid, name)
    const entry = this.cache.get(k)
    if (entry) {
      if (entry.expiresAt > Date.now()) {
        // LRU bump: move to end of insertion order.
        this.cache.delete(k)
        this.cache.set(k, entry)
        return entry.snapshot
      }
      // Expired — drop it and fall through to backing.
      this.cache.delete(k)
    }
    const fresh = await this.backing.get(sid, name)
    if (fresh !== null) {
      this.populate(k, fresh, this.memoryTtlMs)
    }
    return fresh
  }

  async set(
    sid: string,
    name: string,
    snapshot: unknown,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    // Write-through: backing first so durability matches its semantics
    // even if the process crashes mid-set.
    await this.backing.set(sid, name, snapshot, opts)
    const backingTtlMs = opts?.ttlSeconds != null ? opts.ttlSeconds * 1000 : Infinity
    this.populate(this.key(sid, name), snapshot, Math.min(this.memoryTtlMs, backingTtlMs))
  }

  async has(sid: string, name: string): Promise<boolean> {
    const entry = this.cache.get(this.key(sid, name))
    if (entry && entry.expiresAt > Date.now()) return true
    return this.backing.has(sid, name)
  }

  async deleteSession(sid: string): Promise<void> {
    const prefix = `${sid}:`
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix)) this.cache.delete(k)
    }
    await this.backing.deleteSession(sid)
  }

  async renameSession(oldSid: string, newSid: string): Promise<void> {
    // Drop (don't move) cache entries — the next read repopulates from the
    // backing under the new id. Simpler than key surgery, and rotation is
    // rare (login/logout).
    const prefix = `${oldSid}:`
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix)) this.cache.delete(k)
    }
    if (!this.backing.renameSession) {
      throw new Error('stator: CachedStore backing store does not support renameSession')
    }
    await this.backing.renameSession(oldSid, newSid)
  }

  /** Insert / refresh an entry at LRU-end and evict oldest if over capacity. */
  private populate(key: string, snapshot: unknown, ttlMs: number): void {
    this.cache.delete(key)
    this.cache.set(key, { snapshot, expiresAt: Date.now() + ttlMs })
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      this.cache.delete(oldest)
    }
  }

  /** Diagnostic: current cached entry count. */
  get size(): number {
    return this.cache.size
  }
}
