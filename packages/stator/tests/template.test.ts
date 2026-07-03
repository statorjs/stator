import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { createRenderState, type RenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { on } from '../src/template/directives/on.ts'
import { each, renderListBody } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'

function makeCart() {
  type Item = { productId: string; quantity: number; unitPrice: number }
  type Events =
    | { type: 'ADD'; productId: string; unitPrice: number }
    | { type: 'REMOVE'; productId: string }
    | { type: 'SET_QTY'; productId: string; quantity: number }
  return defineMachine({
    name: 'CartMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { items: [] as Item[] },
    initial: 'idle',
    states: {
      idle: {
        on: {
          ADD: (ctx, ev) => {
            const ex = ctx.items.find((i) => i.productId === ev.productId)
            if (ex) ex.quantity += 1
            else
              ctx.items.push({
                productId: ev.productId,
                quantity: 1,
                unitPrice: ev.unitPrice,
              })
          },
          REMOVE: (ctx, ev) => {
            ctx.items = ctx.items.filter((i) => i.productId !== ev.productId)
          },
          SET_QTY: (ctx, ev) => {
            const it = ctx.items.find((i) => i.productId === ev.productId)
            if (it) it.quantity = ev.quantity
          },
        },
      },
    },
    selectors: {
      items: (ctx) => ctx.items,
      itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
      total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
      contains: (ctx) => (id: string) => ctx.items.some((i) => i.productId === id),
    },
  })
}

async function buildRuntime(): Promise<{
  runtime: SessionRuntime
  cart: InstanceOf<ReturnType<typeof makeCart>>
  state: RenderState
  Cart: ReturnType<typeof makeCart>
}> {
  const Cart = makeCart()
  const store = new MachineStore([Cart], new InMemoryStore())
  store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([Cart])
  const cart = runtime.proxyFor('CartMachine') as InstanceOf<ReturnType<typeof makeCart>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, cart, state, Cart }
}

describe('html templating', () => {
  it('renders a text-position read with a slot span', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      const out = runInRender(state, () => html`<p>Items: ${read(cart, (c) => c.itemCount)}</p>`)
      expect(out.html).toBe('<p>Items: <span data-slot="s0">0</span></p>')
      expect(state.bindings.size).toBe(1)
      const b = state.bindings.get('s0')!
      expect(b.kind).toBe('text')
      expect(b.machineName).toBe('CartMachine')
      expect(b.lastValue).toBe(0)
    } finally {
      runtime.dispose()
    }
  })

  it('renders an attr-value read with a stator id on the parent', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      const out = runInRender(
        state,
        () => html`<button class="${read(cart, (c) => (c.contains('p1') ? 'in' : ''))}">x</button>`,
      )
      expect(out.html).toContain('data-stator-id="e0"')
      expect(out.html).toContain('class=""')
      const b = state.bindings.get('s0')!
      expect(b.kind).toBe('attr')
      if (b.kind !== 'attr') throw new Error('expected attr binding')
      expect(b.attrName).toBe('class')
      expect(b.parentId).toBe('e0')
    } finally {
      runtime.dispose()
    }
  })

  it('attaches an on() directive to its parent as data-event-click', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      const out = runInRender(
        state,
        () =>
          html`<button ${on('click', () => cart.send({ type: 'ADD', productId: 'p1', unitPrice: 5 }))}>Add</button>`,
      )
      expect(out.html).toContain('data-stator-id="e0"')
      expect(out.html).toContain('data-event-click="')
      expect(out.html).toContain('CartMachine')
      expect(out.html).toContain('ADD')
      expect(out.html).toContain('p1')
    } finally {
      runtime.dispose()
    }
  })

  it('each() registers a list binding when given a read', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p1',
        unitPrice: 5,
      })
      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p2',
        unitPrice: 7,
      })

      const out = runInRender(
        state,
        () =>
          html`<ul>${each(
            read(cart, (c) => c.items as Array<{ productId: string; quantity: number }>),
            (item) => html`<li>${item.productId} x${item.quantity}</li>`,
          )}</ul>`,
      )
      expect(out.html).toMatch(
        /<ul><span data-slot="s0" data-list="true" style="display:contents">.*<\/span><\/ul>/,
      )
      expect(out.html).toContain('<li>p1 x1</li>')
      expect(out.html).toContain('<li>p2 x1</li>')
      const listBinding = state.bindings.get('s0')!
      expect(listBinding.kind).toBe('list')
      if (listBinding.kind !== 'list') throw new Error('expected list binding')
      expect(listBinding.machineName).toBe('CartMachine')
      expect(listBinding.itemRenderer).toBeTypeOf('function')
    } finally {
      runtime.dispose()
    }
  })

  it('a recompute-like loop produces a text patch when a selector value changes', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      const fragment = runInRender(
        state,
        () => html`<header>Cart: ${read(cart, (c) => c.itemCount)}</header>`,
      )
      expect(fragment.html).toContain('<span data-slot="s0">0</span>')

      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p1',
        unitPrice: 5,
      })

      const patches: Array<{ slot: string; value?: unknown }> = []
      const slotIds = state.byMachine.get('CartMachine') ?? new Set()
      for (const slotId of slotIds) {
        const b = state.bindings.get(slotId)!
        const newValue = b.selector(cart)
        if (b.kind === 'text' && newValue !== b.lastValue) {
          patches.push({ slot: slotId, value: newValue })
          b.lastValue = newValue
        }
      }
      expect(patches).toEqual([{ slot: 's0', value: 1 }])
    } finally {
      runtime.dispose()
    }
  })

  it('list re-render after item added', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p1',
        unitPrice: 5,
      })

      runInRender(
        state,
        () =>
          html`<ul>${each(
            read(cart, (c) => c.items as Array<{ productId: string; quantity: number }>),
            (item, idx) =>
              html`<li>${item.productId} qty=${read(cart, (c) => c.items[idx]?.quantity ?? 0)}</li>`,
          )}</ul>`,
      )
      expect(state.bindings.has('s0:i0:s0')).toBe(true)

      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p2',
        unitPrice: 7,
      })

      const listBinding = state.bindings.get('s0')!
      expect(listBinding.kind).toBe('list')
      if (listBinding.kind !== 'list') throw new Error('expected list binding')
      const newItems = listBinding.selector(cart) as any[]
      expect(newItems.length).toBe(2)
      const newInner = runInRender(state, () =>
        renderListBody(state, 's0', newItems, listBinding.itemRenderer),
      )
      expect(newInner).toContain('p1 qty=')
      expect(newInner).toContain('p2 qty=')
      expect(state.bindings.has('s0:i1:s0')).toBe(true)
    } finally {
      runtime.dispose()
    }
  })
})
