import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')
const sealedMw = resolve(fixtures, 'mw-sealed-echo.ts')

const boot = (secret?: string) =>
  createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    middlewareFile: sealedMw,
    secret,
  })

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))

describe('signed cookies', () => {
  it('round-trips a signed value: set → verified read on the next request', async () => {
    const app = await boot('a-long-test-signing-secret-value')
    const r1 = await app.fetch(
      new Request('http://localhost/', { headers: { 'x-seal': 'v1-state' } }),
    )
    const sealed = cookieOf(r1, 'sealed')
    expect(sealed).toBeTruthy()
    // A signed cookie carries a signature after the value — it's not the raw value.
    expect(sealed).not.toBe('sealed=v1-state')

    const cookie = sealed!.split(';')[0]!
    const r2 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
    expect(r2.headers.get('x-sealed')).toBe('v1-state')
  })

  it('a tampered signed cookie reads as undefined (not trusted)', async () => {
    const app = await boot('a-long-test-signing-secret-value')
    const r1 = await app.fetch(
      new Request('http://localhost/', { headers: { 'x-seal': 'honest' } }),
    )
    const raw = cookieOf(r1, 'sealed')!.split(';')[0]!
    // Flip the last char of the (value.signature) payload → signature no longer matches.
    const tampered = raw.slice(0, -1) + (raw.endsWith('A') ? 'B' : 'A')
    const r2 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: tampered } }))
    expect(r2.headers.get('x-sealed')).toBeNull()
  })

  it('a cookie signed with a different secret does not verify (rotation-safe)', async () => {
    const signer = await boot('secret-one-original')
    const r1 = await signer.fetch(new Request('http://localhost/', { headers: { 'x-seal': 'x' } }))
    const cookie = cookieOf(r1, 'sealed')!.split(';')[0]!
    // A fresh app with a rotated secret treats the old cookie as absent, not an error.
    const rotated = await boot('secret-two-rotated')
    const r2 = await rotated.fetch(
      new Request('http://localhost/', { headers: { Cookie: cookie } }),
    )
    expect(r2.headers.get('x-sealed')).toBeNull()
  })

  it('throws a clear error when no secret is configured', async () => {
    const app = await boot(undefined) // no secret, no STATOR_SECRET
    const res = await app.fetch(new Request('http://localhost/', { headers: { 'x-seal': 'nope' } }))
    // The middleware's setSigned throws → the request fails (not a silent pass).
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('reads the secret from STATOR_SECRET when config.secret is unset', async () => {
    process.env.STATOR_SECRET = 'from-the-environment-secret'
    try {
      const app = await boot(undefined)
      const r1 = await app.fetch(
        new Request('http://localhost/', { headers: { 'x-seal': 'env-signed' } }),
      )
      const cookie = cookieOf(r1, 'sealed')!.split(';')[0]!
      const r2 = await app.fetch(new Request('http://localhost/', { headers: { Cookie: cookie } }))
      expect(r2.headers.get('x-sealed')).toBe('env-signed')
    } finally {
      delete process.env.STATOR_SECRET
    }
  })
})
