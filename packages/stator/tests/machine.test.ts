import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

describe('MachineStore + SessionRuntime', () => {
  it('builds an app-lifecycle machine and exposes selectors via the proxy', () => {
    const ProductsMachine = defineMachine({
      name: 'ProductsMachine',
      lifecycle: 'app',
      context: { products: [{ id: 'p1', name: 'Notebook', price: 12 }] },
      initial: 'ready',
      states: { ready: {} },
      selectors: {
        all: (ctx) => ctx.products,
        byId: (ctx) => (id: string) => ctx.products.find((p) => p.id === id),
      },
    })

    const store = new MachineStore([ProductsMachine], new InMemoryStore())
    store.bootAppMachines()
    const instance = store.appInstance('ProductsMachine')!.proxy as any

    expect(instance.all).toEqual([{ id: 'p1', name: 'Notebook', price: 12 }])
    expect(instance.byId('p1')).toEqual({ id: 'p1', name: 'Notebook', price: 12 })
    expect(instance.byId('nope')).toBeUndefined()
  })

  it('hydrates a transient session actor from the Store, processes an event, and persists back', async () => {
    type CartItem = { productId: string; quantity: number; unitPrice: number }
    type CartContext = { items: CartItem[] }

    type CartEvents =
      | { type: 'ADD_ITEM'; productId: string; unitPrice: number }
      | { type: 'REMOVE_ITEM'; productId: string }

    const CartMachine = defineMachine({
      name: 'CartMachine',
      lifecycle: 'session',
      events: {} as CartEvents,
      emits: ['ITEM_ADDED'],
      context: { items: [] } as CartContext,
      initial: 'idle',
      states: {
        idle: {
          on: {
            ADD_ITEM: {
              do: (ctx, ev) => {
                const existing = ctx.items.find((i) => i.productId === ev.productId)
                if (existing) existing.quantity += 1
                else
                  ctx.items.push({ productId: ev.productId, quantity: 1, unitPrice: ev.unitPrice })
              },
              emit: 'ITEM_ADDED',
            },
            REMOVE_ITEM: (ctx, ev) => {
              ctx.items = ctx.items.filter((i) => i.productId !== ev.productId)
            },
          },
        },
      },
      selectors: {
        itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
        total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
        contains: (ctx) => (id: string) => ctx.items.some((i) => i.productId === id),
      },
    })

    const persistence = new InMemoryStore()
    const store = new MachineStore([CartMachine], persistence)
    store.bootAppMachines()

    // First "request" — initial state, one ADD, persist.
    {
      const runtime = new SessionRuntime('session-a', store)
      try {
        await runtime.loadGraph([CartMachine])
        const cart = runtime.proxyFor('CartMachine') as any
        expect(cart.itemCount).toBe(0)

        const touched = runtime.processEvent('CartMachine', {
          type: 'ADD_ITEM',
          productId: 'p1',
          unitPrice: 12,
        })
        expect([...touched]).toEqual(['CartMachine'])
        expect(cart.itemCount).toBe(1)

        await runtime.persistTouched(touched)
      } finally {
        runtime.dispose()
      }
    }

    // Verify the Store has the persisted snapshot.
    expect(await persistence.has('session-a', 'CartMachine')).toBe(true)

    // Second "request" — fresh runtime, hydrated from Store, state survives.
    {
      const runtime = new SessionRuntime('session-a', store)
      try {
        await runtime.loadGraph([CartMachine])
        const cart = runtime.proxyFor('CartMachine') as any
        expect(cart.itemCount).toBe(1)
        expect(cart.total).toBe(12)
        expect(cart.contains('p1')).toBe(true)
      } finally {
        runtime.dispose()
      }
    }
  })

  it('isolates session state per sessionId', async () => {
    const CartMachine = defineMachine({
      name: 'CartMachine',
      lifecycle: 'session',
      events: {} as { type: 'ADD'; id: string },
      context: { items: [] as { id: string }[] },
      initial: 'idle',
      states: {
        idle: {
          on: {
            ADD: (ctx, ev) => {
              ctx.items.push({ id: ev.id })
            },
          },
        },
      },
      selectors: { count: (ctx) => ctx.items.length },
    })

    const store = new MachineStore([CartMachine], new InMemoryStore())

    const ra = new SessionRuntime('a', store)
    const rb = new SessionRuntime('b', store)
    try {
      await ra.loadGraph([CartMachine])
      await rb.loadGraph([CartMachine])
      const touched = ra.processEvent('CartMachine', { type: 'ADD', id: 'x' })
      await ra.persistTouched(touched)
      expect((ra.proxyFor('CartMachine') as any).count).toBe(1)
      expect((rb.proxyFor('CartMachine') as any).count).toBe(0)
    } finally {
      ra.dispose()
      rb.dispose()
    }
  })
})
