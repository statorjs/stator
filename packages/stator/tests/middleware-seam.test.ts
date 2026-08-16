import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

function boot(middlewareFile?: string) {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    middlewareFile,
  })
}

const CROSS_SITE = { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.com' }
const VALID = JSON.stringify({ machine: 'CounterMachine', event: { type: 'INCREMENT' } })

function csrfPost(app: StatorApp, headers: Record<string, string>) {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', ...headers },
      body: VALID,
    }),
  )
}

describe('middleware seam', () => {
  it('runs the app middleware (defineMiddleware) on requests', async () => {
    const app = await boot(resolve(fixtures, 'mw-header.ts'))
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.headers.get('X-Mw-Test')).toBe('ran')
  })

  it('defineMiddleware keeps the framework defaults (cross-site still blocked)', async () => {
    const app = await boot(resolve(fixtures, 'mw-header.ts'))
    expect((await csrfPost(app, CROSS_SITE)).status).toBe(403)
  })

  it('dangerouslyDefineMiddleware drops the defaults (cross-site now passes)', async () => {
    const app = await boot(resolve(fixtures, 'mw-dangerous.ts'))
    expect((await csrfPost(app, CROSS_SITE)).status).toBe(200)
  })

  it('no middleware file → defaults still apply (safe by default)', async () => {
    const app = await boot()
    expect((await csrfPost(app, CROSS_SITE)).status).toBe(403)
  })

  it('rejects a middleware file that does not export a definition', async () => {
    await expect(boot(resolve(fixtures, 'mw-invalid.ts'))).rejects.toThrow(/defineMiddleware/)
  })

  it('exposes the raw Hono app (break-glass)', async () => {
    const app = await boot()
    expect(typeof app.hono.fetch).toBe('function')
    expect(typeof app.hono.route).toBe('function')
  })
})
