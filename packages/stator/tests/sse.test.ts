import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { defineRoute } from '../src/server/routing.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import {
  activeConnectionCount,
  fanOut,
  registerConnection,
  unregisterConnection,
} from '../src/server/sse.ts'
import { InMemoryStore } from '../src/server/store.ts'
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
async function openSse(app: StatorApp, routeKey: string, cookie: string) {
  const abort = new AbortController()
  const res = await app.fetch(
    new Request(`http://localhost/__sse?route=${encodeURIComponent(routeKey)}`, {
      headers: { Cookie: cookie },
      signal: abort.signal,
    }),
  )
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    /** Read until `predicate(buffer)` or timeout; returns the buffer. */
    async readUntil(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (!predicate(buffer) && Date.now() < deadline) {
        const result = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), deadline - Date.now())),
        ])
        if (result === 'timeout' || result.done) break
        buffer += decoder.decode(result.value, { stream: true })
      }
      return buffer
    },
    close() {
      abort.abort()
      reader.cancel().catch(() => {})
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

      const received = await sse.readUntil((t) => t.includes('"patches"'))
      expect(received).toContain('"op":"text"')
      expect(received).toContain('1')
    } finally {
      sse.close()
    }
    await vi.waitFor(() => expect(activeConnectionCount()).toBe(before))
  })

  it('pushes server-originated dispatchToApp updates and diffs subsequent pushes', async () => {
    const app = await boot()
    const cookieA = await cookieFor(app, '/board')
    const sse = await openSse(app, 'GET /board', cookieA)
    try {
      await sse.readUntil((t) => t.includes(': open'))

      // The webhook/cron path: no HTTP request, no session.
      await dispatchToApp(app.store, Board, { type: 'BUMP', by: 5 })
      let buf = await sse.readUntil((t) => t.includes('"patches"'))
      const firstValue = buf.match(/"value":"(\d+)"/)?.[1]

      await dispatchToApp(app.store, Board, { type: 'BUMP', by: 2 })
      buf = await sse.readUntil((t) => (t.match(/"patches"/g) ?? []).length >= 2)
      const values = [...buf.matchAll(/"value":"(\d+)"/g)].map((m) => Number(m[1]))

      // Two pushes, correctly diffed against the connection's own baseline:
      // the second reflects the accumulated total, not a reset.
      expect(values.at(-1)! - Number(firstValue)).toBe(2)
    } finally {
      sse.close()
    }
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

  it('a failing push is logged and never throws out of fanOut', async () => {
    const { conn, runtime } = await syntheticConnection(async () => {
      throw new Error('broken pipe')
    })
    try {
      runtime.processEvent('PushMachine', { type: 'INC' })
      await expect(fanOut(new Set(['PushMachine']))).resolves.toBeUndefined()
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
