import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('etag')).toBeTruthy()
    expect(await res.json()).toEqual({ total: 7 })
  })

  it('answers If-None-Match with a bodyless 304', async () => {
    const app = await boot()
    const first = await app.fetch(new Request('http://localhost/api-board'))
    const etag = first.headers.get('etag')!

    const second = await app.fetch(
      new Request('http://localhost/api-board', { headers: { 'If-None-Match': etag } }),
    )
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')

    // State moved → the ETag no longer matches → full body again.
    await app.dispatchToApp(Board, { type: 'BUMP', by: 1 })
    const third = await app.fetch(
      new Request('http://localhost/api-board', { headers: { 'If-None-Match': etag } }),
    )
    expect(third.status).toBe(200)
    expect(await third.json()).toEqual({ total: 1 })
  })

  it('a string result takes its Content-Type from the URL extension', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/feed.xml'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xml')
    expect(await res.text()).toContain('<rss>')
  })

  it('a raw Response passes through verbatim', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/raw-data'))
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('x-fixture')).toBe('yes')
    expect(await res.text()).toBe('raw-bytes')
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
    expect(post.status).toBe(200)

    const forA = await app.fetch(
      new Request('http://localhost/my-count', { headers: { Cookie: cookieA } }),
    )
    expect(await forA.json()).toEqual({ sent: 1 })

    const forB = await app.fetch(
      new Request('http://localhost/my-count', { headers: { Cookie: cookieB } }),
    )
    expect(await forB.json()).toEqual({ sent: 0 })
  })

  it('a data GET and a command POST share one file and one URL', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request('http://localhost/api-board', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ patches: [], directives: [] })
  })
})

describe('data GET routes: wire-endpoint guards', () => {
  it('/__sse rejects a data route key — data routes are not live', async () => {
    const app = await boot()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /api-board')}`),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('data route')
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
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('data route')
  })
})
