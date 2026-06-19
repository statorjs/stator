import { describe, it, expect } from 'vitest'
import { defineMachine, createActor } from '../src/engine/index.ts'

describe('engine: defineMachine + createActor', () => {
  it('runs inline actions with per-transition narrowing', () => {
    type Events =
      | { type: 'SET'; field: 'name' | 'city'; value: string }
      | { type: 'CLEAR' }

    const M = defineMachine({
      name: 'Form',
      lifecycle: 'session',
      events: {} as Events,
      context: { name: '', city: '' },
      initial: 'editing',
      states: {
        editing: {
          on: {
            // ev is narrowed to the SET member — ev.field / ev.value are typed
            SET: (ctx, ev) => { ctx[ev.field] = ev.value },
            CLEAR: (ctx) => { ctx.name = ''; ctx.city = '' },
          },
        },
      },
      selectors: {
        name: (ctx) => ctx.name,
        filled: (ctx) => ctx.name !== '' && ctx.city !== '',
      },
    })

    const a = createActor(M).start()
    a.send({ type: 'SET', field: 'name', value: 'Ada' })
    a.send({ type: 'SET', field: 'city', value: 'London' })

    expect(a.getSnapshot().context).toEqual({ name: 'Ada', city: 'London' })
    expect(M.selectors.filled!(a.getSnapshot().context)).toBe(true)

    a.send({ type: 'CLEAR' })
    expect(M.selectors.filled!(a.getSnapshot().context)).toBe(false)
  })

  it('honors guards and state transitions (checkout-shaped)', () => {
    type Events =
      | { type: 'SET_FIELD'; field: 'name' | 'card'; value: string }
      | { type: 'SUBMIT_SHIPPING' }
      | { type: 'SUBMIT_PAYMENT' }

    const Checkout = defineMachine({
      name: 'Checkout',
      lifecycle: 'session',
      events: {} as Events,
      context: { name: '', card: '' },
      initial: 'shipping',
      states: {
        shipping: {
          on: {
            SET_FIELD: (ctx, ev) => { ctx[ev.field] = ev.value },
            SUBMIT_SHIPPING: { to: 'payment', when: (ctx) => ctx.name.trim() !== '' },
          },
        },
        payment: {
          on: {
            SET_FIELD: (ctx, ev) => { ctx[ev.field] = ev.value },
            SUBMIT_PAYMENT: { to: 'complete', when: (ctx) => /^\d{4}$/.test(ctx.card) },
          },
        },
        complete: {},
      },
    })

    const a = createActor(Checkout).start()

    // Guard blocks: no name yet.
    a.send({ type: 'SUBMIT_SHIPPING' })
    expect(a.getSnapshot().value).toEqual(['shipping'])

    a.send({ type: 'SET_FIELD', field: 'name', value: 'Ada' })
    a.send({ type: 'SUBMIT_SHIPPING' })
    expect(a.getSnapshot().value).toEqual(['payment'])

    // Guard blocks: card not 4 digits.
    a.send({ type: 'SUBMIT_PAYMENT' })
    expect(a.getSnapshot().value).toEqual(['payment'])

    a.send({ type: 'SET_FIELD', field: 'card', value: '4242' })
    a.send({ type: 'SUBMIT_PAYMENT' })
    expect(a.getSnapshot().value).toEqual(['complete'])
  })

  it('fires declared emits with post-mutation payloads to on() listeners', () => {
    type Events = { type: 'ADD'; item: string }

    const Cart = defineMachine({
      name: 'Cart',
      lifecycle: 'session',
      events: {} as Events,
      emits: { ITEM_ADDED: { payload: (ctx) => ({ count: ctx.items.length }) } },
      context: { items: [] as string[] },
      initial: 'idle',
      states: {
        idle: {
          on: {
            ADD: { do: (ctx, ev) => { ctx.items.push(ev.item) }, emit: 'ITEM_ADDED' },
          },
        },
      },
    })

    const a = createActor(Cart).start()
    const seen: any[] = []
    a.on('ITEM_ADDED', (e) => seen.push(e))

    a.send({ type: 'ADD', item: 'pen' })
    a.send({ type: 'ADD', item: 'pad' })

    // Payload reflects post-mutation context (count after push).
    expect(seen).toEqual([
      { type: 'ITEM_ADDED', count: 1 },
      { type: 'ITEM_ADDED', count: 2 },
    ])
  })

  it('does not mutate the def context across actors (clone isolation)', () => {
    type Events = { type: 'INC' }
    const M = defineMachine({
      name: 'Counter',
      lifecycle: 'session',
      events: {} as Events,
      context: { n: 0 },
      initial: 'go',
      states: { go: { on: { INC: (ctx) => { ctx.n += 1 } } } },
    })

    const a = createActor(M).start()
    a.send({ type: 'INC' })
    a.send({ type: 'INC' })

    const b = createActor(M).start() // fresh actor, untouched initial context
    expect(a.getSnapshot().context.n).toBe(2)
    expect(b.getSnapshot().context.n).toBe(0)
    expect(M.context.n).toBe(0)
  })

  it('round-trips through a persisted snapshot (hydration)', () => {
    type Events = { type: 'INC' }
    const M = defineMachine({
      name: 'Counter',
      lifecycle: 'session',
      events: {} as Events,
      context: { n: 0 },
      initial: 'go',
      states: { go: { on: { INC: (ctx) => { ctx.n += 1 } } } },
    })

    const a = createActor(M).start()
    a.send({ type: 'INC' })
    a.send({ type: 'INC' })
    a.send({ type: 'INC' })
    const persisted = a.getPersistedSnapshot()

    // Re-hydrate a new actor (server: from Store; client: from seed).
    const b = createActor(M, { snapshot: persisted }).start()
    expect(b.getSnapshot().context.n).toBe(3)
    expect(b.getSnapshot().value).toEqual(['go'])
  })

  it('types helpers.reads from the inferred reads tuple (selectors preserved), and resolves through the injected resolver', () => {
    type Product = { id: string; price: number }

    const Products = defineMachine({
      name: 'ProductsMachine',
      lifecycle: 'app',
      context: { items: [{ id: 'p1', price: 12 }] as Product[] },
      initial: 'ready',
      states: { ready: {} },
      selectors: {
        byId: (ctx) => (id: string): Product | undefined =>
          ctx.items.find((p) => p.id === id),
      },
    })

    type Events = { type: 'ADD'; productId: string }

    const Cart = defineMachine({
      name: 'CartMachine',
      lifecycle: 'session',
      reads: [Products],
      events: {} as Events,
      context: { lines: [] as Array<{ id: string; price: number }> },
      initial: 'idle',
      states: {
        idle: {
          on: {
            ADD: (ctx, ev, { reads }) => {
              // reads.ProductsMachine is typed; byId(id) returns Product|undefined.
              const p = reads.ProductsMachine.byId(ev.productId)
              if (p) ctx.lines.push({ id: p.id, price: p.price })

              // @ts-expect-error — unknown read machine is a compile error
              reads.NopeMachine
            },
          },
        },
      },
    })

    // Runtime proof: wire the read resolver the way the server glue will.
    const productsActor = createActor(Products).start()
    const cart = createActor(Cart, {
      resolveHelpers: () => ({
        reads: {
          ProductsMachine: {
            byId: (id: string) =>
              productsActor.getSnapshot().context.items.find((p: Product) => p.id === id),
          },
        },
      }),
    }).start()

    cart.send({ type: 'ADD', productId: 'p1' })
    expect(cart.getSnapshot().context.lines).toEqual([{ id: 'p1', price: 12 }])
  })

  it('tags capabilities: reads-free is portable, reads make it server-pinned', () => {
    const Products = defineMachine({
      name: 'Products',
      lifecycle: 'app',
      context: { items: [] as string[] },
      initial: 'ready',
      states: { ready: {} },
    })
    const Cart = defineMachine({
      name: 'Cart',
      lifecycle: 'session',
      reads: [Products],
      context: { lines: [] as string[] },
      initial: 'idle',
      states: { idle: {} },
    })

    expect(Products.capabilities.serverPinned).toBe(false) // reads-free → portable
    expect(Cart.capabilities.serverPinned).toBe(true)
    expect(Cart.capabilities.reasons[0]).toContain('Products')
  })
})
