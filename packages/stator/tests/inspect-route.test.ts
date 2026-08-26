import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'
import { discoverMachines } from '../src/server/discovery.ts'
import { wireAppEffects } from '../src/server/effects.ts'
import { buildHonoApp } from '../src/server/http.ts'
import type { InspectPayload } from '../src/server/inspect.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { discoverRoutes } from '../src/server/route-discovery.ts'
import { InMemoryStore } from '../src/server/store.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures/inspect')

/** The dev servers' wiring in miniature: discovery + store + buildHonoApp,
 *  with the `inspect` flag under test control. */
const boot = async (inspect?: boolean) => {
  const { defs } = await discoverMachines(resolve(fixtures, 'machines'))
  const store = new MachineStore(defs, new InMemoryStore())
  wireAppEffects(store)
  await store.bootAppMachines()
  const routes = await discoverRoutes(resolve(fixtures, 'routes'))
  return buildHonoApp({ routes, store, ...(inspect !== undefined ? { inspect } : {}) })
}
type App = Awaited<ReturnType<typeof boot>>

const inspect = async (
  app: App,
  cookie?: string,
): Promise<{ status: number; body?: InspectPayload }> => {
  const res = await app.fetch(
    new Request('http://localhost/@stator/inspect', {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  )
  return { status: res.status, ...(res.ok ? { body: (await res.json()) as InspectPayload } : {}) }
}

const sessionCookie = (res: Response): string => {
  const raw = res.headers.get('set-cookie') ?? ''
  const pair = raw.split(';')[0] ?? ''
  expect(pair).toMatch(/^stator_sid=/)
  return pair
}

describe('the dev inspect route', () => {
  it('does not exist unless the flag is set (the production posture)', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/@stator/inspect'))
    expect(res.status).toBe(404)
  })

  it('serves the machine catalog, app snapshots, and the route table', async () => {
    const app = await boot(true)
    const { status, body } = await inspect(app)
    expect(status).toBe(200)

    const counter = body!.machines.find((m) => m.name === 'CounterMachine')!
    expect(counter.lifecycle).toBe('session')
    expect(counter.serverOnly).toEqual(['SYNCED'])
    expect(counter.events).toEqual(['INCREMENT', 'RESET', 'SYNCED'])
    expect(counter.selectors).toEqual(['count'])
    expect(counter.states.idle!.on.RESET).toEqual([
      { guarded: true, action: true, emits: [], effect: false },
    ])
    expect(typeof counter.hash).toBe('string')

    // App machines are process-global: their live snapshot is present with no cookie.
    expect(body!.app.TickerMachine).toMatchObject({ value: ['running'], context: { ticks: 0 } })

    // A fresh caller's session has touched nothing — truthfully null.
    expect(body!.session.CounterMachine).toBeNull()
    expect(body!.session).not.toHaveProperty('TickerMachine')

    const byPath = Object.fromEntries(body!.routes.map((r) => [r.urlPath, r.methods]))
    expect(byPath['/']!.GET).toEqual({ kind: 'page', reads: ['CounterMachine'], live: true })
    expect(byPath['/feed.json']!.GET).toEqual({ kind: 'data', reads: ['TickerMachine'] })
  })

  it('scopes session snapshots to the caller cookie', async () => {
    const app = await boot(true)
    const page = await app.fetch(new Request('http://localhost/'))
    const cookie = sessionCookie(page)

    const dispatched = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          Cookie: cookie,
        },
        body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
      }),
    )
    expect(dispatched.status).toBe(200)

    // The dispatching session sees its own state…
    const mine = await inspect(app, cookie)
    expect(mine.body!.session.CounterMachine).toMatchObject({
      value: ['idle'],
      context: { count: 1 },
    })
    // …and a different caller does not.
    const other = await inspect(app)
    expect(other.body!.session.CounterMachine).toBeNull()
  })

  it('is absent in production even when the wire toolbar is opted in', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      dev: { inspector: true },
    })
    const toolbar = await app.fetch(new Request('http://localhost/@stator/inspector.js'))
    expect(toolbar.status).toBe(200)
    const res = await app.fetch(new Request('http://localhost/@stator/inspect'))
    expect(res.status).toBe(404)
  })
})
