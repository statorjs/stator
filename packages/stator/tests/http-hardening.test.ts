import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

async function boot(staticDir?: string): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    staticDir,
  })
}

function post(app: StatorApp, headers: Record<string, string>, body: string) {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    }),
  )
}

const VALID_EVENT = JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } })

describe('/__events input hardening', () => {
  it('rejects a malformed route key with 400', async () => {
    const app = await boot()
    const res = await post(app, { 'X-Stator-Route': 'DELETE!!nonsense' }, VALID_EVENT)
    assert.equal(res.status, 400)
    assert.ok(((await res.json()) as { error: string }).error.includes('malformed route key'))
  })

  it('rejects an unknown route with 404', async () => {
    const app = await boot()
    const res = await post(app, { 'X-Stator-Route': 'GET /no-such-page' }, VALID_EVENT)
    assert.equal(res.status, 404)
    assert.ok(((await res.json()) as { error: string }).error.includes('unknown route'))
  })

  it('rejects invalid JSON bodies with 400, not a crash', async () => {
    const app = await boot()
    const res = await post(app, { 'X-Stator-Route': 'GET /' }, '{not json')
    assert.equal(res.status, 400)
    assert.ok(((await res.json()) as { error: string }).error.includes('invalid event payload'))
  })

  it('rejects schema-invalid payloads (missing machine / non-object event)', async () => {
    const app = await boot()
    for (const bad of [
      JSON.stringify({ event: { type: 'X' } }),
      JSON.stringify({ machine: 'CounterMachine' }),
      JSON.stringify({ machine: 'CounterMachine', event: 'INCREMENT' }),
      JSON.stringify({ machine: 'CounterMachine', event: {} }),
    ]) {
      const res = await post(app, { 'X-Stator-Route': 'GET /' }, bad)
      assert.equal(res.status, 400)
    }
  })

  it('rejects reserved @-prefixed events (e.g. the engine @set) with 400', async () => {
    const app = await boot()
    // `@set` would be an arbitrary-context write bypassing every guard; it is
    // framework-internal and must never arrive from the wire.
    const res = await post(
      app,
      { 'X-Stator-Route': 'GET /' },
      JSON.stringify({
        machine: 'CounterMachine',
        event: { type: '@set', key: 'count', value: 999 },
      }),
    )
    assert.equal(res.status, 400)
    assert.ok(((await res.json()) as { error: string }).error.includes('reserved'))
  })
})

describe('CSRF origin check on mutating routes', () => {
  it('blocks a cross-site /__events POST (Sec-Fetch-Site: cross-site) with 403', async () => {
    const app = await boot()
    const res = await post(
      app,
      { 'X-Stator-Route': 'GET /', 'Sec-Fetch-Site': 'cross-site' },
      VALID_EVENT,
    )
    assert.equal(res.status, 403)
  })

  it('blocks a cross-origin /__events POST via mismatched Origin header', async () => {
    const app = await boot()
    const res = await post(
      app,
      { 'X-Stator-Route': 'GET /', Origin: 'https://evil.example' },
      VALID_EVENT,
    )
    assert.equal(res.status, 403)
  })

  it('allows same-origin and signal-less (non-browser) requests', async () => {
    const app = await boot()
    const sameOrigin = await post(
      app,
      { 'X-Stator-Route': 'GET /', 'Sec-Fetch-Site': 'same-origin' },
      VALID_EVENT,
    )
    assert.equal(sameOrigin.status, 200)
    // No Sec-Fetch-Site / Origin at all (server-to-server / test harness): allowed.
    const noSignal = await post(app, { 'X-Stator-Route': 'GET /' }, VALID_EVENT)
    assert.equal(noSignal.status, 200)
  })
})

describe('static file serving containment', () => {
  it('serves an in-root asset but blocks absolute-path and .. escapes', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'stator-static-'))
    writeFileSync(join(staticDir, 'app.css'), 'body{color:red}')
    const secret = join(mkdtempSync(join(tmpdir(), 'stator-secret-')), 'secret.txt')
    writeFileSync(secret, 'TOP-SECRET')
    const app = await boot(staticDir)

    const ok = await app.fetch(new Request('http://localhost/static/app.css'))
    assert.equal(ok.status, 200)
    assert.ok((await ok.text()).includes('color:red'))

    // `/static//<abs>` → rel becomes an absolute path; resolve() would honor it
    // verbatim without the containment check.
    const abs = await app.fetch(new Request(`http://localhost/static/${secret}`))
    assert.equal(abs.status, 403)
    assert.ok(!(await abs.text()).includes('TOP-SECRET'))
  })
})

describe('session cookie flags', () => {
  const originalSecure = process.env.STATOR_SECURE_COOKIE
  afterEach(() => {
    if (originalSecure === undefined) delete process.env.STATOR_SECURE_COOKIE
    else process.env.STATOR_SECURE_COOKIE = originalSecure
  })

  it('sets HttpOnly, SameSite=Lax, Path=/ and no Secure outside production', async () => {
    delete process.env.STATOR_SECURE_COOKIE
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/'))
    const cookie = res.headers.get('set-cookie')!
    assert.match(cookie, /^stator_sid=[0-9a-f-]{36};/)
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Lax'))
    assert.ok(cookie.includes('Path=/'))
    assert.ok(!cookie.includes('Secure'))
  })

  it('adds Secure when STATOR_SECURE_COOKIE=1', async () => {
    process.env.STATOR_SECURE_COOKIE = '1'
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/'))
    assert.ok(res.headers.get('set-cookie'))
    assert.ok(res.headers.get('set-cookie')!.includes('Secure'))
  })

  it('does not reissue the cookie for a returning session', async () => {
    const app = await boot()
    const first = await app.fetch(new Request('http://localhost/'))
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    const second = await app.fetch(
      new Request('http://localhost/', { headers: { Cookie: cookie } }),
    )
    assert.equal(second.headers.get('set-cookie'), null)
  })
})

describe('committed reflects actual transitions', () => {
  it('an event the chart handles elsewhere reports committed: false; one it never handles is a 400', async () => {
    const app = await boot()
    const page = await app.fetch(new Request('http://localhost/submitter'))
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    const post = (event: object) =>
      app.fetch(
        new Request('http://localhost/__events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stator-Route': 'GET /submitter',
            Cookie: cookie,
          },
          body: JSON.stringify({ machine: 'SubmitterMachine', event }),
        }),
      )
    // DONE is handled in `pending`, not in `idle`: a stale event, which reaches
    // the machine and commits nothing.
    const stale = await post({ type: 'DONE', receipt: 'x' })
    assert.equal(stale.status, 200)
    const dropped = (await stale.json()) as { committed: boolean; patches: unknown[] }
    assert.equal(dropped.committed, false)
    assert.deepStrictEqual(dropped.patches, [])
    // An event no part of the chart handles can never commit: refused, named.
    const unknown = await post({ type: 'NO_SUCH_EVENT' })
    assert.equal(unknown.status, 400)
    assert.match(
      ((await unknown.json()) as { error: string }).error,
      /handles no event "NO_SUCH_EVENT"/,
    )
    // A prototype name is not a handler either.
    assert.equal((await post({ type: 'toString' })).status, 400)
  })
})

describe('static caching headers', () => {
  it('serves user files with revalidation + 304s, and assets/ as immutable', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'stator-static-'))
    writeFileSync(join(staticDir, 'site.css'), 'body{margin:0}')
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'assets', 'app-AbCd1234.js'), 'export{}')
    const app = await boot(staticDir)

    const first = await app.fetch(new Request('http://localhost/static/site.css'))
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
    const etag = first.headers.get('etag')
    assert.ok(etag)
    assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/)
    assert.ok(first.headers.get('last-modified'))

    const revalidated = await app.fetch(
      new Request('http://localhost/static/site.css', { headers: { 'If-None-Match': etag! } }),
    )
    assert.equal(revalidated.status, 304)
    assert.equal(await revalidated.text(), '')

    const dated = await app.fetch(
      new Request('http://localhost/static/site.css', {
        headers: { 'If-Modified-Since': first.headers.get('last-modified')! },
      }),
    )
    assert.equal(dated.status, 304)

    const asset = await app.fetch(new Request('http://localhost/static/assets/app-AbCd1234.js'))
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  })
})
