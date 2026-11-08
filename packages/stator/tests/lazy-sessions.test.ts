import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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

before(async () => {
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

after(async () => {
  // Neither app listened; nothing to close.
})

const get = (a: StatorApp, path: string, headers: Record<string, string> = {}) =>
  a.fetch(new Request(`http://localhost${path}`, { headers }))

describe('layer 1 — lazy establishment', () => {
  it('an app-machine live page sets no cookie', async () => {
    const res = await get(app, '/board')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('set-cookie'), null)
  })

  it('a read-free data route sets no cookie', async () => {
    const res = await get(app, '/feed.xml')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('set-cookie'), null)
  })

  it('a session-machine page establishes (cookie set)', async () => {
    const res = await get(app, '/plain')
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('set-cookie')?.includes('stator_sid='))
  })

  it('a session-machine data route establishes', async () => {
    const res = await get(app, '/my-pings')
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('set-cookie')?.includes('stator_sid='))
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
    assert.equal(anonymous.status, 200)
    assert.ok(anonymous.headers.get('set-cookie')?.includes('stator_sid='))

    const resumed = await post(`stator_sid=${crypto.randomUUID()}`)
    assert.equal(resumed.status, 200)
    assert.equal(resumed.headers.get('set-cookie'), null)
  })

  it('an SSE connect establishes', async () => {
    const abort = new AbortController()
    const res = await app.fetch(
      new Request(`http://localhost/__sse?route=${encodeURIComponent('GET /board')}`, {
        signal: abort.signal,
      }),
    )
    assert.ok(res.headers.get('set-cookie')?.includes('stator_sid='))
    abort.abort()
  })
})

describe('layer 3 — derived Cache-Control', () => {
  it('a provably-anonymous page is cache-marked with the defaults', async () => {
    const res = await get(app, '/board')
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    )
  })

  it('a provably-anonymous data route is cache-marked, 304s included', async () => {
    const res = await get(app, '/feed.xml')
    assert.ok(res.headers.get('cache-control')?.includes('public, max-age=0, s-maxage=60'))
    const etag = res.headers.get('etag')!
    const revalidated = await get(app, '/feed.xml', { 'if-none-match': etag })
    assert.equal(revalidated.status, 304)
    assert.ok(revalidated.headers.get('cache-control')?.includes('public, max-age=0, s-maxage=60'))
  })

  it('a session-reading page is never cache-marked', async () => {
    const res = await get(app, '/plain')
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('a session-reading data route is never cache-marked', async () => {
    const res = await get(app, '/my-pings')
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('a returning visitor with a cookie still gets the cacheable response uncookied', async () => {
    const res = await get(app, '/board', { Cookie: `stator_sid=${crypto.randomUUID()}` })
    assert.equal(res.headers.get('set-cookie'), null)
    assert.ok(res.headers.get('cache-control')?.includes('public'))
  })

  it('caching: false disables emission entirely', async () => {
    const res = await get(uncached, '/board')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('cache-control'), null)
  })
})

describe('the revision ledger', () => {
  it('a revision match answers 304 without invoking the handler', async () => {
    const { state } = await import('./fixtures/routes/revisioned.json.ts')
    const first = await get(app, '/revisioned.json')
    assert.equal(first.status, 200)
    assert.deepStrictEqual(await first.json(), { runs: 1 })
    const etag = first.headers.get('etag')!
    assert.match(etag, /^"r-/)
    assert.ok(first.headers.get('cache-control')?.includes('public'))

    const probe = await get(app, '/revisioned.json', { 'if-none-match': etag })
    assert.equal(probe.status, 304)
    assert.equal(probe.headers.get('etag'), etag)
    assert.ok(probe.headers.get('cache-control')?.includes('public'))
    // The whole point: the handler never ran.
    assert.equal(state.handlerRuns, 1)

    // A revision bump invalidates the token — the next probe renders anew.
    state.revision = 2
    const fresh = await get(app, '/revisioned.json', { 'if-none-match': etag })
    assert.equal(fresh.status, 200)
    assert.equal(state.handlerRuns, 2)
    assert.notEqual(fresh.headers.get('etag'), etag)
  })
})

/** The last session cookie a response set — a login that establishes and
 *  rotates in one request emits two, and browsers keep the last. */
function lastSid(res: Response): string {
  const sids = res.headers
    .getSetCookie()
    .map((cookie) => /stator_sid=([^;]+)/.exec(cookie)?.[1])
    .filter((sid): sid is string => !!sid)
  return sids.at(-1)!
}

describe('layer 3 — the proof is precise', () => {
  it('a page that reads a request header is never cache-marked', async () => {
    const res = await get(app, '/lang', { 'accept-language': 'fr' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('reading the Cookie header withdraws the proof even when no cookie arrived', async () => {
    const res = await get(app, '/cookie-gate')
    assert.ok((await res.text()).includes('live'))
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('a data route that reads a request header is never cache-marked', async () => {
    const res = await get(app, '/ua.json', { 'user-agent': 'probe' })
    assert.deepStrictEqual(await res.json(), { ua: 'probe' })
    assert.equal(res.headers.get('cache-control'), null)
  })

  it('a claims peek that finds nothing keeps the proof, anonymous or cookied', async () => {
    const anonymous = await get(app, '/whoami')
    assert.ok((await anonymous.text()).includes('anonymous'))
    assert.equal(anonymous.headers.get('set-cookie'), null)
    assert.ok(anonymous.headers.get('cache-control')?.includes('public'))

    const cookied = await get(app, '/whoami', { Cookie: `stator_sid=${crypto.randomUUID()}` })
    assert.ok((await cookied.text()).includes('anonymous'))
    assert.equal(cookied.headers.get('set-cookie'), null)
    assert.ok(cookied.headers.get('cache-control')?.includes('public'))
  })

  it('a claims peek that finds claims withdraws the proof', async () => {
    const login = await app.fetch(
      new Request('http://localhost/claims-rotate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://localhost',
        },
        body: new URLSearchParams(),
      }),
    )
    const res = await get(app, '/whoami', { Cookie: `stator_sid=${lastSid(login)}` })
    assert.ok((await res.text()).includes('u1'))
    assert.equal(res.headers.get('cache-control'), null)
  })
})
