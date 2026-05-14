/**
 * Persistence boundary for session-scoped machine state. Stored values are
 * XState v5 *persisted snapshots* — serializable blobs containing the state
 * name plus context, recoverable via `createActor(machine, { snapshot })`.
 *
 * The framework treats stored values as opaque JSON. App-lifecycle machine
 * state is held in process (not persisted by this layer).
 */
export interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId: string, machineName: string, snapshot: unknown): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
}

/**
 * In-memory implementation. Process-lifetime. Drop-in adapter target for
 * Redis / KV / Postgres at V1. The framework never relies on synchrony,
 * but all interface methods are async so the call sites are adapter-shape.
 */
export class InMemoryStore implements Store {
  private data = new Map<string, Map<string, unknown>>()

  async get(sid: string, name: string): Promise<unknown | null> {
    return this.data.get(sid)?.get(name) ?? null
  }

  async set(sid: string, name: string, snapshot: unknown): Promise<void> {
    let session = this.data.get(sid)
    if (!session) {
      session = new Map()
      this.data.set(sid, session)
    }
    session.set(name, snapshot)
  }

  async has(sid: string, name: string): Promise<boolean> {
    return this.data.get(sid)?.has(name) ?? false
  }

  async deleteSession(sid: string): Promise<void> {
    this.data.delete(sid)
  }
}
