import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'

/**
 * Reads-aware selectors: a machine's selectors receive the same `{ reads }`
 * helpers its guards get, so a cross-machine VERDICT ("can this cart take
 * one more, given shared stock?") can be projected as display state — and
 * bindings re-diff when the READ machine changes, via touched-set expansion
 * through the reverse-reads graph.
 */

const Stock = defineMachine({
  name: 'StockMachine',
  lifecycle: 'app',
  events: {} as { type: 'SET'; sku: string; qty: number },
  context: { stock: { widget: 2 } as Record<string, number> },
  initial: 'ready',
  states: {
    ready: {
      on: {
        SET: {
          do: (ctx, ev) => {
            ctx.stock[ev.sku] = ev.qty
          },
        },
      },
    },
  },
  selectors: { stock: (ctx) => ctx.stock },
})

const Basket = defineMachine({
  name: 'BasketMachine',
  lifecycle: 'session',
  events: {} as { type: 'ADD'; sku: string },
  reads: [Stock],
  context: { lines: {} as Record<string, number> },
  initial: 'open',
  states: {
    open: {
      on: {
        ADD: {
          do: (ctx, ev) => {
            ctx.lines[ev.sku] = (ctx.lines[ev.sku] ?? 0) + 1
          },
        },
      },
    },
  },
  selectors: {
    qty: (ctx) => (sku: string) => ctx.lines[sku] ?? 0,
    // The cross-machine verdict — the whole point of this feature.
    atCeiling:
      (ctx, { reads }) =>
      (sku: string) =>
        (ctx.lines[sku] ?? 0) >= (reads.StockMachine.stock[sku] ?? 0),
  },
})

async function harness() {
  const store = new MachineStore([Stock, Basket] as never, new InMemoryStore())
  await store.bootAppMachines()
  const runtime = new SessionRuntime('reads-sel', store)
  await runtime.loadGraph([Basket] as never)
  const basket = runtime.proxyFor('BasketMachine') as never
  return { store, runtime, basket }
}

describe('reads-aware selectors', () => {
  it('a selector consults the read machine live (session reads app)', async () => {
    const { store, runtime, basket } = await harness()
    const b = basket as { atCeiling: (sku: string) => boolean }
    expect(b.atCeiling('widget')).toBe(false) // 0 of 2
    runtime.processEvent('BasketMachine', { type: 'ADD', sku: 'widget' })
    runtime.processEvent('BasketMachine', { type: 'ADD', sku: 'widget' })
    expect(b.atCeiling('widget')).toBe(true) // 2 of 2
    // Stock moves out from under the basket — the verdict follows, live.
    store.appInstance('StockMachine')!.actor.send({ type: 'SET', sku: 'widget', qty: 5 } as never)
    expect(b.atCeiling('widget')).toBe(false) // 2 of 5
  })

  it('expandTouchedForRecompute walks the reverse-reads graph', async () => {
    const { store } = await harness()
    const { all, derived } = store.expandTouchedForRecompute(new Set(['StockMachine']))
    expect(all.has('BasketMachine')).toBe(true)
    expect(derived.has('BasketMachine')).toBe(true)
    expect(derived.has('StockMachine')).toBe(false)
  })

  it('a binding on the READING machine re-diffs when the READ machine changes', async () => {
    const { store, runtime, basket } = await harness()
    runtime.processEvent('BasketMachine', { type: 'ADD', sku: 'widget' })
    runtime.processEvent('BasketMachine', { type: 'ADD', sku: 'widget' })

    const state = createRenderState('reads-sel', 'GET /basket')
    const out = runInRender(
      state,
      () =>
        html`<button disabled="${read(basket, (b) => (b as { atCeiling: (s: string) => boolean }).atCeiling('widget'))}">+</button>`,
    )
    expect(out.html).toContain('disabled=""') // 2 of 2 at render

    // Touch ONLY the stock machine; expansion must re-diff the basket binding.
    store.appInstance('StockMachine')!.actor.send({ type: 'SET', sku: 'widget', qty: 9 } as never)
    const { all } = store.expandTouchedForRecompute(new Set(['StockMachine']))
    const patches = [...all].flatMap((name) => recompute(state, name, runtime))
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ op: 'attr', name: 'disabled', value: null })
  })
})
