/**
 * Persistence boundary for APP-lifecycle machine state — a sibling of the
 * session `Store`, deliberately not a merger (see the app-machine-state-
 * persistence spec): app state is one blob per machine name, has NO TTL
 * (process-equivalent persistence, not user-session storage), and no
 * per-session sharding key.
 *
 * Opt-in per machine via `persist: true` in `defineMachine` — some app
 * machines genuinely should reset on restart (caches, connection pools).
 *
 * Single-writer assumption: two replicas both persisting the same app
 * machine will drift. Multi-replica coordination is out of scope for 1.x —
 * see the spec's open questions.
 */
export interface AppStore {
  loadAppMachine(name: string): Promise<unknown | null>
  saveAppMachine(name: string, snapshot: unknown): Promise<void>
}

/** Process-memory implementation — same restart-wipe semantics as no
 *  persistence at all; exists so the interface is uniform and tests are
 *  trivial. */
export class InMemoryAppStore implements AppStore {
  private data = new Map<string, unknown>()

  async loadAppMachine(name: string): Promise<unknown | null> {
    return this.data.has(name) ? this.data.get(name)! : null
  }

  async saveAppMachine(name: string, snapshot: unknown): Promise<void> {
    // Clone through JSON so callers can't mutate stored state by reference —
    // and so anything non-serializable fails here, not in a Redis swap later.
    this.data.set(name, JSON.parse(JSON.stringify(snapshot)))
  }
}
