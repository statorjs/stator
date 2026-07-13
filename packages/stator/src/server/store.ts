/**
 * Persistence boundary for session-scoped machine state. Stored values are
 * XState v5 *persisted snapshots* — serializable blobs containing the state
 * name plus context, recoverable via `createActor(machine, { snapshot })`.
 *
 * The framework treats stored values as opaque JSON. App-lifecycle machine
 * state is held in process (not persisted by this layer).
 *
 * ## TTL semantics — per-session, not per-entry
 *
 * `ttlSeconds` on `set` refreshes the **whole session's** expiry, not just
 * the entry being written. If CartMachine is stored at T+0 and CheckoutMachine
 * is stored at T+6h (both with ttlSeconds=86400), both expire at T+30h, not
 * T+24h and T+30h respectively. Adapters MUST honor this — the session is
 * the TTL unit, machines within a session are not independent.
 *
 * Rationale: a user actively interacting with one machine (checkout) is also
 * an active session for their other machines (cart) by definition. Splitting
 * TTL per-machine would drop carts under users mid-checkout. Sessions
 * expire as a whole when fully idle.
 */
export interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(
    sessionId: string,
    machineName: string,
    snapshot: unknown,
    opts?: { ttlSeconds?: number },
  ): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
  /** Move EVERY machine snapshot from one session id to another (used by
   *  session rotation on privilege change). Optional for custom adapters;
   *  rotation fails loudly when the configured store lacks it. */
  renameSession?(oldSessionId: string, newSessionId: string): Promise<void>
}

/**
 * In-memory implementation. Lazy-expiry: nothing is swept proactively, but
 * any read of an expired session returns null and drops the session's data.
 * Per-session expiry is tracked separately from the data map.
 */
export class InMemoryStore implements Store {
  private data = new Map<string, Map<string, unknown>>()
  private expiryAt = new Map<string, number>() // sessionId → epoch ms

  private isExpired(sid: string): boolean {
    const at = this.expiryAt.get(sid)
    return at !== undefined && at <= Date.now()
  }

  private dropSession(sid: string): void {
    this.data.delete(sid)
    this.expiryAt.delete(sid)
  }

  async get(sid: string, name: string): Promise<unknown | null> {
    if (this.isExpired(sid)) {
      this.dropSession(sid)
      return null
    }
    return this.data.get(sid)?.get(name) ?? null
  }

  async set(
    sid: string,
    name: string,
    snapshot: unknown,
    opts?: { ttlSeconds?: number },
  ): Promise<void> {
    // Drop any stale data before writing — set() against an expired session
    // is effectively a fresh session.
    if (this.isExpired(sid)) this.dropSession(sid)

    let session = this.data.get(sid)
    if (!session) {
      session = new Map()
      this.data.set(sid, session)
    }
    session.set(name, snapshot)

    if (opts?.ttlSeconds) {
      // Refresh the whole session's expiry, not just this entry's.
      this.expiryAt.set(sid, Date.now() + opts.ttlSeconds * 1000)
    }
  }

  async has(sid: string, name: string): Promise<boolean> {
    if (this.isExpired(sid)) {
      this.dropSession(sid)
      return false
    }
    return this.data.get(sid)?.has(name) ?? false
  }

  async deleteSession(sid: string): Promise<void> {
    this.dropSession(sid)
  }

  async renameSession(oldSid: string, newSid: string): Promise<void> {
    if (this.isExpired(oldSid)) {
      this.dropSession(oldSid)
      return
    }
    const session = this.data.get(oldSid)
    const expiry = this.expiryAt.get(oldSid)
    this.dropSession(oldSid)
    if (session) this.data.set(newSid, session)
    if (expiry !== undefined) this.expiryAt.set(newSid, expiry)
  }
}
