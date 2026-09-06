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
 *
 * Writes never happen inline. Everything outbound — fan-out patches, the
 * initial sync, the heartbeat, the dev broadcast — goes through `enqueue`,
 * and one drain loop per connection owns the socket. A request or a lock is
 * therefore never held across a socket write, and per-connection order is a
 * property of the queue rather than of who awaited what.
 */
export interface Connection {
  id: string
  sessionId: string
  /** The browser page-load identity (client-generated). Lets fan-out
   *  recognize a dispatch's OWN connection: its baseline is advanced and,
   *  when nothing is queued for it, nothing is sent — the POST response
   *  delivers those patches. With a backlog they ride the queue instead, so
   *  the two channels cannot reorder a positional list op. */
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
  /** Tear the underlying stream down from the server side. Supplied by the
   *  transport; absent in tests that register a bare connection. */
  close?: () => void
  closed: boolean
  /** Outbound writes waiting for the drain loop, oldest first. */
  queue: string[]
  /** Bytes waiting in `queue`. The item being written is not counted. */
  queuedBytes: number
  /** True while the drain loop owns the socket — an item is in flight. */
  draining: boolean
}

type ConnectionInit = Omit<Connection, 'id' | 'closed' | 'queue' | 'queuedBytes' | 'draining'>

const connections = new Map<string, Connection>()
let nextId = 0

export function registerConnection(init: ConnectionInit): Connection {
  const id = `sse${nextId++}`
  const conn: Connection = {
    ...init,
    id,
    closed: false,
    queue: [],
    queuedBytes: 0,
    draining: false,
  }
  // A page-load holds at most one channel per route, so an existing
  // connection with the same (clientId, routeKey) is a corpse whose abort we
  // never observed — a half-open socket, or a reconnect that raced its own
  // teardown. Left registered it would pin a SessionRuntime forever and take
  // a slice of every fan-out. Evict it before the new one lands.
  if (init.clientId !== undefined) {
    for (const prior of connections.values()) {
      if (prior.clientId === init.clientId && prior.routeKey === init.routeKey) {
        sseLog.debug(
          { id: prior.id, sid: prior.sessionId, route: prior.routeKey, replacedBy: id },
          'evicting superseded connection',
        )
        unregisterConnection(prior.id)
        prior.close?.()
      }
    }
  }
  connections.set(id, conn)
  sseLog.debug(
    { id, sid: conn.sessionId, route: conn.routeKey, total: connections.size },
    'connection opened',
  )
  return conn
}

/**
 * Queue a pre-serialized envelope for every open connection, bypassing the
 * recompute path. The dev server's rebuild/error signals ride this so a dev
 * page holds ONE event-stream instead of two — see `dev-native.ts`. Not a
 * fan-out: no diffing, no baseline advance, no per-connection filtering.
 */
export function broadcastEnvelope(payload: unknown): void {
  if (connections.size === 0) return
  const data = JSON.stringify(payload)
  for (const conn of connections.values()) {
    if (!conn.closed) enqueue(conn, data)
  }
}

export function unregisterConnection(id: string): void {
  const conn = connections.get(id)
  if (!conn) return
  conn.closed = true
  // Whatever was waiting is discarded with the socket: the client reconnects
  // and resyncs. The drain loop, if mid-write, sees `closed` and exits.
  conn.queue.length = 0
  conn.queuedBytes = 0
  conn.runtime.dispose()
  connections.delete(id)
  sseLog.debug(
    { id, sid: conn.sessionId, route: conn.routeKey, total: connections.size },
    'connection closed',
  )
}

export function activeConnectionCount(): number {
  return connections.size
}

/** How long one write to one connection may take before the connection is
 *  treated as dead. `STATOR_SSE_WRITE_TIMEOUT_MS` overrides it. */
const DEFAULT_WRITE_TIMEOUT_MS = 5_000

function writeTimeoutMs(): number {
  const raw = process.env.STATOR_SSE_WRITE_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_WRITE_TIMEOUT_MS
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_WRITE_TIMEOUT_MS
}

/** Bytes a connection may hold WAITING behind an in-flight write before it is
 *  treated as dead. The item being written is covered by the write deadline,
 *  not by this, and a single waiting item never trips it however large — an
 *  initial sync of a big table is one item. `STATOR_SSE_QUEUE_MAX_BYTES`
 *  overrides it. */
const DEFAULT_QUEUE_MAX_BYTES = 1_048_576

function queueMaxBytes(): number {
  const raw = process.env.STATOR_SSE_QUEUE_MAX_BYTES
  if (raw === undefined || raw === '') return DEFAULT_QUEUE_MAX_BYTES
  const bytes = Number(raw)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_QUEUE_MAX_BYTES
}

/** Whether anything is queued or in flight for this connection. */
export function hasBacklog(conn: Connection): boolean {
  return conn.draining || conn.queue.length > 0
}

/**
 * Queue one envelope for a connection and return at once. The drain loop
 * writes it when everything ahead of it has been written, so order per
 * connection is FIFO by construction. Overflow drops the connection, the
 * same policy as a write that times out: the client reconnects and resyncs.
 */
export function enqueue(conn: Connection, data: string): void {
  if (conn.closed) return
  conn.queue.push(data)
  conn.queuedBytes += Buffer.byteLength(data)
  if (conn.queue.length > 1 && conn.queuedBytes > queueMaxBytes()) {
    sseLog.warn(
      {
        id: conn.id,
        sid: conn.sessionId,
        route: conn.routeKey,
        waiting: conn.queue.length,
        bytes: conn.queuedBytes,
        max: queueMaxBytes(),
      },
      'sse queue overflowed — dropping the connection',
    )
    unregisterConnection(conn.id)
    conn.close?.()
    return
  }
  if (!conn.draining) void drain(conn)
}

/** The one writer per connection. Runs until the queue is empty or the
 *  connection closes under it (a timed-out write, an overflow, an abort). */
async function drain(conn: Connection): Promise<void> {
  conn.draining = true
  try {
    while (!conn.closed && conn.queue.length > 0) {
      const data = conn.queue.shift()!
      conn.queuedBytes -= Buffer.byteLength(data)
      await pushToConnection(conn, data)
    }
  } finally {
    conn.draining = false
  }
}

/**
 * Write one envelope to one connection, bounded. The drain loop's single
 * write; nothing else touches the socket.
 *
 * A write to a live socket resolves; a write to a closed one rejects. A write
 * to a HALF-OPEN one does neither once its buffer is full — when a remote
 * laptop sleeps or a NAT drops the mapping, no FIN ever arrives, the socket
 * still looks writable, and the promise simply never settles. Fan-out used to
 * await these serially with no deadline, so one such connection stalled the
 * loop and every connection registered after it received nothing until the
 * kernel gave up on the socket (minutes) or the same page reconnected and
 * evicted it. Under the session lock the same stall ran into the lock's 30s
 * backstop, failing the dispatching request each time.
 *
 * On a timeout the connection is dropped rather than retried: the client
 * reconnects and gets a full resync, which is cheap by design. Note what the
 * deadline measures: a write to a socket with buffer space resolves at once
 * regardless of the peer, so this fires only when the buffer has stayed full
 * for the whole window — not on a merely slow client. And because the clock
 * starts when the drain loop issues the write, not when the item was queued,
 * a burst behind a slow but healthy socket cannot trip it.
 */
export async function pushToConnection(conn: Connection, data: string): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race<Outcome>([
      conn.send(data).then((): Outcome => 'sent'),
      new Promise<Outcome>((settle) => {
        timer = setTimeout(() => settle('timeout'), writeTimeoutMs())
        timer.unref?.()
      }),
    ])
    if (outcome === 'timeout') {
      sseLog.warn(
        { id: conn.id, sid: conn.sessionId, route: conn.routeKey, ms: writeTimeoutMs() },
        'sse write timed out — dropping the connection',
      )
      unregisterConnection(conn.id)
      conn.close?.()
    }
    return outcome
  } catch (err) {
    // Bumped from debug to warn — silent push failures were why "30-50%
    // delivery" was invisible in production logs.
    sseLog.warn({ id: conn.id, sid: conn.sessionId, err: String(err) }, 'sse push failed')
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

type Outcome = 'sent' | 'timeout' | 'failed'

/**
 * Hang up every open connection — the shutdown path. A live response never ends
 * on its own, so `server.close()` cannot complete until these do; see
 * `shutdown.ts` for why they are closed rather than waited on. Returns how many
 * were open. Each handler's own `finally` unregisters again, harmlessly.
 */
export function closeLiveConnections(): number {
  const open = [...connections.values()]
  for (const conn of open) {
    unregisterConnection(conn.id)
    conn.close?.()
  }
  return open.length
}

/**
 * After a state-changing dispatch settles, iterate every open connection
 * whose route's `reads:` intersects `touched`, recompute against that
 * connection's slot map, and queue any resulting patches on its event
 * stream. Recompute mutates the connection's `renderState.lastValue`s so
 * the next push is correctly diffed. Returns as soon as everything is
 * queued: no socket is awaited here, so a dispatch never waits on another
 * page's network.
 *
 * Connections from any session receive pushes — that's the point: an
 * admin tab on session C sees updates triggered by session A's POSTs.
 *
 * `originatorQueued` tells the dispatch path whether the acting page's own
 * patches were queued on its channel (because it already had a backlog)
 * rather than left to the POST response. When true, the response must carry
 * none, or the same positional list op lands twice.
 */
export async function fanOut(
  touched: ReadonlySet<string>,
  source?: { sessionId?: string; originClientId?: string },
): Promise<{ originatorQueued: boolean }> {
  if (touched.size === 0 || connections.size === 0) return { originatorQueued: false }

  let enqueued = 0
  let skippedNoIntersect = 0
  let skippedNoPatches = 0
  let skippedOriginator = 0
  let originatorQueued = false

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

    // The dispatching page's own connection. With nothing queued for it, the
    // POST response delivers this diff: the recompute above advanced the
    // baseline (so the NEXT push diffs correctly) and sending would
    // double-apply — keyed insert/remove/move ops are not idempotent. With a
    // backlog, the response would overtake what is still queued, and a
    // positional op applied out of order corrupts a list rather than merely
    // staling it — so the diff rides the queue and the response carries none.
    const isOriginator =
      source?.originClientId !== undefined &&
      conn.clientId !== undefined &&
      conn.clientId === source.originClientId
    if (isOriginator) {
      if (!hasBacklog(conn)) {
        skippedOriginator++
        continue
      }
      originatorQueued = true
    }

    enqueue(conn, JSON.stringify({ patches }))
    enqueued++
  }

  // Log every fan-out at debug so the user can see touched-machines flow and
  // correlate against client-side inspector entries — noisy for prod, so
  // debug. Write outcomes are logged by the drain loop as they happen.
  sseLog.debug(
    {
      touched: [...touched],
      total: connections.size,
      enqueued,
      skippedNoIntersect,
      skippedNoPatches,
      skippedOriginator,
      originatorQueued,
    },
    'fan-out',
  )
  return { originatorQueued }
}
