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
    expect(html).toContain('href="/p/') // a product card links to its PDP
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

  it('a forged CHARGE_APPROVED is hard-rejected: 403 (server-only), no fake settlement', async () => {
    // Unlike the restock above (an unhandled event → soft guard-drop 200), the
    // charge completions are declared `serverOnly` — a forged settlement is a
    // paid order without a charge, so the wire boundary rejects it outright.
    const cookie = await session('/cart')
    const res = await post(cookie, 'GET /cart', 'CartMachine', {
      type: 'CHARGE_APPROVED',
      receiptId: 'forged',
      amountCents: 0,
      summary: 'free stuff',
      items: [],
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/server-only/)
  })

  it('checkout form values travel as forms, guards decide the state', async () => {
    const cookie = await session('/cart')
    await post(cookie, 'GET /cart', 'CartMachine', { type: 'ADD', sku: 'mudlark--kelp--40' })
    await post(cookie, 'GET /cart', 'CartMachine', { type: 'BEGIN_CHECKOUT' })
    const form = new URLSearchParams({ name: 'W', email: 'not-an-email' })
    const submit = await app.fetch(
      new Request('http://test/checkout/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: form,
      }),
    )
    // The refused dispatch names the bounced step in the redirect…
    const directives = (await submit.json()) as { directives: Array<{ to: string }> }
    expect(directives.directives[0]?.to).toBe('/checkout?refused=contact')
    // …the guard kept the flow on step 1, and the page says why.
    const page = await (
      await app.fetch(
        new Request('http://test/checkout?refused=contact', { headers: { Cookie: cookie } }),
      )
    ).text()
    expect(page).toContain("Who's it for?")
    expect(page).toContain("That didn't clear")
  })
})
