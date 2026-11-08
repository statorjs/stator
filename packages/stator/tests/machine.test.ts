import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

describe('MachineStore + SessionRuntime', () => {
  it('builds an app-lifecycle machine and exposes selectors via the proxy', async () => {
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
    await store.bootAppMachines()
    const instance = store.appInstance('ProductsMachine')!.proxy as any

    assert.deepStrictEqual(instance.all, [{ id: 'p1', name: 'Notebook', price: 12 }])
    assert.deepStrictEqual(instance.byId('p1'), {
      id: 'p1',
      name: 'Notebook',
      price: 12,
    })
    assert.equal(instance.byId('nope'), undefined)
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
                  ctx.items.push({
                    productId: ev.productId,
                    quantity: 1,
                    unitPrice: ev.unitPrice,
                  })
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
    await store.bootAppMachines()

    // First "request" — initial state, one ADD, persist.
    {
      const runtime = new SessionRuntime('session-a', store)
      try {
        await runtime.loadGraph([CartMachine])
        const cart = runtime.proxyFor('CartMachine') as any
        assert.equal(cart.itemCount, 0)

        const touched = runtime.processEvent('CartMachine', {
          type: 'ADD_ITEM',
          productId: 'p1',
          unitPrice: 12,
        })
        assert.deepStrictEqual([...touched], ['CartMachine'])
        assert.equal(cart.itemCount, 1)

        await runtime.persistTouched(touched)
      } finally {
        runtime.dispose()
      }
    }

    // Verify the Store has the persisted snapshot.
    assert.equal(await persistence.has('session-a', 'CartMachine'), true)

    // Second "request" — fresh runtime, hydrated from Store, state survives.
    {
      const runtime = new SessionRuntime('session-a', store)
      try {
        await runtime.loadGraph([CartMachine])
        const cart = runtime.proxyFor('CartMachine') as any
        assert.equal(cart.itemCount, 1)
        assert.equal(cart.total, 12)
        assert.equal(cart.contains('p1'), true)
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
      assert.equal((ra.proxyFor('CartMachine') as any).count, 1)
      assert.equal((rb.proxyFor('CartMachine') as any).count, 0)
    } finally {
      ra.dispose()
      rb.dispose()
    }
  })
})
