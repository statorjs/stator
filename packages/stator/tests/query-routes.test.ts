import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'
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

describe('data GET routes: response synthesis', () => {
  it('serves machine state as JSON on an extensionless URL, with an ETag', async () => {
    const app = await boot()
    await app.dispatchToApp(Board, { type: 'BUMP', by: 7 })

    const res = await app.fetch(new Request('http://localhost/api-board'))
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type'))
    assert.ok(res.headers.get('content-type')!.includes('application/json'))
    assert.ok(res.headers.get('etag'))
    assert.deepStrictEqual(await res.json(), { total: 7 })
  })

  it('answers If-None-Match with a bodyless 304', async () => {
    const app = await boot()
    const first = await app.fetch(new Request('http://localhost/api-board'))
    const etag = first.headers.get('etag')!

    const second = await app.fetch(
      new Request('http://localhost/api-board', { headers: { 'If-None-Match': etag } }),
    )
    assert.equal(second.status, 304)
    assert.equal(await second.text(), '')

    // State moved → the ETag no longer matches → full body again.
    await app.dispatchToApp(Board, { type: 'BUMP', by: 1 })
    const third = await app.fetch(
      new Request('http://localhost/api-board', { headers: { 'If-None-Match': etag } }),
    )
    assert.equal(third.status, 200)
    assert.deepStrictEqual(await third.json(), { total: 1 })
  })

  it('a string result takes its Content-Type from the URL extension', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/feed.xml'))
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type'))
    assert.ok(res.headers.get('content-type')!.includes('application/xml'))
    assert.ok((await res.text()).includes('<rss>'))
  })

  it('a stylesheet route serves text/css with the free ETag/304 and derived Cache-Control', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/theme.css'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.ok(res.headers.get('cache-control'))
    assert.ok(res.headers.get('cache-control')!.includes('public'))
    assert.ok((await res.text()).includes('--accent'))
    const etag = res.headers.get('etag')!
    const revalidated = await app.fetch(
      new Request('http://localhost/theme.css', { headers: { 'if-none-match': etag } }),
    )
    assert.equal(revalidated.status, 304)
  })

  it('a raw Response passes through verbatim', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/raw-data'))
    assert.equal(res.status, 201)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('x-fixture'), 'yes')
    assert.equal(await res.text(), 'raw-bytes')
  })
})

describe('data GET routes: machine access', () => {
  it("reads the requesting session's own machine — two cookies, two answers", async () => {
    const app = await boot()
    const cookieA = await cookieFor(app, '/my-pings')
    const cookieB = await cookieFor(app, '/my-pings')

    // Session A pings once through the normal event path.
    const post = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /my-pings',
          Cookie: cookieA,
        },
        body: JSON.stringify({ machine: 'PingMachine', event: { type: 'PING' } }),
      }),
    )
    assert.equal(post.status, 200)

    const forA = await app.fetch(
      new Request('http://localhost/my-count', { headers: { Cookie: cookieA } }),
    )
    assert.deepStrictEqual(await forA.json(), { sent: 1 })

    const forB = await app.fetch(
      new Request('http://localhost/my-count', { headers: { Cookie: cookieB } }),
    )
    assert.deepStrictEqual(await forB.json(), { sent: 0 })
  })

  it('a data GET and a command POST share one file and one URL', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request('http://localhost/api-board', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }),
    )
    assert.equal(res.status, 200)
    assert.deepStrictEqual(await res.json(), { patches: [], directives: [] })
  })
})

describe('data GET routes: wire-endpoint guards', () => {
  it('/__sse rejects a data route key — data routes are not live', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /api-board')}`),
    )
    assert.equal(res.status, 400)
    assert.ok((await res.text()).includes('data route'))
  })

  it('/__events rejects a route key that targets a data route', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /api-board' },
        body: JSON.stringify({ machine: 'BoardMachine', event: { type: 'BUMP' } }),
      }),
    )
    assert.equal(res.status, 404)
    assert.ok((await res.text()).includes('data route'))
  })
})
