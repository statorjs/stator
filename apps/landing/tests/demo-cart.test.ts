import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor } from '@statorjs/stator/machine'
import CartMachine from '../lib/demo-cart.ts'

describe('demo cart', () => {
  it('refuses to check out an empty cart', () => {
    const actor = createActor(CartMachine).start()
    actor.send({ type: 'CHECKOUT' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['idle'])
  })

  it('adds, stacks quantities, then checks out', () => {
    const actor = createActor(CartMachine).start()
    actor.send({ type: 'ADD', productId: 'p1' })
    actor.send({ type: 'ADD', productId: 'p1' })
    actor.send({ type: 'ADD', productId: 'p3' })
    assert.equal(CartMachine.selectors.count(actor.getSnapshot().context), 3)
    assert.equal(CartMachine.selectors.labelP1(actor.getSnapshot().context), 'In cart · 2')

    actor.send({ type: 'CHECKOUT' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['checking-out'])
  })

  it('ignores ADD while checking out, and BACK returns to idle', () => {
    const actor = createActor(CartMachine).start()
    actor.send({ type: 'ADD', productId: 'p2' })
    actor.send({ type: 'CHECKOUT' })
    actor.send({ type: 'ADD', productId: 'p2' })
    assert.equal(CartMachine.selectors.count(actor.getSnapshot().context), 1)

    actor.send({ type: 'BACK' })
    assert.deepStrictEqual(actor.getSnapshot().value, ['idle'])
  })
})
