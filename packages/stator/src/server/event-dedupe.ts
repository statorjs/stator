/**
 * In-process replay cache for `/__events` idempotency keys. A retried POST
 * whose first attempt committed (but whose response was lost on the wire)
 * must not re-apply — keyed-list patches are positional and not idempotent —
 * so the exact response body is cached per (session, eventId) and replayed
 * verbatim on a duplicate.
 *
 * Module-level and in-process, like the SSE connection registry and timers:
 * single-replica is a stated 1.0 constraint, and the cache carries the same
 * non-durable contract (a restart forgets it — the retry window is seconds,
 * the cost of a lost entry is one duplicate apply, and durable delivery is
 * 1.x inbox work).
 */

/** Ample for the retry window (client retries at ~0.3s/1s); bounds memory. */
const MAX_PER_SESSION = 32
const SESSION_IDLE_MS = 30 * 60_000

interface SessionCache {
  /** eventId → serialized response body, insertion-ordered for eviction. */
  byId: Map<string, string>
  lastTouched: number
}

const sessions = new Map<string, SessionCache>()

export function replayFor(sessionId: string, eventId: string): string | undefined {
  const cache = sessions.get(sessionId)
  if (!cache) return undefined
  cache.lastTouched = Date.now()
  return cache.byId.get(eventId)
}

export function record(sessionId: string, eventId: string, body: string): void {
  let cache = sessions.get(sessionId)
  if (!cache) {
    sweepIdle()
    cache = { byId: new Map(), lastTouched: 0 }
    sessions.set(sessionId, cache)
  }
  cache.lastTouched = Date.now()
  cache.byId.set(eventId, body)
  if (cache.byId.size > MAX_PER_SESSION) {
    const oldest = cache.byId.keys().next().value
    if (oldest !== undefined) cache.byId.delete(oldest)
  }
}

function sweepIdle(): void {
  const cutoff = Date.now() - SESSION_IDLE_MS
  for (const [id, cache] of sessions) {
    if (cache.lastTouched < cutoff) sessions.delete(id)
  }
}
