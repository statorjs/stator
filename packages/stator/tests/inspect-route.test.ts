import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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
  assert.match(pair, /^stator_sid=/)
  return pair
}

describe('the dev inspect route', () => {
  it('does not exist unless the flag is set (the production posture)', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/@stator/inspect'))
    assert.equal(res.status, 404)
  })

  it('serves the machine catalog, app snapshots, and the route table', async () => {
    const app = await boot(true)
    const { status, body } = await inspect(app)
    assert.equal(status, 200)

    const counter = body!.machines.find((m) => m.name === 'CounterMachine')!
    assert.equal(counter.lifecycle, 'session')
    assert.deepStrictEqual(counter.serverOnly, ['SYNCED'])
    assert.deepStrictEqual(counter.events, ['INCREMENT', 'RESET', 'SYNCED'])
    assert.deepStrictEqual(counter.selectors, ['count'])
    assert.deepStrictEqual(counter.states.idle!.on.RESET, [
      { guarded: true, action: true, emits: [], effect: false },
    ])
    assert.equal(typeof counter.hash, 'string')

    // App machines are process-global: their live snapshot is present with no cookie.
    assert.partialDeepStrictEqual(body!.app.TickerMachine, {
      value: ['running'],
      context: { ticks: 0 },
    })

    // A fresh caller's session has touched nothing — truthfully null.
    assert.equal(body!.session.CounterMachine, null)
    assert.ok(!('TickerMachine' in body!.session))

    const byPath = Object.fromEntries(body!.routes.map((r) => [r.urlPath, r.methods]))
    assert.deepStrictEqual(byPath['/']!.GET, {
      kind: 'page',
      reads: ['CounterMachine'],
      live: true,
    })
    assert.deepStrictEqual(byPath['/feed.json']!.GET, { kind: 'data', reads: ['TickerMachine'] })
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
    assert.equal(dispatched.status, 200)

    // The dispatching session sees its own state…
    const mine = await inspect(app, cookie)
    assert.partialDeepStrictEqual(mine.body!.session.CounterMachine, {
      value: ['idle'],
      context: { count: 1 },
    })
    // …and a different caller does not.
    const other = await inspect(app)
    assert.equal(other.body!.session.CounterMachine, null)
  })

  it('is absent in production even when the wire toolbar is opted in', async () => {
    const app = await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      dev: { inspector: true },
    })
    const toolbar = await app.fetch(new Request('http://localhost/@stator/inspector.js'))
    assert.equal(toolbar.status, 200)
    const res = await app.fetch(new Request('http://localhost/@stator/inspect'))
    assert.equal(res.status, 404)
  })
})
