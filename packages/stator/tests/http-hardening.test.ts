import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

async function boot(): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
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
