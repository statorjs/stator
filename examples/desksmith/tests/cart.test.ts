import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'

// CartMachine reads ProductsMachine to price a brand-new line, so we wire the
// same read resolver the server glue provides — backed by a real products
// actor, so unit prices come from the actual catalog seed (p1 = $12, p2 = $28).
const products = createActor(ProductsMachine).start()
const byId = (id: string) => ProductsMachine.selectors.byId(products.getSnapshot().context)(id)

const newCart = () =>
  createActor(CartMachine, {
    resolveHelpers: () => ({ reads: { ProductsMachine: { byId } } }),
  }).start()

const sel = CartMachine.selectors
const ctxOf = (a: ReturnType<typeof newCart>) => a.getSnapshot().context

describe('cart — adding items', () => {
  it('a first add creates a line priced from the catalog', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    const ctx = ctxOf(cart)
    expect(sel.items(ctx)).toEqual([{ productId: 'p1', quantity: 1, unitPrice: 12 }])
    expect(sel.contains(ctx)('p1')).toBe(true)
    expect(sel.isEmpty(ctx)).toBe(false)
  })

  it('re-adding the same product bumps quantity, not a second line', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    const ctx = ctxOf(cart)
    expect(sel.items(ctx)).toHaveLength(1)
    expect(sel.itemCount(ctx)).toBe(2)
  })

  it('itemCount and total aggregate across distinct lines', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' }) // $12
    cart.send({ type: 'ADD_ITEM', productId: 'p2' }) // $28
    cart.send({ type: 'ADD_ITEM', productId: 'p2' }) // +$28
    const ctx = ctxOf(cart)
    expect(sel.itemCount(ctx)).toBe(3)
    expect(sel.total(ctx)).toBe(12 + 28 * 2)
  })
})

describe('cart — quantity steppers', () => {
  it('INCREMENT raises the line quantity', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'INCREMENT', productId: 'p1' })
    expect(sel.itemCount(ctxOf(cart))).toBe(2)
  })

  it('DECREMENT of the last unit removes the whole line', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'DECREMENT', productId: 'p1' })
    expect(sel.isEmpty(ctxOf(cart))).toBe(true)
  })

  it('DECREMENT above one only lowers the quantity', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'ADD_ITEM', productId: 'p1' }) // qty 2
    cart.send({ type: 'DECREMENT', productId: 'p1' })
    const ctx = ctxOf(cart)
    expect(sel.itemCount(ctx)).toBe(1)
    expect(sel.isEmpty(ctx)).toBe(false)
  })
})

describe('cart — remove and clear', () => {
  it('REMOVE_ITEM drops the line outright', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'ADD_ITEM', productId: 'p2' })
    cart.send({ type: 'REMOVE_ITEM', productId: 'p1' })
    const ctx = ctxOf(cart)
    expect(sel.contains(ctx)('p1')).toBe(false)
    expect(sel.contains(ctx)('p2')).toBe(true)
  })

  it('CLEAR empties the cart', () => {
    const cart = newCart()
    cart.send({ type: 'ADD_ITEM', productId: 'p1' })
    cart.send({ type: 'ADD_ITEM', productId: 'p2' })
    cart.send({ type: 'CLEAR' })
    expect(sel.isEmpty(ctxOf(cart))).toBe(true)
  })
})
