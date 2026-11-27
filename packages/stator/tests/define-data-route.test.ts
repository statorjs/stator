import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
import { discoverRoutes } from '../src/server/route-discovery.ts'
import {
  defineApiRoute,
  defineDataRoute,
  isStatorApiRoute,
  isStatorQueryRoute,
} from '../src/server/routing.ts'
import Board from './fixtures/machines/board.ts'

/**
 * `defineDataRoute` builds the same definition as the deprecated
 * `defineApiRoute({ method: 'GET' })`, so discovery, serving, the revision
 * ledger and derived caching treat the two alike.
 */

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'define-data-route', 'routes'),
  })
}

const get = (app: StatorApp, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers }))

describe('defineDataRoute: the definition', () => {
  it('equals the one defineApiRoute({ method: "GET" }) builds from the same fields', () => {
    const handler = () => ({ ok: true })
    const revision = () => 1
    const fresh = defineDataRoute({ reads: [Board], handler, revision })
    const legacy = defineApiRoute({ method: 'GET', reads: [Board], handler, revision })
    assert.deepStrictEqual(fresh, legacy)
    assert.deepStrictEqual(Object.keys(fresh), Object.keys(legacy))
    assert.equal(isStatorQueryRoute(fresh), true)
    assert.equal(isStatorApiRoute(fresh), false)
  })

  it('defaults reads to an empty list and copies the tuple', () => {
    const reads = [Board] as const
    const def = defineDataRoute({ reads, handler: () => ({}) })
    assert.deepStrictEqual(def.reads, [Board])
    assert.notEqual(def.reads, reads)
    assert.deepStrictEqual(defineDataRoute({ handler: () => ({}) }).reads, [])
  })
})

describe('defineDataRoute: served as a data GET', () => {
  it('serves machine state as JSON through a read proxy, like the old spelling', async () => {
    const app = await boot()
    await app.dispatchToApp(Board, { type: 'BUMP', by: 7 })
    const fresh = await get(app, '/board')
    const legacy = await get(app, '/board-legacy')
    for (const res of [fresh, legacy]) {
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type')!.includes('application/json'))
      assert.ok(res.headers.get('etag'))
      assert.equal(res.headers.get('set-cookie'), null)
      assert.deepStrictEqual(await res.json(), { total: 7 })
    }
  })

  it('carries the same derived Cache-Control as the old spelling', async () => {
    const app = await boot()
    const fresh = await get(app, '/board')
    const legacy = await get(app, '/board-legacy')
    assert.ok(fresh.headers.get('cache-control')!.includes('public'))
    assert.equal(fresh.headers.get('cache-control'), legacy.headers.get('cache-control'))
  })

  it('answers If-None-Match with a bodyless 304 until the state moves', async () => {
    const app = await boot()
    const etag = (await get(app, '/board')).headers.get('etag')!
    const second = await get(app, '/board', { 'If-None-Match': etag })
    assert.equal(second.status, 304)
    assert.equal(await second.text(), '')
    await app.dispatchToApp(Board, { type: 'BUMP', by: 1 })
    const third = await get(app, '/board', { 'If-None-Match': etag })
    assert.equal(third.status, 200)
    assert.deepStrictEqual(await third.json(), { total: 1 })
  })

  it('a revision match answers 304 without invoking the handler', async () => {
    const app = await boot()
    const { state } = await import('./fixtures/define-data-route/routes/revisioned.json.ts')
    const first = await get(app, '/revisioned.json')
    assert.equal(first.status, 200)
    const runs = state.handlerRuns
    const etag = first.headers.get('etag')!
    assert.match(etag, /^"r-/)

    const probe = await get(app, '/revisioned.json', { 'if-none-match': etag })
    assert.equal(probe.status, 304)
    assert.ok(probe.headers.get('cache-control')!.includes('public'))
    assert.equal(state.handlerRuns, runs)

    state.revision += 1
    const fresh = await get(app, '/revisioned.json', { 'if-none-match': etag })
    assert.equal(fresh.status, 200)
    assert.equal(state.handlerRuns, runs + 1)
  })

  it('a claims read withdraws derived caching', async () => {
    const app = await boot()
    const res = await get(app, '/me.json')
    assert.deepStrictEqual(await res.json(), { user: null })
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('shares a file and a URL with a command POST', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request('http://localhost/board', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }),
    )
    assert.equal(res.status, 200)
    assert.deepStrictEqual(await res.json(), { patches: [], directives: [] })
  })
})

describe('defineDataRoute: discovery', () => {
  it('lists it as a GET, as the old spelling is', async () => {
    const routes = await discoverRoutes(resolve(fixtures, 'define-data-route', 'routes'))
    const board = routes.find((r) => r.urlPath === '/board')!
    assert.ok(board)
    assert.equal(isStatorQueryRoute(board.GET), true)
    assert.equal(isStatorApiRoute(board.POST), true)
  })

  it('rejects it under a mutation method, as it rejects a method: "GET" definition', async () => {
    await assert.rejects(
      discoverRoutes(resolve(fixtures, 'data-route-as-delete')),
      /exports DELETE created with method: 'GET'.*Data routes are GET-only/,
    )
  })
})
