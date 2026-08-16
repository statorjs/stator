import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

function boot(trustedOrigins: string[]) {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    trustedOrigins,
  })
}

const VALID = JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } })

function crossSitePost(app: StatorApp, origin: string) {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        'Sec-Fetch-Site': 'cross-site',
        Origin: origin,
      },
      body: VALID,
    }),
  )
}

describe('crossSiteGuard + trustedOrigins', () => {
  it('allows a cross-site write from a wildcard-trusted subdomain', async () => {
    const app = await boot(['https://*.tonysull.co'])
    expect((await crossSitePost(app, 'https://app.tonysull.co')).status).toBe(200)
  })

  it('allows a cross-site write from an exact-trusted origin', async () => {
    const app = await boot(['https://partner.example.com'])
    expect((await crossSitePost(app, 'https://partner.example.com')).status).toBe(200)
  })

  it('still blocks an untrusted cross-site origin', async () => {
    const app = await boot(['https://*.tonysull.co'])
    const res = await crossSitePost(app, 'https://evil.com')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('cross-site')
  })

  it('rejects the suffix-attack origin even with a matching wildcard entry', async () => {
    const app = await boot(['https://*.tonysull.co'])
    expect((await crossSitePost(app, 'https://tonysull.co.evil.com')).status).toBe(403)
  })

  it('403s a cross-site write to an unknown path before route-matching (no 404 leak)', async () => {
    const app = await boot([])
    const res = await app.fetch(
      new Request('http://localhost/api/nope', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.com' },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('does not guard safe methods (a cross-site GET passes)', async () => {
    const app = await boot([])
    const res = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.com' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('allows same-site writes by default (Lax posture)', async () => {
    const app = await boot([])
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          'Sec-Fetch-Site': 'same-site',
        },
        body: VALID,
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('crossSiteGuard strict posture (SameSite=Strict)', () => {
  function bootStrict(trustedOrigins: string[] = []) {
    return createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      trustedOrigins,
      sessions: { cookie: { sameSite: 'Strict' } },
    })
  }
  function sameSitePost(app: StatorApp, origin?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Stator-Route': 'GET /',
      'Sec-Fetch-Site': 'same-site',
    }
    if (origin) headers.Origin = origin
    return app.fetch(
      new Request('http://localhost/__events', { method: 'POST', headers, body: VALID }),
    )
  }

  it('sets the session cookie to SameSite=Strict', async () => {
    const app = await bootStrict()
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.headers.get('set-cookie')).toContain('SameSite=Strict')
  })

  it('blocks a same-site write not in the allowlist', async () => {
    const app = await bootStrict()
    expect((await sameSitePost(app, 'https://sibling.tonysull.co')).status).toBe(403)
  })

  it('allows a same-site write from an allowlisted subdomain', async () => {
    const app = await bootStrict(['https://*.tonysull.co'])
    expect((await sameSitePost(app, 'https://sibling.tonysull.co')).status).toBe(200)
  })

  it('still allows same-origin writes under strict', async () => {
    const app = await bootStrict()
    const res = await app.fetch(
      new Request('http://localhost/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Stator-Route': 'GET /',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: VALID,
      }),
    )
    expect(res.status).toBe(200)
  })
})
