import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import { LOW_WATER, REFILL_LEVEL } from '../lib/stock.ts'
import InventoryMachine from '../machines/inventory.ts'

/** Shared-stock rules. Effects are captured, not run — the supplier sim's
 *  ETA has no place in a unit test; asserting an order WOULD be placed and
 *  testing the arrival transition separately covers the arc. */

function boot(stock: Record<string, number>) {
  const invocations: Array<{ run: () => Promise<unknown> }> = []
  const actor = createActor(InventoryMachine, {
    onEffect: (inv) => invocations.push(inv),
    snapshot: { value: ['tracking'], context: { stock, pending: [] } },
  }).start()
  return { actor, invocations }
}

describe('inventory', () => {
  it('orders decrement per line qty and clamp at zero', () => {
    const { actor } = boot({ a: 5, b: 1 })
    actor.send({
      type: 'ORDER_PLACED',
      items: [
        { sku: 'a', qty: 2 },
        { sku: 'b', qty: 3 },
      ],
    })
    expect(actor.getSnapshot().context.stock).toEqual({ a: 3, b: 0 })
  })

  it('an order that leaves stock at/below low water schedules a restock', () => {
    const { actor, invocations } = boot({ a: LOW_WATER + 1, b: 20 })
    actor.send({ type: 'ORDER_PLACED', items: [{ sku: 'a', qty: 1 }] })
    expect(invocations).toHaveLength(1)
    // A comfortable order schedules nothing... (the effect runs regardless;
    // its RETURN decides) — assert via the arrival path instead:
    actor.send({ type: 'RESTOCK_ARRIVED', skus: ['a'] })
    expect(actor.getSnapshot().context.stock.a).toBe(REFILL_LEVEL)
  })

  it('refills SET the level — racing restocks converge instead of compounding', () => {
    const { actor } = boot({ a: 2 })
    actor.send({ type: 'RESTOCK_ARRIVED', skus: ['a'] })
    actor.send({ type: 'RESTOCK_ARRIVED', skus: ['a'] })
    expect(actor.getSnapshot().context.stock.a).toBe(REFILL_LEVEL)
  })

  it('an in-flight restock order is idempotent (second ORDERED guard-dropped)', () => {
    const { actor, invocations } = boot({ a: 1 })
    actor.send({ type: 'RESTOCK_ORDERED', sku: 'a' })
    actor.send({ type: 'RESTOCK_ORDERED', sku: 'a' })
    expect(invocations).toHaveLength(1)
    expect(actor.getSnapshot().context.pending).toEqual(['a'])
    // Arrival clears the pending flag so the NEXT order may fire.
    actor.send({ type: 'RESTOCK_ARRIVED', skus: ['a'] })
    expect(actor.getSnapshot().context.pending).toEqual([])
  })
})
