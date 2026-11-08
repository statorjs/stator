import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor } from '@statorjs/stator/machine'
import { CARD_TOKENS } from '../lib/payments.ts'
import CartMachine from '../machines/cart.ts'

/**
 * The manifest's rules, tested the way the testing guide teaches: events in,
 * state out, no DOM, no server. Cross-machine reads (the stock ceiling) are
 * INJECTED — a unit test picks the shared stock it wants to test against.
 */

const withStock = (stock: Record<string, number>) => ({
  resolveHelpers: () => ({ reads: { InventoryMachine: { stock } } }),
})

const KELP42 = 'the-longshore--kelp--42'

describe('cart line rules', () => {
  it('rejects a hostile SKU outright', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 5 })).start()
    actor.send({ type: 'ADD', sku: 'fake--nope--99' })
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [])
  })

  it('enforces the stock ceiling on ADD and INCREMENT', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 2 })).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'ADD', sku: KELP42 }) // 3rd: guard-dropped
    actor.send({ type: 'INCREMENT', sku: KELP42 }) // also dropped
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [{ sku: KELP42, qty: 2 }])
  })

  it('DECREMENT at qty 1 removes the line', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 5 })).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'DECREMENT', sku: KELP42 })
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [])
  })

  it('line ops reach every checkout step via the machine-level fallback', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 5 })).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'BEGIN_CHECKOUT' })
    actor.send({ type: 'ADD', sku: KELP42 }) // in 'contact' — no state-scoped handler
    assert.deepStrictEqual(actor.getSnapshot().value, ['contact'])
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [{ sku: KELP42, qty: 2 }])
  })

  it('the manifest is frozen while the charge settles', () => {
    const actor = createActor(CartMachine, {
      ...withStock({ [KELP42]: 5 }),
      snapshot: {
        value: ['submitting'],
        context: {
          lines: [{ sku: KELP42, qty: 1 }],
          name: 'W',
          email: 'w@example.harbor',
          address: '3 Quay Lane',
          port: 'Gullhaven',
          error: '',
          lastOrder: null,
        },
      },
    }).start()
    actor.send({ type: 'ADD', sku: KELP42 }) // shadowed: never-guard drops it
    actor.send({ type: 'CLEAR' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['submitting'])
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [{ sku: KELP42, qty: 1 }])
  })
})

describe('checkout flow', () => {
  const stocked = withStock({ [KELP42]: 5 })

  it('refuses to begin with an empty manifest', () => {
    const actor = createActor(CartMachine, stocked).start()
    actor.send({ type: 'BEGIN_CHECKOUT' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['open'])
  })

  it('guards contact on a plausible email', () => {
    const actor = createActor(CartMachine, stocked).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'BEGIN_CHECKOUT' })
    actor.send({ type: 'SET_CONTACT', name: 'W', email: 'not-an-email' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['contact'])
    actor.send({ type: 'SET_CONTACT', name: 'W', email: 'w@example.harbor' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['shipping'])
  })

  it('a declined charge lands back in review with the reason', async () => {
    const invocations: Array<{ run: () => Promise<unknown> }> = []
    const actor = createActor(CartMachine, {
      ...stocked,
      onEffect: (inv) => invocations.push(inv),
    }).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'BEGIN_CHECKOUT' })
    actor.send({ type: 'SET_CONTACT', name: 'W', email: 'w@example.harbor' })
    actor.send({ type: 'SET_SHIPPING', address: '3 Quay Lane', port: 'Gullhaven' })
    actor.send({ type: 'SUBMIT', token: CARD_TOKENS.declined })
    assert.deepStrictEqual(actor.getSnapshot().value, ['submitting']) // instant commit
    assert.equal(invocations.length, 1) // the charge was scheduled...

    const completion = await invocations[0]!.run() // ...run it when WE choose
    actor.send(completion as never)
    assert.deepStrictEqual(actor.getSnapshot().value, ['review'])
    assert.ok(actor.getSnapshot().context.error.includes('Kraken'))
  })

  it('an approved charge confirms, records the order, clears the manifest', async () => {
    const invocations: Array<{ run: () => Promise<unknown> }> = []
    const actor = createActor(CartMachine, {
      ...stocked,
      onEffect: (inv) => invocations.push(inv),
      snapshot: {
        value: ['review'],
        context: {
          lines: [{ sku: KELP42, qty: 2 }],
          name: 'W',
          email: 'w@example.harbor',
          address: '3 Quay Lane',
          port: 'Gullhaven',
          error: '',
          lastOrder: null,
        },
      },
    }).start()
    actor.send({ type: 'SUBMIT', token: CARD_TOKENS.ok })
    const completion = await invocations[0]!.run()
    actor.send(completion as never)

    const ctx = actor.getSnapshot().context
    assert.deepStrictEqual(actor.getSnapshot().value, ['confirmed'])
    assert.deepStrictEqual(ctx.lines, [])
    assert.equal(ctx.lastOrder?.amountCents, 15600) // 2 × $78, server-computed
    assert.ok(ctx.lastOrder)
    assert.ok(ctx.lastOrder.summary.includes('The Longshore'))
  })

  it('SUBMIT re-checks stock: a shortage stays in review with a named error', () => {
    const actor = createActor(CartMachine, {
      ...withStock({ [KELP42]: 1 }), // stock moved under the manifest
      snapshot: {
        value: ['review'],
        context: {
          lines: [{ sku: KELP42, qty: 2 }],
          name: 'W',
          email: 'w@example.harbor',
          address: 'Q',
          port: 'Gullhaven',
          error: '',
          lastOrder: null,
        },
      },
    }).start()
    actor.send({ type: 'SUBMIT', token: CARD_TOKENS.ok })
    assert.deepStrictEqual(actor.getSnapshot().value, ['review'])
    assert.ok(actor.getSnapshot().context.error.includes('The Longshore'))
  })

  it('ADD after confirmation starts the next manifest', () => {
    const actor = createActor(CartMachine, {
      ...stocked,
      snapshot: {
        value: ['confirmed'],
        context: {
          lines: [],
          name: 'W',
          email: 'w@example.harbor',
          address: 'Q',
          port: 'Gullhaven',
          error: '',
          lastOrder: { receiptId: 'rcpt_x', amountCents: 100, summary: 'x' },
        },
      },
    }).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    assert.deepStrictEqual(actor.getSnapshot().value, ['open'])
    assert.deepStrictEqual(actor.getSnapshot().context.lines, [{ sku: KELP42, qty: 1 }])
    assert.equal(actor.getSnapshot().context.lastOrder, null)
  })
})
