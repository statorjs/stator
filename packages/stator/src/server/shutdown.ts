import { scopedLogger } from './logger.ts'
import { closeLiveConnections } from './sse.ts'

const log = scopedLogger('shutdown')

/**
 * Draining a Stator process, which is not the same as closing its server.
 *
 * `server.close()` stops accepting new connections and then resolves only when
 * every existing connection has ended — so it can never be the gate for an app
 * with live routes: an SSE response is a single request that lasts as long as
 * the page is open. Waiting on it means the process hangs until the platform
 * loses patience (systemd `TimeoutStopSec`, Kubernetes
 * `terminationGracePeriodSeconds`, `docker stop`) and SIGKILLs it, turning an
 * ordinary deploy rollover into a 90-second failed stop.
 *
 * So long-lived streams are HUNG UP, never waited on — the same conclusion Go's
 * `http.Server.Shutdown` documents ("does not attempt to close nor wait for
 * hijacked connections... the caller should separately notify such long-lived
 * connections") and every Node graceful-shutdown library reaches. The deadline
 * that remains covers real request work, which is why it is short by default.
 *
 * Dropping a live channel costs a re-render, not a fact: session state is in the
 * Store, `after` timers re-arm on hydration, and a reconnecting page re-syncs
 * from the server's baseline (or reloads, if it comes back to a newer build via
 * the build-id handshake).
 */

/** Deadline for in-flight request work once the streams are hung up. Short on
 *  purpose: closing live connections is immediate, so this only ever covers
 *  real requests, and it must stay well under the platform's own kill grace
 *  (`docker stop` allows 10s). */
const DEFAULT_TIMEOUT_MS = 5_000

/** `STATOR_SHUTDOWN_TIMEOUT_MS`, or the default. An unparseable value warns and
 *  falls back rather than shortening the drain to zero. */
export function shutdownTimeoutMs(): number {
  const raw = process.env.STATOR_SHUTDOWN_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) {
    log.warn({ value: raw }, 'ignoring invalid STATOR_SHUTDOWN_TIMEOUT_MS')
    return DEFAULT_TIMEOUT_MS
  }
  return ms
}

/** What the drain needs of a listening server — structurally satisfied by
 *  `node:http`'s `Server` and by `@hono/node-server`'s `serve()` return.
 *  `closeIdleConnections`/`closeAllConnections` are Node ≥18.2; optional so a
 *  non-http server (or a test double) still drains. */
export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

export interface DrainResult {
  /** Live (SSE) connections hung up by the drain. */
  connections: number
  /** True when the deadline expired and the remaining sockets were destroyed. */
  forced: boolean
}

/**
 * Stop accepting, tear down inbound sources, hang up live connections, and wait
 * for in-flight requests up to a deadline — then destroy whatever is left.
 * Never exits the process: the signal handler owns that, and tests own this.
 */
export async function drainAndClose(
  server: ClosableServer,
  opts: { teardown?: () => Promise<void> | void; timeoutMs?: number } = {},
): Promise<DrainResult> {
  const timeoutMs = opts.timeoutMs ?? shutdownTimeoutMs()

  // Stop accepting FIRST, so nothing new arrives while sources are torn down.
  const closed = new Promise<void>((done) => server.close(() => done()))

  let connections = 0
  const drain = (async () => {
    // Inbound sources off before the streams they feed: a boot.ts poll or
    // subscription can raise events, and a dev watcher can rebuild, so both
    // stop before anything is hung up. A teardown that throws must not keep the
    // sockets open — log it and carry on closing.
    if (opts.teardown) {
      try {
        await opts.teardown()
      } catch (err) {
        log.warn({ err: String(err) }, 'teardown failed during shutdown')
      }
    }
    // The reason close() can complete at all.
    connections = closeLiveConnections()
    // Then reap keep-alive sockets parked between requests — on a tick, not
    // once. A hung-up stream's socket only becomes idle a moment later, and
    // until something closes it, `close()` stays pending for as long as the
    // CLIENT's keep-alive timeout (undici's is 4s) — measured, and the whole
    // reason a one-shot call here isn't enough. A socket with a request in
    // flight is never idle, so this never cuts real work short.
    server.closeIdleConnections?.()
    const reaper = setInterval(() => server.closeIdleConnections?.(), 50)
    reaper.unref?.()
    try {
      await closed
    } finally {
      clearInterval(reaper)
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => done('timeout'), timeoutMs)
    timer.unref?.()
  })
  const outcome = await Promise.race([drain.then(() => 'drained' as const), expired])
  clearTimeout(timer)

  if (outcome === 'timeout') {
    // Real request work (or a wedged teardown) outlasted the deadline. Destroy
    // what's left rather than hand the process to the platform's SIGKILL.
    server.closeAllConnections?.()
    log.warn({ timeoutMs }, 'shutdown deadline expired — remaining connections destroyed')
    return { connections, forced: true }
  }
  log.debug({ connections }, 'drained')
  return { connections, forced: false }
}
