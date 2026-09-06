import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { withDispatchContext } from '../src/server/dispatch-context.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { initialSyncPatches } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { defineRoute } from '../src/server/routing.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import {
  activeConnectionCount,
  enqueue,
  fanOut,
  hasBacklog,
  pushToConnection,
  registerConnection,
  unregisterConnection,
} from '../src/server/sse.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { each } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import Board from './fixtures/machines/board.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
}

async function cookieFor(app: StatorApp, path: string): Promise<string> {
  const res = await app.fetch(new Request(`http://localhost${path}`))
  return res.headers.get('set-cookie')!.split(';')[0]!
}

/** Open the SSE stream and return an accumulating reader. `close()` aborts
 *  the request (the real browser-disconnect path). */
async function openSse(app: StatorApp, routeKey: string, cookie: string, clientId?: string) {
  const abort = new AbortController()
  const client = clientId ? `&client=${encodeURIComponent(clientId)}` : ''
  const res = await app.fetch(
    new Request(`http://localhost/__sse?route=${encodeURIComponent(routeKey)}${client}`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    }),
  )
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // ONE persistent pump appends to the buffer; readUntil only polls it.
  // (Racing reader.read() against timers abandons reads, and a subsequent
  // overlapping read() throws — the old harness silently died that way.)
  let ended = false
  // `pause()` parks the pump before its next read, so the server's writes to
  // this stream back up behind the stream's own buffers — how a browser that
  // has stopped reading looks from the server.
  let paused: Promise<void> | null = null
  let unpause: (() => void) | null = null
  const pump = (async () => {
    try {
      while (true) {
        if (paused) await paused
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
      }
    } catch {
      // stream closed/aborted — fine
    }
    ended = true
  })()
  return {
    /** True once the response body has ended — i.e. the SERVER hung up. */
    get ended(): boolean {
      return ended
    },
    /** Poll until `predicate(buffer)` or timeout; returns the buffer. */
    async readUntil(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (!predicate(buffer) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      return buffer
    },
    pause() {
      if (!paused) {
        paused = new Promise<void>((r) => {
          unpause = r
        })
      }
    },
    resume() {
      unpause?.()
      paused = null
      unpause = null
    },
    close() {
      abort.abort()
      reader.cancel().catch(() => {})
      void pump
    },
  }
}

describe('SSE: /__sse endpoint validation', () => {
  it('rejects missing, malformed, unknown, and non-live route keys', async () => {
    const app = await boot()

    expect((await app.fetch(new Request('http://localhost/__sse'))).status).toBe(400)

    const malformed = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('POST /board')}`),
    )
    expect(malformed.status).toBe(400)

    const unknown = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /nope')}`),
    )
    expect(unknown.status).toBe(404)

    const notLive = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /ping')}`),
    )
    expect(notLive.status).toBe(400)
    expect(await notLive.text()).toContain('not declared live')
  })
})

describe('SSE: cross-session fan-out', () => {
  it('pushes patches to a live connection when another session touches the app machine', async () => {
    const app = await boot()
    const before = activeConnectionCount()

    // Session A renders the live board and opens its stream.
    const cookieA = await cookieFor(app, '/board')
    const sse = await openSse(app, 'GET /board', cookieA)
    try {
      await sse.readUntil((t) => t.includes(': open'))
      await vi.waitFor(() => expect(activeConnectionCount()).toBe(before + 1))

      // Session B (a different visitor) pings — the session machine emits,
      // BoardMachine (app) bumps, fan-out reaches A's connection.
      const cookieB = await cookieFor(app, '/ping')
      const post = await app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /ping',
            Cookie: cookieB,
          },
          body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
        }),
      )
      expect(post.status).toBe(200)

      // The first patches message is the connect-time initial sync; wait for
      // the ping's actual value to arrive.
      const received = await sse.readUntil((t) => /"value":"1"/.test(t))
      expect(received).toContain('"op":"text"')
      expect(received).toContain('"value":"1"')
    } finally {
      sse.close()
    }
    await vi.waitFor(() => expect(activeConnectionCount()).toBe(before))
  })

  it('initial sync converges a page that missed changes between render and connect', async () => {
    // The reported bug: page renders (state S0), an effect settles or another
    // session dispatches BEFORE the page's SSE connects (state S1) — the old
    // baseline-at-connect behavior made that delta permanently invisible and
    // the page hung on stale DOM.
    const app = await boot()
    const cookie = await cookieFor(app, '/board') // page rendered at S0 (count 0)

    await dispatchToApp(app.store, Board, { type: 'BUMP', by: 3 }) // the missed window

    const sse = await openSse(app, 'GET /board', cookie)
    try {
      const buf = await sse.readUntil((t) => t.includes('"patches"'))
      // The connect burst must carry the CURRENT value the page never saw.
      expect(buf).toContain('"value":"3"')
    } finally {
      sse.close()
    }
  })

  it('pushes server-originated dispatchToApp updates and diffs subsequent pushes', async () => {
    const app = await boot()
    const cookieA = await cookieFor(app, '/board')
    const sse = await openSse(app, 'GET /board', cookieA)
    try {
      await sse.readUntil((t) => t.includes(': open'))

      // Consume the connect-time initial sync first.
      await sse.readUntil((t) => t.includes('"patches"'))

      // The webhook/cron path: no HTTP request, no session.
      await dispatchToApp(app.store, Board, { type: 'BUMP', by: 5 })
      let buf = await sse.readUntil((t) => (t.match(/"patches"/g) ?? []).length >= 2)
      const firstValue = [...buf.matchAll(/"value":"(\d+)"/g)].at(-1)?.[1]

      await dispatchToApp(app.store, Board, { type: 'BUMP', by: 2 })
      buf = await sse.readUntil((t) => (t.match(/"patches"/g) ?? []).length >= 3)
      const values = [...buf.matchAll(/"value":"(\d+)"/g)].map((m) => Number(m[1]))

      // Two pushes, correctly diffed against the connection's own baseline:
      // the second reflects the accumulated total, not a reset.
      expect(values.at(-1)! - Number(firstValue)).toBe(2)
    } finally {
      sse.close()
    }
  })
})

describe('app.dispatchToApp method', () => {
  it('is the store-bound equivalent of dispatchToApp(store, …)', async () => {
    const app = await boot()
    const result = await app.dispatchToApp(Board, { type: 'BUMP', by: 1 })
    expect(result.committed).toBe(true)
  })
})

describe('SSE: fan-out unit behavior', () => {
  async function syntheticConnection(sendImpl: (data: string) => Promise<void>) {
    const Machine = defineMachine({
      name: 'PushMachine',
      lifecycle: 'session',
      events: {} as { type: 'INC' },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            INC: (ctx) => {
              ctx.n += 1
            },
          },
        },
      },
      selectors: { n: (ctx) => ctx.n },
    })
    const store = new MachineStore([Machine], new InMemoryStore())
    await store.bootAppMachines()
    const runtime = new SessionRuntime('sse-unit', store)
    await runtime.loadGraph([Machine])
    const proxy = runtime.proxyFor('PushMachine') as never
    const renderState = createRenderState('sse-unit', 'GET /synthetic')
    runInRender(
      renderState,
      () => html`<p>${read(proxy, (m) => (m as unknown as { n: number }).n)}</p>`,
    )
    const route = defineRoute({ reads: [Machine], live: true, render: () => html`<p></p>` })
    const conn = registerConnection({
      sessionId: 'sse-unit',
      routeKey: 'GET /synthetic',
      route,
      request: {} as never,
      runtime,
      renderState,
      send: sendImpl,
    })
    return { conn, runtime, Machine }
  }

  it('a reconnect resets a keyed list wholesale — rows removed while away are gone', async () => {
    // The dogfood hypothesis: a page that missed removals while its channel was
    // down keeps the dead rows, because the sync only carries rows that still
    // exist. It does not — the connect-time sync is ONE `html` reset per keyed
    // list, and the client clears the region before inserting it.
    type Row = { id: string; label: string }
    const List = defineMachine({
      name: 'IssueList',
      lifecycle: 'app',
      events: {} as { type: 'SET'; rows: Row[] },
      context: { rows: [] as Row[] },
      initial: 'idle',
      states: {
        idle: {
          on: {
            SET: (ctx, ev) => {
              ctx.rows = ev.rows
            },
          },
        },
      },
      selectors: { rows: (ctx) => ctx.rows },
    })
    const store = new MachineStore([List], new InMemoryStore())
    await store.bootAppMachines()
    const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, label: `row${id}` }))
    await dispatchToApp(store, List, { type: 'SET', rows: rows('1', '2', '3') })

    // What /__sse does on every connect: a fresh runtime, a render at connect
    // time, then the sync computed from that render.
    const connect = async () => {
      const runtime = new SessionRuntime('reconnect', store)
      await runtime.loadGraph([List])
      const proxy = runtime.proxyFor('IssueList') as never
      const state = createRenderState('reconnect', 'GET /issues')
      runInRender(
        state,
        () =>
          html`<ul>${each(
            read(proxy, (m) => (m as unknown as { rows: Row[] }).rows),
            (r: Row) => html`<li>${r.label}</li>`,
            { key: (r: Row) => r.id },
          )}</ul>`,
      )
      return { runtime, state }
    }

    // The page rendered and connected with three rows, then the channel died.
    const first = await connect()
    expect(first.state.bindings.size).toBeGreaterThan(0)
    first.runtime.dispose()

    // Two rows removed while the page was away.
    await dispatchToApp(store, List, { type: 'SET', rows: rows('2') })

    const second = await connect()
    try {
      const sync = initialSyncPatches(second.state, second.runtime)
      const resets = sync.filter((p) => p.op === 'html')
      expect(resets).toHaveLength(1)
      expect(resets[0]).toMatchObject({ op: 'html', value: '<li>row2</li>' })
      // Wholesale, never positional: a positional op assumes a DOM row set the
      // page cannot vouch for.
      const positional = sync.filter(
        (p) => p.op === 'insert' || p.op === 'remove' || p.op === 'move',
      )
      expect(positional).toHaveLength(0)
    } finally {
      second.runtime.dispose()
    }
  })

  it('a wedged write is bounded, and the connection is dropped', async () => {
    // A half-open socket — a sleeping remote laptop, a dropped NAT mapping —
    // never sends FIN, so once its buffer is full a write to it neither
    // resolves nor rejects. Every push goes through this path, and fan-out used
    // to await these serially with no deadline: one such connection stalled the
    // loop and every connection registered after it received nothing until the
    // kernel gave up on the socket, minutes later.
    process.env.STATOR_SSE_WRITE_TIMEOUT_MS = '250'
    try {
      const before = activeConnectionCount()
      const { conn } = await syntheticConnection(() => new Promise<void>(() => {}))

      const started = Date.now()
      const outcome = await pushToConnection(conn, '{"ping":true}')
      const elapsed = Date.now() - started

      expect(outcome).toBe('timeout')
      expect(elapsed).toBeLessThan(2000)
      // Dropped rather than retried: the client reconnects and gets a full
      // resync, which is cheap by design.
      expect(activeConnectionCount()).toBe(before)
      expect(conn.closed).toBe(true)
    } finally {
      delete process.env.STATOR_SSE_WRITE_TIMEOUT_MS
    }
  })

  it('a healthy write reports as sent and keeps the connection', async () => {
    const sent: string[] = []
    const { conn } = await syntheticConnection(async (d) => {
      sent.push(d)
    })
    try {
      expect(await pushToConnection(conn, '{"ping":true}')).toBe('sent')
      expect(sent).toEqual(['{"ping":true}'])
      expect(conn.closed).toBe(false)
    } finally {
      unregisterConnection(conn.id)
    }
  })

  /** An app-lifecycle machine, so one fan-out reaches every connection the
   *  test registers without the session rehydrate path. `bump` mutates the
   *  shared instance directly — not through dispatchToApp, whose own fan-out
   *  would get in the way of the one under test. */
  async function appFixture() {
    const Machine = defineMachine({
      name: 'QueueMachine',
      lifecycle: 'app',
      events: {} as { type: 'INC' },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            INC: (ctx) => {
              ctx.n += 1
            },
          },
        },
      },
      selectors: { n: (ctx) => ctx.n },
    })
    const store = new MachineStore([Machine], new InMemoryStore())
    await store.bootAppMachines()
    const bump = (): void => {
      const runtime = new SessionRuntime('bump', store)
      try {
        withDispatchContext({ runtime, touched: new Set() }, () => {
          store.appInstance('QueueMachine')!.actor.send({ type: 'INC' } as never)
        })
      } finally {
        runtime.dispose()
      }
    }
    const connect = async (send: (data: string) => Promise<void>, clientId?: string) => {
      const runtime = new SessionRuntime('sse-queue', store)
      await runtime.loadGraph([Machine])
      const proxy = runtime.proxyFor('QueueMachine') as never
      const renderState = createRenderState('sse-queue', 'GET /queue')
      runInRender(
        renderState,
        () => html`<p>${read(proxy, (m) => (m as unknown as { n: number }).n)}</p>`,
      )
      const route = defineRoute({ reads: [Machine], live: true, render: () => html`<p></p>` })
      return registerConnection({
        sessionId: 'sse-queue',
        clientId,
        routeKey: 'GET /queue',
        route,
        request: {} as never,
        runtime,
        renderState,
        send,
      })
    }
    const value = (envelope: string): string =>
      String((JSON.parse(envelope) as { patches: Array<{ value: string }> }).patches[0]?.value)
    return { bump, connect, value }
  }

  it('fan-out queues and returns: a wedged connection delays no one and is dropped behind them', async () => {
    process.env.STATOR_SSE_WRITE_TIMEOUT_MS = '250'
    const before = activeConnectionCount()
    const { bump, connect } = await appFixture()
    const wedged = await connect(() => new Promise<void>(() => {}))
    const sent: string[] = []
    const healthy = await connect(async (d) => {
      sent.push(d)
    })
    try {
      bump()
      const started = Date.now()
      await fanOut(new Set(['QueueMachine']))
      // The dispatch path never waits on a socket — not even the dead one.
      expect(Date.now() - started).toBeLessThan(200)
      expect(sent).toHaveLength(1)
      // The deadline still reaps it, off the request path.
      await vi.waitFor(() => expect(wedged.closed).toBe(true))
      expect(healthy.closed).toBe(false)
    } finally {
      unregisterConnection(healthy.id)
      unregisterConnection(wedged.id)
      delete process.env.STATOR_SSE_WRITE_TIMEOUT_MS
    }
    expect(activeConnectionCount()).toBe(before)
  })

  it('writes to one connection stay in order across back-to-back fan-outs', async () => {
    const { bump, connect, value } = await appFixture()
    const sent: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const conn = await connect(async (d) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 30))
      sent.push(d)
      inFlight--
    })
    try {
      bump()
      await fanOut(new Set(['QueueMachine']))
      bump()
      await fanOut(new Set(['QueueMachine']))
      // The second waits behind the first rather than racing it.
      expect(conn.queue).toHaveLength(1)
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(maxInFlight).toBe(1)
      expect(sent.map(value)).toEqual(['1', '2'])
    } finally {
      unregisterConnection(conn.id)
    }
  })

  it('a backlog over the byte cap drops the connection; a single waiting item never does', async () => {
    process.env.STATOR_SSE_QUEUE_MAX_BYTES = '64'
    const before = activeConnectionCount()
    const { connect } = await appFixture()
    const conn = await connect(() => new Promise<void>(() => {}))
    try {
      enqueue(conn, 'x'.repeat(200)) // in flight, wedged
      enqueue(conn, 'x'.repeat(200)) // waiting alone: over the cap, still fine
      expect(conn.closed).toBe(false)
      enqueue(conn, 'x'.repeat(10)) // two waiting, over the cap: dead
      expect(conn.closed).toBe(true)
      expect(conn.queue).toHaveLength(0)
      expect(activeConnectionCount()).toBe(before)
    } finally {
      unregisterConnection(conn.id)
      delete process.env.STATOR_SSE_QUEUE_MAX_BYTES
    }
  })

  it("the originator's patches ride its queue when it has a backlog, and the response when it doesn't", async () => {
    const { bump, connect, value } = await appFixture()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const sent: string[] = []
    const conn = await connect(async (d) => {
      await gate
      sent.push(d)
    }, 'tab-a')
    try {
      // Nothing queued: the originator is skipped, its POST response delivers.
      bump()
      expect(await fanOut(new Set(['QueueMachine']), { originClientId: 'tab-a' })).toEqual({
        originatorQueued: false,
      })
      expect(hasBacklog(conn)).toBe(false)
      // Someone else's fan-out puts a write in flight on its channel...
      bump()
      await fanOut(new Set(['QueueMachine']))
      expect(hasBacklog(conn)).toBe(true)
      // ...so its own diff must queue behind that, and the response carry none.
      bump()
      expect(await fanOut(new Set(['QueueMachine']), { originClientId: 'tab-a' })).toEqual({
        originatorQueued: true,
      })
      expect(conn.queue).toHaveLength(1)
      release()
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(sent.map(value)).toEqual(['2', '3'])
    } finally {
      unregisterConnection(conn.id)
    }
  })

  it('a failing push is logged and never throws out of fanOut', async () => {
    const { conn, runtime } = await syntheticConnection(async () => {
      throw new Error('broken pipe')
    })
    try {
      runtime.processEvent('PushMachine', { type: 'INC' })
      await expect(fanOut(new Set(['PushMachine']))).resolves.toEqual({ originatorQueued: false })
    } finally {
      unregisterConnection(conn.id)
    }
  })

  it('skips connections whose routes do not read a touched machine', async () => {
    const sent: string[] = []
    const { conn } = await syntheticConnection(async (d) => {
      sent.push(d)
    })
    try {
      await fanOut(new Set(['UnrelatedMachine']))
      expect(sent).toEqual([])
    } finally {
      unregisterConnection(conn.id)
    }
  })
})

describe('SSE: session-machine live reads', () => {
  it("delivers a session machine's changes to the SAME session's live connection (rehydrated)", async () => {
    // The Plimsoll checkout bug: the connection's runtime froze session
    // actors at connect; a POST/effect mutated the store in ANOTHER runtime;
    // fan-out recomputed against the frozen actor and pushed nothing.
    const app = await boot()
    const cookie = await cookieFor(app, '/my-pings')
    const sse = await openSse(app, 'GET /my-pings', cookie)
    try {
      await sse.readUntil((t) => t.includes('"patches"')) // connect sync

      const post = await app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /my-pings',
            Cookie: cookie,
          },
          body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
        }),
      )
      expect(post.status).toBe(200)

      const buf = await sse.readUntil((t) => /"value":"1"/.test(t))
      expect(buf).toContain('"value":"1"')
    } finally {
      sse.close()
    }
  })

  it("does NOT deliver one session's machine changes to another session's connection", async () => {
    const app = await boot()
    const cookieA = await cookieFor(app, '/my-pings')
    const sse = await openSse(app, 'GET /my-pings', cookieA)
    try {
      await sse.readUntil((t) => t.includes('"patches"')) // connect sync

      // Session B pings; A's connection reads PingMachine but B's ping is
      // B's own state — nothing may cross.
      const cookieB = await cookieFor(app, '/my-pings')
      await app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /my-pings',
            Cookie: cookieB,
          },
          body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
        }),
      )

      const buf = await sse.readUntil((t) => /"value":"1"/.test(t), 700)
      expect(buf).not.toContain('"value":"1"')
    } finally {
      sse.close()
    }
  })
})

describe('SSE: connection hygiene', () => {
  it('evicts a superseded connection from the same page-load', async () => {
    const app = await boot()
    const before = activeConnectionCount()
    const cookie = await cookieFor(app, '/board')

    // A half-open socket the server never saw abort: the page reconnects with
    // the same page-load identity, and the corpse would otherwise stay
    // registered forever — pinning a SessionRuntime and taking a slice of
    // every fan-out.
    const first = await openSse(app, 'GET /board', cookie, 'page-1')
    const second = await openSse(app, 'GET /board', cookie, 'page-1')
    try {
      await second.readUntil((t) => t.includes(': open'))
      // Still one: the replacement took the slot rather than adding to it...
      await vi.waitFor(() => expect(activeConnectionCount()).toBe(before + 1))
      // ...and the evicted one was actually hung up on, not just forgotten.
      await vi.waitFor(() => expect(first.ended).toBe(true))
    } finally {
      first.close()
      second.close()
    }
    await vi.waitFor(() => expect(activeConnectionCount()).toBe(before))
  })

  it('unregisters a client that disconnects during the connect-time render', async () => {
    const app = await boot()
    const before = activeConnectionCount()
    const cookie = await cookieFor(app, '/board')

    // The abort lands while the handler is still between registerConnection
    // and parking on `finished` — the ': open' flush and the initial sync.
    // Hono fires abort subscribers exactly once, at abort time, so a listener
    // registered after that window never runs and the connection stays in the
    // registry for the life of the process, pinning its SessionRuntime and
    // taking a slice of every fan-out.
    for (let i = 0; i < 5; i++) {
      const sse = await openSse(app, 'GET /board', cookie, `flap-${i}`)
      sse.close()
    }

    await vi.waitFor(() => expect(activeConnectionCount()).toBe(before))
  })

  it('keeps connections from different page-loads on the same route', async () => {
    const app = await boot()
    const before = activeConnectionCount()
    const cookie = await cookieFor(app, '/board')

    // Two real tabs of one session — distinct identities, so eviction must
    // NOT fire: both stay registered and neither gets hung up on.
    const a = await openSse(app, 'GET /board', cookie, 'page-a')
    const b = await openSse(app, 'GET /board', cookie, 'page-b')
    try {
      await a.readUntil((t) => t.includes(': open'))
      await b.readUntil((t) => t.includes(': open'))
      await vi.waitFor(() => expect(activeConnectionCount()).toBe(before + 2))
      expect(a.ended).toBe(false)
      expect(b.ended).toBe(false)
    } finally {
      a.close()
      b.close()
    }
    await vi.waitFor(() => expect(activeConnectionCount()).toBe(before))
  })
})

describe('double delivery to the dispatching connection', () => {
  it('a live page dispatching a keyed insert receives the row exactly once', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/my-list')
    const clientId = 'tab-under-test'
    const sse = await openSse(app, `GET /my-list`, cookie, clientId)
    try {
      await sse.readUntil((t) => t.includes('"patches"')) // connect sync

      const res = await app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /my-list',
            'X-Stator-Client': clientId,
            Cookie: cookie,
          },
          body: JSON.stringify({ machine: 'ListMachine', event: { type: 'ADD', id: 'row1' } }),
        }),
      )
      const body = (await res.json()) as { patches: Array<{ op: string }> }
      const responseInserts = body.patches.filter((p) => p.op === 'insert').length

      // Give fan-out time to (wrongly) push the same insert over SSE.
      const buf = await sse.readUntil((t) => t.includes('"op":"insert"'), 800)
      const sseInserts = (buf.match(/"op":"insert"/g) ?? []).length

      expect(responseInserts).toBe(1)
      expect(sseInserts).toBe(0) // the response already delivered it
    } finally {
      sse.close()
    }
  })

  it('other tabs of the same session still receive the insert; originator baseline advances', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/my-list')
    const tabA = await openSse(app, 'GET /my-list', cookie, 'tab-a')
    const tabB = await openSse(app, 'GET /my-list', cookie, 'tab-b')
    try {
      await tabA.readUntil((t) => t.includes('"patches"'))
      await tabB.readUntil((t) => t.includes('"patches"'))

      const post = (id: string) =>
        app.fetch(
          new Request('http://localhost/__events', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Stator-Route': 'GET /my-list',
              'X-Stator-Client': 'tab-a',
              Cookie: cookie,
            },
            body: JSON.stringify({ machine: 'ListMachine', event: { type: 'ADD', id } }),
          }),
        )
      await post('row1')
      // Tab B (didn't dispatch) must receive the insert.
      const bufB = await tabB.readUntil((t) => t.includes('"op":"insert"'))
      expect((bufB.match(/"op":"insert"/g) ?? []).length).toBe(1)

      // Second dispatch: tab A's baseline advanced silently, so the wire
      // stays consistent — B receives exactly one more insert, A none.
      await post('row2')
      const bufB2 = await tabB.readUntil((t) => (t.match(/"op":"insert"/g) ?? []).length >= 2)
      expect((bufB2.match(/"op":"insert"/g) ?? []).length).toBe(2)
      const bufA = await tabA.readUntil((t) => t.includes('"op":"insert"'), 500)
      expect((bufA.match(/"op":"insert"/g) ?? []).length).toBe(0)
    } finally {
      tabA.close()
      tabB.close()
    }
  })

  it('with a backlog on its channel, the page gets its own row over SSE and the response carries none', async () => {
    const app = await boot()
    const cookie = await cookieFor(app, '/my-list')
    const tabA = await openSse(app, 'GET /my-list', cookie, 'tab-a')
    const tabB = await openSse(app, 'GET /my-list', cookie, 'tab-b')
    try {
      await tabA.readUntil((t) => t.includes('"patches"'))
      await tabB.readUntil((t) => t.includes('"patches"'))
      const post = (client: string, id: string) =>
        app.fetch(
          new Request('http://localhost/__events', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Stator-Route': 'GET /my-list',
              'X-Stator-Client': client,
              Cookie: cookie,
            },
            body: JSON.stringify({ machine: 'ListMachine', event: { type: 'ADD', id } }),
          }),
        )

      // Tab A stops reading. Its stream's buffers absorb a write or two, then
      // the server's writes to it stall: a backlog, with tab B's inserts in it.
      // Those POSTs return promptly regardless — nothing waits on A's socket.
      tabA.pause()
      for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) await post('tab-b', id)

      // Tab A dispatches while that backlog stands: the response carries no
      // patches, because they would overtake the queued inserts, and a keyed
      // insert applied out of order corrupts the list.
      const res = await post('tab-a', 'a1')
      const body = (await res.json()) as { patches: unknown[]; committed: boolean }
      expect(body.committed).toBe(true)
      expect(body.patches).toEqual([])

      // Its row arrives over the channel instead — after the backlog, once.
      tabA.resume()
      const bufA = await tabA.readUntil((t) => (t.match(/"op":"insert"/g) ?? []).length >= 6)
      expect((bufA.match(/"op":"insert"/g) ?? []).length).toBe(6)
      expect((bufA.match(/<li>a1<\/li>/g) ?? []).length).toBe(1)
      expect(bufA.indexOf('<li>a1</li>')).toBeGreaterThan(bufA.indexOf('<li>b5</li>'))
      // Tab B, which did not dispatch it, receives it like any other insert.
      const bufB = await tabB.readUntil((t) => t.includes('<li>a1</li>'))
      expect((bufB.match(/"op":"insert"/g) ?? []).length).toBe(1)
    } finally {
      tabA.close()
      tabB.close()
    }
  })
})

describe('SSE heartbeat', () => {
  it('sends observable ping DATA frames on the configured interval', async () => {
    // A comment keepalive holds proxies open but is invisible to EventSource —
    // the ping must be a data frame so clients can detect zombie connections.
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      realtime: { pingMs: 40 },
    })
    const cookie = await cookieFor(app, '/board')
    const sse = await openSse(app, 'GET /board', cookie)
    const buffer = await sse.readUntil((text) => text.includes('{"ping":true}'), 2000)
    expect(buffer).toContain('data: {"ping":true}')
    sse.close()
  })
})
