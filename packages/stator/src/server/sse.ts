import type { Patch } from '../wire/index.ts'
import { scopedLogger } from './logger.ts'
import { recompute } from './recompute.ts'
import type { RenderState } from './render-context.ts'
import type { RouteDefinition, RouteRequest } from './routing.ts'
import type { SessionRuntime } from './session-runtime.ts'

const sseLog = scopedLogger('sse')

/**
 * One open SSE connection. Lifetime equals the underlying TCP connection.
 * The runtime stays alive for the connection's duration — this is the one
 * place per-session state outlives a single request, because the
 * connection *is* a single (very long) request.
 *
 * `renderState` carries the slot bindings + `lastValue` baseline that
 * recompute will diff against when fan-out fires. Each push updates
 * `lastValue` for the bindings touched by the push, so subsequent pushes
 * only emit deltas.
 */
export interface Connection {
  id: string
  sessionId: string
  /** The browser page-load identity (client-generated). Lets fan-out
   *  recognize a dispatch's OWN connection: its baseline is advanced but
   *  nothing is sent — the POST response already delivered those patches. */
  clientId?: string
  routeKey: string
  route: RouteDefinition
  /** URL-derived state for this specific connection. Stored at connection
   *  open and reused by every fan-out recompute. Parameterized routes
   *  carry the resolved path params here (`/p/:id` connection knows its
   *  specific id). */
  request: RouteRequest
  runtime: SessionRuntime
  renderState: RenderState
  send: (data: string) => Promise<void>
  closed: boolean
}

const connections = new Map<string, Connection>()
let nextId = 0

export function registerConnection(init: Omit<Connection, 'id' | 'closed'>): Connection {
  const id = `sse${nextId++}`
  const conn: Connection = { ...init, id, closed: false }
  connections.set(id, conn)
  sseLog.info(
    { id, sid: conn.sessionId, route: conn.routeKey, total: connections.size },
    'connection opened',
  )
  return conn
}

export function unregisterConnection(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  conn.closed = true
  conn.runtime.dispose()
  connections.delete(id)
  sseLog.info(
    { id, sid: conn.sessionId, route: conn.routeKey, total: connections.size },
    'connection closed',
  )
}

export function activeConnectionCount(): number {
  return connections.size
}

/**
 * After a state-changing dispatch settles, iterate every open connection
 * whose route's `reads:` intersects `touched`, recompute against that
 * connection's slot map, and push any resulting patches over its event
 * stream. Recompute mutates the connection's `renderState.lastValue`s so
 * the next push is correctly diffed.
 *
 * Connections from any session receive pushes — that's the point: an
 * admin tab on session C sees updates triggered by session A's POSTs.
 */
export async function fanOut(
  touched: ReadonlySet<string>,
  source?: { sessionId?: string; originClientId?: string },
): Promise<void> {
  if (touched.size === 0 || connections.size === 0) return

  let pushedCount = 0
  let skippedNoIntersect = 0
  let skippedNoPatches = 0
  let skippedOriginator = 0
  let failed = 0

  // Expand through the reverse-reads graph once per fan-out: machines whose
  // SELECTORS derive from a touched machine must re-diff even though their
  // own state didn't move. (Every connection shares the one MachineStore.)
  const first = connections.values().next().value
  const { all: expandedTouched, derived } = first
    ? first.runtime.store.expandTouchedForRecompute(touched)
    : { all: new Set(touched), derived: new Set<string>() }

  for (const conn of connections.values()) {
    if (conn.closed) continue

    // Applicability per machine, judged against the connection's actual
    // bindings (byMachine covers transitive reads, not just declared seeds):
    //   - app machines: every connection (the shared instance IS the state).
    //   - DIRECTLY-touched session machines: only the touching session's own
    //     connections — and the connection's long-lived runtime must
    //     REHYDRATE them from the Store first, because the mutation happened
    //     in another runtime and this one's actor is frozen at connect time.
    //   - DERIVED session machines (expansion only): every connection that
    //     binds them, any session, no rehydration — their own state didn't
    //     change; their selectors' dependencies did.
    const applicable: string[] = []
    for (const name of expandedTouched) {
      if (!conn.renderState.byMachine.has(name)) continue
      if (conn.runtime.lifecycleOf(name) === 'session' && !derived.has(name)) {
        if (source?.sessionId === undefined || source.sessionId !== conn.sessionId) continue
        await conn.runtime.rehydrate(name)
      }
      applicable.push(name)
    }
    if (applicable.length === 0) {
      skippedNoIntersect++
      continue
    }

    const patches: Patch[] = []
    for (const name of applicable) {
      patches.push(...recompute(conn.renderState, name, conn.runtime))
    }
    if (patches.length === 0) {
      skippedNoPatches++
      continue
    }

    // The dispatching page's own connection: the POST response already
    // delivered this diff. The recompute above advanced the baseline (so the
    // NEXT push diffs correctly); sending would double-apply — and keyed
    // insert/remove/move ops are not idempotent.
    if (
      source?.originClientId !== undefined &&
      conn.clientId !== undefined &&
      conn.clientId === source.originClientId
    ) {
      skippedOriginator++
      continue
    }

    try {
      await conn.send(JSON.stringify({ patches }))
      pushedCount++
    } catch (err) {
      // Bumped from debug to warn — silent push failures were why "30-50%
      // delivery" was invisible in production logs.
      failed++
      sseLog.warn({ id: conn.id, sid: conn.sessionId, err: String(err) }, 'sse push failed')
    }
  }

  // Log every fan-out at info so the user can see touched-machines flow and
  // correlate against client-side inspector entries.
  sseLog.info(
    {
      touched: [...touched],
      total: connections.size,
      pushed: pushedCount,
      skippedNoIntersect,
      skippedNoPatches,
      skippedOriginator,
      failed,
    },
    'fan-out',
  )
}
