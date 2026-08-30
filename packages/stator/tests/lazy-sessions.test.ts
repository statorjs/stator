import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/index.ts'

/**
 * The cacheable read path, layers 1+3 (spec: the-cacheable-read-path-…):
 * anonymous GETs establish nothing and carry derived Cache-Control when
 * provably anonymous-identical; dispatches, session reads, and SSE connects
 * each establish; session-reading responses are never cache-marked.
 */

const here = dirnameOf(import.meta.url)
const fixtures = resolve(here, 'fixtures')

function dirnameOf(url: string): string {
  return resolve(fileURLToPath(url), '..')
}

let app: StatorApp
let uncached: StatorApp

beforeAll(async () => {
  app = await createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
  })
  uncached = await createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    caching: false,
  })
})

afterAll(async () => {
  // Neither app listened; nothing to close.
})

const get = (a: StatorApp, path: string, headers: Record<string, string> = {}) =>
  a.fetch(new Request(`http://localhost${path}`, { headers }))

describe('layer 1 — lazy establishment', () => {
  it('an app-machine live page sets no cookie', async () => {
    const res = await get(app, '/board')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('a read-free data route sets no cookie', async () => {
    const res = await get(app, '/feed.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('a session-machine page establishes (cookie set)', async () => {
    const res = await get(app, '/plain')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('stator_sid=')
  })

  it('a session-machine data route establishes', async () => {
    const res = await get(app, '/my-pings')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('stator_sid=')
  })

  it('a first-contact dispatch establishes; a presented sid resumes without a new cookie', async () => {
    const post = (cookie?: string) =>
      app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /plain',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } }),
        }),
      )
    const anonymous = await post()
    expect(anonymous.status).toBe(200)
    expect(anonymous.headers.get('set-cookie')).toContain('stator_sid=')

    const resumed = await post(`stator_sid=${crypto.randomUUID()}`)
    expect(resumed.status).toBe(200)
    expect(resumed.headers.get('set-cookie')).toBeNull()
  })

  it('an SSE connect establishes', async () => {
    const abort = new AbortController()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /board')}`, {
        signal: abort.signal,
      }),
    )
    expect(res.headers.get('set-cookie')).toContain('stator_sid=')
    abort.abort()
  })
})

describe('layer 3 — derived Cache-Control', () => {
  it('a provably-anonymous page is cache-marked with the defaults', async () => {
    const res = await get(app, '/board')
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=300')
  })

  it('a provably-anonymous data route is cache-marked, 304s included', async () => {
    const res = await get(app, '/feed.xml')
    expect(res.headers.get('cache-control')).toContain('public, s-maxage=60')
    const etag = res.headers.get('etag')!
    const revalidated = await get(app, '/feed.xml', { 'if-none-match': etag })
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('cache-control')).toContain('public, s-maxage=60')
  })

  it('a session-reading page is never cache-marked', async () => {
    const res = await get(app, '/plain')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  it('a session-reading data route is never cache-marked', async () => {
    const res = await get(app, '/my-pings')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  it('a returning visitor with a cookie still gets the cacheable response uncookied', async () => {
    const res = await get(app, '/board', { Cookie: `stator_sid=${crypto.randomUUID()}` })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toContain('public')
  })

  it('caching: false disables emission entirely', async () => {
    const res = await get(uncached, '/board')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBeNull()
  })
})
