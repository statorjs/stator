import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevApp, type DevApp } from '@statorjs/stator/dev'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The thin wire layer: a few requests proving the binding between machines
 * and pages — render, dispatch, patch, gate. The logic itself is covered by
 * the machine tests; these exist so the wiring can't silently detach.
 */

const here = dirname(fileURLToPath(import.meta.url))
let app: DevApp

beforeAll(async () => {
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
}, 30_000)

afterAll(async () => {
  await app.close()
})

async function session(path: string): Promise<string> {
  const res = await app.fetch(new Request(`http://test${path}`))
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

function post(cookie: string, route: string, machine: string, event: object) {
  return app.fetch(
    new Request('http://test/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': route,
        Cookie: cookie,
      },
      body: JSON.stringify({ machine, event }),
    }),
  )
}

describe('the wire contract', () => {
  it('renders the catalog with cards and plates', async () => {
    const res = await app.fetch(new Request('http://test/c/all'))
    const html = await res.text()
    expect(html).toContain('class="card"')
    expect(html).toContain('--plate-upper:')
  })

  it('ADD patches the cart page: keyed insert + header count + committed', async () => {
    const cookie = await session('/cart')
    const res = await post(cookie, 'GET /cart', 'CartMachine', {
      type: 'ADD',
      sku: 'ketch--squid-ink--43',
    })
    const body = (await res.json()) as { committed: boolean; patches: Array<{ op: string }> }
    expect(body.committed).toBe(true)
    expect(body.patches.some((p) => p.op === 'insert')).toBe(true)
  })

  it('a forged admin restock is gated: HTTP 200, committed false, zero patches', async () => {
    const cookie = await session('/admin')
    const res = await post(cookie, 'GET /admin', 'AdminMachine', {
      type: 'REQUEST_RESTOCK',
      sku: 'the-longshore--kelp--42',
    })
    const body = (await res.json()) as { committed: boolean; patches: unknown[] }
    expect(res.status).toBe(200)
    expect(body.committed).toBe(false)
    expect(body.patches).toEqual([])
  })

  it('checkout form values travel as forms, guards decide the state', async () => {
    const cookie = await session('/cart')
    await post(cookie, 'GET /cart', 'CartMachine', { type: 'ADD', sku: 'mudlark--kelp--40' })
    await post(cookie, 'GET /cart', 'CartMachine', { type: 'BEGIN_CHECKOUT' })
    const form = new URLSearchParams({ name: 'W', email: 'not-an-email' })
    await app.fetch(
      new Request('http://test/checkout/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
      }),
    )
    // Guard blocked the bad email: still on step 1.
    const page = await (
      await app.fetch(new Request('http://test/checkout', { headers: { Cookie: cookie } }))
    ).text()
    expect(page).toContain("Who's it for?")
  })
})
