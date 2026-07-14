import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('malformed route key')
  })

  it('rejects an unknown route with 404', async () => {
    const app = await boot()
    const res = await post(app, { 'X-Stator-Route': 'GET /no-such-page' }, VALID_EVENT)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('unknown route')
  })

  it('rejects invalid JSON bodies with 400, not a crash', async () => {
    const app = await boot()
    const res = await post(app, { 'X-Stator-Route': 'GET /' }, '{not json')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('invalid event payload')
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
      expect(res.status).toBe(400)
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
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('reserved')
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
    expect(res.status).toBe(403)
  })

  it('blocks a cross-origin /__events POST via mismatched Origin header', async () => {
    const app = await boot()
    const res = await post(
      app,
      { 'X-Stator-Route': 'GET /', Origin: 'https://evil.example' },
      VALID_EVENT,
    )
    expect(res.status).toBe(403)
  })

  it('allows same-origin and signal-less (non-browser) requests', async () => {
    const app = await boot()
    const sameOrigin = await post(
      app,
      { 'X-Stator-Route': 'GET /', 'Sec-Fetch-Site': 'same-origin' },
      VALID_EVENT,
    )
    expect(sameOrigin.status).toBe(200)
    // No Sec-Fetch-Site / Origin at all (server-to-server / test harness): allowed.
    const noSignal = await post(app, { 'X-Stator-Route': 'GET /' }, VALID_EVENT)
    expect(noSignal.status).toBe(200)
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
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('color:red')

    // `/static//<abs>` → rel becomes an absolute path; resolve() would honor it
    // verbatim without the containment check.
    const abs = await app.fetch(new Request(`http://localhost/static/${secret}`))
    expect(abs.status).toBe(403)
    expect(await abs.text()).not.toContain('TOP-SECRET')
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
    expect(cookie).toMatch(/^stator_sid=[0-9a-f-]{36};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Secure')
  })

  it('adds Secure when STATOR_SECURE_COOKIE=1', async () => {
    process.env.STATOR_SECURE_COOKIE = '1'
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('does not reissue the cookie for a returning session', async () => {
    const app = await boot()
    const first = await app.fetch(new Request('http://localhost/'))
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!
    const second = await app.fetch(
      new Request('http://localhost/', { headers: { Cookie: cookie } }),
    )
    expect(second.headers.get('set-cookie')).toBeNull()
  })
})

describe('committed reflects actual transitions', () => {
  it('a guard-dropped / unhandled event reports committed: false, zero patches', async () => {
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
    // An event no state handles: HTTP 200, but nothing committed.
    const dropped = (await (await post({ type: 'NO_SUCH_EVENT' })).json()) as {
      committed: boolean
      patches: unknown[]
    }
    expect(dropped.committed).toBe(false)
    expect(dropped.patches).toEqual([])
  })
})
