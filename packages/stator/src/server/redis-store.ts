import Redis, { type RedisOptions } from 'ioredis'
import type { AppStore } from './app-store.ts'
import type { Store } from './store.ts'

/**
 * Redis-backed Store. One hash per session, machine names as fields:
 *
 *   stator:session:<sid>          (hash)
 *     CartMachine        → JSON snapshot
 *     CheckoutMachine    → JSON snapshot
 *
 * TTL is per-session: HSET + EXPIRE are pipelined on every set, so the
 * whole hash's expiry refreshes every time the user interacts with any of
 * their machines. Idle sessions expire as a unit; active users never see
 * a machine's state drop while other machines stay alive.
 *
 * Works with Upstash, Fly Redis, hosted Redis Cloud, or any redis:// /
 * rediss:// URL — ioredis handles TLS automatically when the scheme is
 * rediss://. Pass the URL directly or a fully-formed RedisOptions object.
 */
export class RedisStore implements Store {
  private client: Redis
  private keyPrefix: string

  constructor(connection: string | RedisOptions, keyPrefix = 'stator:session') {
    this.client = typeof connection === 'string' ? new Redis(connection) : new Redis(connection)
    this.keyPrefix = keyPrefix
  }

  private key(sid: string): string {
    return `${this.keyPrefix}:${sid}`
  }

  async get(sid: string, name: string): Promise<unknown | null> {
    const raw = await this.client.hget(this.key(sid), name)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      // Corrupted entry — treat as missing rather than crash. Logged
      // upstream if the caller cares.
      return null
    }
  }

  async set(
    sid: string,
    name: string,
    snapshot: unknown,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    const key = this.key(sid)
    const payload = JSON.stringify(snapshot)
    if (opts?.ttlSeconds) {
      // Pipeline HSET + EXPIRE so the whole hash's TTL refreshes atomically.
      // Any field write extends the session's idle window — see Store
      // interface docs for the per-session TTL semantic.
      await this.client.multi().hset(key, name, payload).expire(key, opts.ttlSeconds).exec()
    } else {
      await this.client.hset(key, name, payload)
    }
  }

  async has(sid: string, name: string): Promise<boolean> {
    return (await this.client.hexists(this.key(sid), name)) === 1
  }

  async deleteSession(sid: string): Promise<void> {
    await this.client.del(this.key(sid))
  }

  async renameSession(oldSid: string, newSid: string): Promise<void> {
    // RENAME is atomic and carries the hash's TTL; it throws when the source
    // is missing (an empty session has nothing to move — fine).
    if ((await this.client.exists(this.key(oldSid))) === 1) {
      await this.client.rename(this.key(oldSid), this.key(newSid))
    }
  }

  /** Close the connection. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.client.quit()
  }

  /** Underlying ioredis client, exposed for health checks / introspection. */
  get raw(): Redis {
    return this.client
  }
}

/**
 * Redis-backed AppStore: one plain key per app machine name, JSON snapshot,
 * NO TTL — app state is process-equivalent persistence (see app-store.ts).
 * Single-writer assumption; multi-replica coordination is out of scope.
 */
export class RedisAppStore implements AppStore {
  private client: Redis
  private keyPrefix: string

  constructor(connection: string | RedisOptions, keyPrefix = 'stator:app') {
    this.client = typeof connection === 'string' ? new Redis(connection) : new Redis(connection)
    this.keyPrefix = keyPrefix
  }

  async loadAppMachine(name: string): Promise<unknown | null> {
    const raw = await this.client.get(`${this.keyPrefix}:${name}`)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      // Corrupted blob — treat as missing; the boot path logs and starts fresh.
      return null
    }
  }

  async saveAppMachine(name: string, snapshot: unknown): Promise<void> {
    await this.client.set(`${this.keyPrefix}:${name}`, JSON.stringify(snapshot))
  }

  /** Close the connection. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.client.quit()
  }
}
