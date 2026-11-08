import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
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
    assert.equal(res.headers.get('X-Mw-Test'), 'ran')
  })

  it('defineMiddleware keeps the framework defaults (cross-site still blocked)', async () => {
    const app = await boot(resolve(fixtures, 'mw-header.ts'))
    assert.equal((await csrfPost(app, CROSS_SITE)).status, 403)
  })

  it('dangerouslyDefineMiddleware drops the defaults (cross-site now passes)', async () => {
    const app = await boot(resolve(fixtures, 'mw-dangerous.ts'))
    assert.equal((await csrfPost(app, CROSS_SITE)).status, 200)
  })

  it('no middleware file → defaults still apply (safe by default)', async () => {
    const app = await boot()
    assert.equal((await csrfPost(app, CROSS_SITE)).status, 403)
  })

  it('rejects a middleware file that does not export a definition', async () => {
    await assert.rejects(boot(resolve(fixtures, 'mw-invalid.ts')), /defineMiddleware/)
  })

  it('exposes the raw Hono app (break-glass)', async () => {
    const app = await boot()
    assert.equal(typeof app.hono.fetch, 'function')
    assert.equal(typeof app.hono.route, 'function')
  })
})
