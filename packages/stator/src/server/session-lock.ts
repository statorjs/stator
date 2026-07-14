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
import { scopedLogger } from './logger.ts'

const lockLog = scopedLogger('session-lock')
const sessionLocks = new Map<string, Promise<unknown>>()

/** A single mutation that neither resolves nor rejects (a hung store I/O, a
 *  wedged effect) would otherwise pin the session's whole promise chain
 *  forever — every later mutation queues behind it with no recovery. This cap
 *  converts a hang into a rejection so the chain drains. The abandoned work may
 *  still complete in the background, so the timeout is generous (a real
 *  mutation is milliseconds); it's a wedge backstop, not a deadline. */
const LOCK_TIMEOUT_MS = 30_000

function withTimeout<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      lockLog.error({ sid, ms: LOCK_TIMEOUT_MS }, 'session lock timed out — mutation abandoned')
      reject(new Error(`stator: session "${sid}" lock held > ${LOCK_TIMEOUT_MS}ms — abandoned`))
    }, LOCK_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    Promise.resolve()
      .then(fn)
      .then(
        (v) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(e)
        },
      )
  })
}

export function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sid) ?? Promise.resolve()
  const run = () => withTimeout(sid, fn)
  const next = prev.then(run, run)
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
