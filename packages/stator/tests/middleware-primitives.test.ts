import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')
const base = { machinesDir: resolve(fixtures, 'machines'), routesDir: resolve(fixtures, 'routes') }

describe('cors()', () => {
  it('reflects an allowed (wildcard) origin, with credentials + Vary', async () => {
    const app = await createApp({
      ...base,
      middlewareFile: resolve(fixtures, 'mw-cors.ts'),
      cors: { origins: ['https://*.tonysull.co'], credentials: true },
    })
    const res = await app.fetch(
      new Request('http://localhost/', { headers: { Origin: 'https://app.tonysull.co' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.tonysull.co')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('vary')).toContain('Origin')
  })

  it('does not reflect a disallowed origin', async () => {
    const app = await createApp({
      ...base,
      middlewareFile: resolve(fixtures, 'mw-cors.ts'),
      cors: { origins: ['https://*.tonysull.co'] },
    })
    const res = await app.fetch(
      new Request('http://localhost/', { headers: { Origin: 'https://evil.com' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers a preflight OPTIONS with 204 + advertised methods', async () => {
    const app = await createApp({
      ...base,
      middlewareFile: resolve(fixtures, 'mw-cors.ts'),
      cors: { origins: ['https://*.tonysull.co'] },
    })
    const res = await app.fetch(
      new Request('http://localhost/', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.tonysull.co', 'Access-Control-Request-Method': 'POST' },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('defaults cors origins to trustedOrigins when cors is unconfigured', async () => {
    const app = await createApp({
      ...base,
      middlewareFile: resolve(fixtures, 'mw-cors.ts'),
      trustedOrigins: ['https://*.tonysull.co'],
    })
    const res = await app.fetch(
      new Request('http://localhost/', { headers: { Origin: 'https://app.tonysull.co' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.tonysull.co')
  })
})

describe('securityHeaders()', () => {
  it('sets the baseline headers', async () => {
    const app = await createApp({ ...base, middlewareFile: resolve(fixtures, 'mw-headers.ts') })
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })
})
