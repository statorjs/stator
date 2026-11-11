import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

/**
 * The examples are what a new app is copied from, so they must not teach the
 * forgeable shape: an effect's completion, or a timer's event, that a browser
 * can post to `/__events` itself. Each session machine with an effect lists
 * those events `serverOnly`, and the wire refuses them.
 */

const here = dirname(fileURLToPath(import.meta.url))
const examples = resolve(here, '../../../examples')
const routesDir = resolve(here, 'fixtures/plain-route/routes')

async function send(
  app: StatorApp,
  cookie: string,
  machine: string,
  event: object,
): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/__events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stator-Route': 'GET /', Cookie: cookie },
      body: JSON.stringify({ machine, event }),
    }),
  )
}

const CASES: Array<[example: string, machine: string, events: object[]]> = [
  [
    'desksmith',
    'CheckoutMachine',
    [
      { type: 'CHARGE_OK', receipt: 'FREE-ORDER' },
      { type: 'CHARGE_FAILED', reason: 'x' },
      { type: 'CHARGE_TIMEOUT' },
    ],
  ],
  ['weather', 'SearchMachine', [{ type: 'RESULTS', query: 'x', results: [] }]],
  [
    'stockroom',
    'InventoryMachine',
    [
      { type: 'LOADED', rows: [] },
      { type: 'LOAD_FAILED', message: 'x' },
      { type: 'SAVE_OK', id: 'a', quantity: 1, version: 1 },
      { type: 'SAVE_CONFLICT', id: 'a', quantity: 1, version: 1 },
      { type: 'SAVE_FAILED', id: 'a', message: 'x' },
    ],
  ],
]

describe('examples: effect completions and timer events are server-only', () => {
  for (const [example, machine, events] of CASES) {
    it(`${example}: ${machine} refuses them from the wire`, async () => {
      const app = await createApp({
        machinesDir: resolve(examples, example, 'machines'),
        routesDir,
      })
      const cookie = `stator_sid=${crypto.randomUUID()}`
      for (const event of events) {
        const res = await send(app, cookie, machine, event)
        assert.equal(res.status, 403, JSON.stringify(event))
      }
    })
  }

  it('desksmith: a declined card cannot be turned into an order', async () => {
    const app = await createApp({ machinesDir: resolve(examples, 'desksmith/machines'), routesDir })
    const sid = crypto.randomUUID()
    const cookie = `stator_sid=${sid}`
    const ok = async (event: object): Promise<void> => {
      assert.equal((await send(app, cookie, 'CheckoutMachine', event)).status, 200)
    }
    await ok({ type: 'SET_FIELD', field: 'shippingName', value: 'A' })
    await ok({ type: 'SET_FIELD', field: 'shippingAddress', value: 'B' })
    await ok({ type: 'SUBMIT_SHIPPING' })
    // '0000' is the card the demo processor declines.
    await ok({ type: 'SET_FIELD', field: 'paymentLast4', value: '0000' })
    await ok({ type: 'SUBMIT_PAYMENT' })
    const forged = await send(app, cookie, 'CheckoutMachine', {
      type: 'CHARGE_OK',
      receipt: 'FREE',
    })
    assert.equal(forged.status, 403)

    await new Promise((r) => setTimeout(r, 900))
    const snap = (await app.store.persistence.get(sid, 'CheckoutMachine')) as {
      value: string[]
      context: { orderNumber: string }
    }
    assert.deepEqual(snap.value, ['payment'])
    assert.ok(!snap.context.orderNumber)
  })
})
