import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
  await store.bootAppMachines()
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([Cart])
  const cart = runtime.proxyFor('CartMachine') as InstanceOf<ReturnType<typeof makeCart>>
  const state = createRenderState('s1', 'GET /')
  return { runtime, cart, state, Cart }
}

describe('html templating', () => {
  it('plain attr values use boolean-absent semantics, matching the binding paths', async () => {
    const { state, runtime } = await buildRuntime()
    try {
      // false/null/undefined → attribute ABSENT; true → present-and-empty.
      // Previously `checked="${false}"` rendered `checked="false"` — a
      // PRESENT boolean attribute, i.e. a checkbox that can never render
      // unchecked (found by the registration starter's opt-in checkbox).
      const out = runInRender(
        state,
        () =>
          html`<input type="checkbox" checked="${false}" disabled="${null}" data-x="${undefined}" required="${true}" data-n="${3}" />`,
      )
      assert.ok(!out.html.includes('checked'))
      assert.ok(!out.html.includes('disabled'))
      assert.ok(!out.html.includes('data-x'))
      assert.match(out.html, /required(=""| |\/|>)/)
      assert.ok(out.html.includes('data-n="3"'))
    } finally {
      runtime.dispose()
    }
  })

  it('renders a text-position read with a slot span', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      const out = runInRender(state, () => html`<p>Items: ${read(cart, (c) => c.itemCount)}</p>`)
      assert.equal(out.html, '<p>Items: <span data-slot="s0">0</span></p>')
      assert.equal(state.bindings.size, 1)
      const b = state.bindings.get('s0')!
      assert.equal(b.kind, 'text')
      assert.equal(b.machineName, 'CartMachine')
      assert.equal(b.lastValue, 0)
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
      assert.ok(out.html.includes('data-stator-id="e0"'))
      assert.ok(out.html.includes('class=""'))
      const b = state.bindings.get('s0')!
      assert.equal(b.kind, 'attr')
      if (b.kind !== 'attr') throw new Error('expected attr binding')
      assert.equal(b.attrName, 'class')
      assert.equal(b.parentId, 'e0')
    } finally {
      runtime.dispose()
    }
  })

  it('refuses an on() event the page runtime does not deliver, naming the ones it does', async () => {
    const { cart, state, runtime } = await buildRuntime()
    try {
      assert.throws(
        () =>
          runInRender(
            state,
            () =>
              html`<input ${on('keydown', () => cart.send({ type: 'ADD', productId: 'p1', unitPrice: 5 }))} />`,
          ),
        /on:keydown is not an event a server template can bind.*on:click, on:dblclick.*client island/s,
      )
      const out = runInRender(
        state,
        () =>
          html`<label ${on('dblclick', () => cart.send({ type: 'ADD', productId: 'p1', unitPrice: 5 }))}>x</label>`,
      )
      assert.ok(out.html.includes('data-event-dblclick="'))
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
      assert.ok(out.html.includes('data-stator-id="e0"'))
      assert.ok(out.html.includes('data-event-click="'))
      assert.ok(out.html.includes('CartMachine'))
      assert.ok(out.html.includes('ADD'))
      assert.ok(out.html.includes('p1'))
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
      assert.match(out.html, /<ul><!--s:s0-->.*<!--\/s:s0--><\/ul>/)
      assert.ok(out.html.includes('<li>p1 x1</li>'))
      assert.ok(out.html.includes('<li>p2 x1</li>'))
      const listBinding = state.bindings.get('s0')!
      assert.equal(listBinding.kind, 'list')
      if (listBinding.kind !== 'list') throw new Error('expected list binding')
      assert.equal(listBinding.machineName, 'CartMachine')
      assert.equal(typeof listBinding.itemRenderer, 'function')
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
      assert.ok(fragment.html.includes('<span data-slot="s0">0</span>'))

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
      assert.deepStrictEqual(patches, [{ slot: 's0', value: 1 }])
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
      assert.equal(state.bindings.has('s0:i0:s0'), true)

      runtime.processEvent('CartMachine', {
        type: 'ADD',
        productId: 'p2',
        unitPrice: 7,
      })

      const listBinding = state.bindings.get('s0')!
      assert.equal(listBinding.kind, 'list')
      if (listBinding.kind !== 'list') throw new Error('expected list binding')
      const newItems = listBinding.selector(cart) as any[]
      assert.equal(newItems.length, 2)
      const { html: newInner } = runInRender(state, () =>
        renderListBody(state, 's0', newItems, listBinding.itemRenderer),
      )
      assert.ok(newInner.includes('p1 qty='))
      assert.ok(newInner.includes('p2 qty='))
      assert.equal(state.bindings.has('s0:i1:s0'), true)
    } finally {
      runtime.dispose()
    }
  })
})
