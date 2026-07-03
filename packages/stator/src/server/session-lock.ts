/**
 * Per-session async lock, shared by every state-mutating entry point —
 * `POST /__events` (http.ts) and API-route handlers (api-route.ts).
 *
 * Serializes each session's load → mutate → persist cycle so concurrent
 * mutations can't interleave and lose writes, *regardless of which path they
 * arrive through*. The map must be process-wide and single: two entry points
 * holding separate maps would each serialize against themselves but not
 * against each other, letting an /__events POST and an API-route mutation on
 * the same session race.
 *
 * GETs are read-only and do not acquire the lock.
 */
const sessionLocks = new Map<string, Promise<unknown>>()

export function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sid) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  sessionLocks.set(sid, settled)
  void settled.then(() => {
    if (sessionLocks.get(sid) === settled) sessionLocks.delete(sid)
  })
  return next
}

/** Number of sessions with an in-flight or queued mutation (test/observability). */
export function activeSessionLockCount(): number {
  return sessionLocks.size
}
