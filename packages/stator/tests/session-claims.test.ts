import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

function boot() {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    middlewareFile: resolve(fixtures, 'mw-claims-echo.ts'),
  })
}

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

describe('session claims', () => {
  it('persists claims and loads them on a later request for the same session', async () => {
    const app = await boot()
    const r1 = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'x-set-claims': JSON.stringify({ userId: 'u1' }) },
      }),
    )
    const cookie = cookieOf(r1)
    const r2 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(JSON.parse(r2.headers.get('x-claims') ?? 'null')).toEqual({ userId: 'u1' })
  })

  it('a fresh session has no claims', async () => {
    const app = await boot()
    const r = await app.fetch(new Request('http://localhost/'))
    expect(r.headers.get('x-claims')).toBeNull()
  })

  it('clearClaims removes them for subsequent requests', async () => {
    const app = await boot()
    const r1 = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'x-set-claims': JSON.stringify({ userId: 'u1' }) },
      }),
    )
    const cookie = cookieOf(r1)
    await app.fetch(
      new Request('http://localhost/', { headers: { Cookie: cookie, 'x-clear-claims': '1' } }),
    )
    const r3 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(r3.headers.get('x-claims')).toBeNull()
  })

  const sidOf = (res: Response) => res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1]

  it('claims set in a handler survive a same-request rotateSession (persist to the new id)', async () => {
    const app = await boot()
    // Establish the session first, so the login POST emits ONE cookie (rotation)
    // rather than two (fresh-session + rotation).
    const sidA = sidOf(await app.fetch(new Request('http://localhost/')))
    // POST sets claims then rotates — the login shape. Claims must land under
    // the NEW id, not the one being abandoned.
    const r1 = await app.fetch(
      new Request('http://localhost/claims-rotate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'http://localhost',
          Cookie: `stator_sid=${sidA}`,
        },
        body: new URLSearchParams(),
      }),
    )
    const rotatedSid = sidOf(r1)
    expect(rotatedSid).not.toBe(sidA)
    expect(rotatedSid).toBeTruthy()
    const r2 = await app.fetch(
      new Request('http://localhost/', { headers: { Cookie: `stator_sid=${rotatedSid}` } }),
    )
    expect(JSON.parse(r2.headers.get('x-claims') ?? 'null')).toEqual({ userId: 'u1' })
  })

  it('middleware clearSession destroys the session immediately — claims are gone', async () => {
    const app = await boot()
    const r1 = await app.fetch(
      new Request('http://localhost/', {
        headers: { 'x-set-claims': JSON.stringify({ userId: 'u1' }) },
      }),
    )
    const cookie = cookieOf(r1)
    // Middleware clears the session this request → a fresh anonymous id issues.
    const r2 = await app.fetch(
      new Request('http://localhost/', {
        headers: { Cookie: cookie, 'x-mw-clear-session': '1' },
      }),
    )
    const freshSid = sidOf(r2)
    expect(freshSid).toBeTruthy()
    expect(`stator_sid=${freshSid}`).not.toBe(cookie)
    // The fresh id carries no claims, and the old id was deleted.
    expect(r2.headers.get('x-claims')).toBeNull()
    const r3 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(r3.headers.get('x-claims')).toBeNull()
  })
})
