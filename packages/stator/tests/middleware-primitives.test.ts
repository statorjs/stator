import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.tonysull.co')
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true')
    assert.ok(res.headers.get('vary')?.includes('Origin'))
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
    assert.equal(res.headers.get('access-control-allow-origin'), null)
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
    assert.equal(res.status, 204)
    assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'))
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
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.tonysull.co')
  })
})

describe('securityHeaders()', () => {
  it('sets the baseline headers', async () => {
    const app = await createApp({ ...base, middlewareFile: resolve(fixtures, 'mw-headers.ts') })
    const res = await app.fetch(new Request('http://localhost/'))
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  })
})
