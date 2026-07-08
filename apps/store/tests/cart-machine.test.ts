import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
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
    expect(actor.getSnapshot().context.lines).toEqual([])
  })

  it('enforces the stock ceiling on ADD and INCREMENT', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 2 })).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'ADD', sku: KELP42 }) // 3rd: guard-dropped
    actor.send({ type: 'INCREMENT', sku: KELP42 }) // also dropped
    expect(actor.getSnapshot().context.lines).toEqual([{ sku: KELP42, qty: 2 }])
  })

  it('DECREMENT at qty 1 removes the line', () => {
    const actor = createActor(CartMachine, withStock({ [KELP42]: 5 })).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'DECREMENT', sku: KELP42 })
    expect(actor.getSnapshot().context.lines).toEqual([])
  })
})

describe('checkout flow', () => {
  const stocked = withStock({ [KELP42]: 5 })

  it('refuses to begin with an empty manifest', () => {
    const actor = createActor(CartMachine, stocked).start()
    actor.send({ type: 'BEGIN_CHECKOUT' })
    expect(actor.getSnapshot().value).toEqual(['open'])
  })

  it('guards contact on a plausible email', () => {
    const actor = createActor(CartMachine, stocked).start()
    actor.send({ type: 'ADD', sku: KELP42 })
    actor.send({ type: 'BEGIN_CHECKOUT' })
    actor.send({ type: 'SET_CONTACT', name: 'W', email: 'not-an-email' })
    expect(actor.getSnapshot().value).toEqual(['contact'])
    actor.send({ type: 'SET_CONTACT', name: 'W', email: 'w@example.harbor' })
    expect(actor.getSnapshot().value).toEqual(['shipping'])
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
    expect(actor.getSnapshot().value).toEqual(['submitting']) // instant commit
    expect(invocations).toHaveLength(1) // the charge was scheduled...

    const completion = await invocations[0]!.run() // ...run it when WE choose
    actor.send(completion as never)
    expect(actor.getSnapshot().value).toEqual(['review'])
    expect(actor.getSnapshot().context.error).toContain('Kraken')
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
    expect(actor.getSnapshot().value).toEqual(['confirmed'])
    expect(ctx.lines).toEqual([])
    expect(ctx.lastOrder?.amountCents).toBe(15600) // 2 × $78, server-computed
    expect(ctx.lastOrder?.summary).toContain('The Longshore')
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
    expect(actor.getSnapshot().value).toEqual(['review'])
    expect(actor.getSnapshot().context.error).toContain('The Longshore')
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
    expect(actor.getSnapshot().value).toEqual(['open'])
    expect(actor.getSnapshot().context.lines).toEqual([{ sku: KELP42, qty: 1 }])
    expect(actor.getSnapshot().context.lastOrder).toBeNull()
  })
})
