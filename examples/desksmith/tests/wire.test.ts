import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The wire contract: what a browser may post to /__events. The rules
 * themselves are tested in cart.test.ts and checkout.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp
let cookie: string

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
  const page = await app.fetch(new Request('http://test/checkout'))
  cookie = page.headers.get('set-cookie')!.split(';')[0]!
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

function post(event: object) {
  return app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /checkout', Cookie: cookie },
      body: JSON.stringify({ machine: 'CheckoutMachine', event }),
    }),
  )
}

describe('checkout over the wire', () => {
  it('accepts an event the checkout page sends', async () => {
    const res = await post({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' })
    assert.equal(res.status, 200)
  })

  it('refuses CHARGE_OK from a browser: only the charge effect reports it', async () => {
    const res = await post({ type: 'CHARGE_OK', receipt: 'FORGED' })
    assert.equal(res.status, 403)
  })
})
