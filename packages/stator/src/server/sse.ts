import { recompute, type Patch } from './recompute.ts'
import type { RenderState } from './render-context.ts'
import type { RouteDefinition } from './routing.ts'
import type { SessionRuntime } from './session-runtime.ts'

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
  routeKey: string
  route: RouteDefinition
  runtime: SessionRuntime
  renderState: RenderState
  send: (data: string) => Promise<void>
  closed: boolean
}

const connections = new Map<string, Connection>()
let nextId = 0

export function registerConnection(
  init: Omit<Connection, 'id' | 'closed'>,
): Connection {
  const id = `sse${nextId++}`
  const conn: Connection = { ...init, id, closed: false }
  connections.set(id, conn)
  return conn
}

export function unregisterConnection(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  conn.closed = true
  conn.runtime.dispose()
  connections.delete(id)
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
export async function fanOut(touched: ReadonlySet<string>): Promise<void> {
  if (touched.size === 0 || connections.size === 0) return

  for (const conn of connections.values()) {
    if (conn.closed) continue

    let intersects = false
    for (const read of conn.route.reads) {
      if (touched.has(read.name)) {
        intersects = true
        break
      }
    }
    if (!intersects) continue

    const patches: Patch[] = []
    for (const name of touched) {
      patches.push(...recompute(conn.renderState, name, conn.runtime))
    }
    if (patches.length === 0) continue

    try {
      await conn.send(JSON.stringify({ patches }))
    } catch {
      // Client gone; let the stream's close handler clean up.
    }
  }
}
