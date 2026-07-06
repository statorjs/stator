// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defineElement, StatorElement } from '../src/client/element.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { clientShellAttrs } from '../src/template/client-shell.ts'
import { read } from '../src/template/read.ts'

/**
 * The sanctioned channel for live server state flowing INTO an island:
 * a read() passed as an island prop becomes a live attr binding (server
 * side), and the island's declared attrs are observed — a change invokes
 * `${key}Changed(coerced)` (client side).
 */

describe('island live attrs', () => {
  it('declared attrs are observed; changes invoke coerced ${key}Changed', async () => {
    class StockWatcher extends StatorElement {
      static attrs = { stock: Number, tag: String }
      static seen: unknown[] = []
      stockChanged(next: unknown) {
        StockWatcher.seen.push(next)
      }
    }
    defineElement(StockWatcher as never, 'stock-watcher')
    const el = document.createElement('stock-watcher')
    document.body.append(el)
    el.setAttribute('stock', '5')
    el.setAttribute('stock', '2')
    el.setAttribute('tag', 'x') // no tagChanged defined — must not throw
    expect(StockWatcher.seen).toEqual([5, 2])
  })

  it('a read() island prop renders as a live attr binding and patches', async () => {
    const Inv = defineMachine({
      name: 'InvMachine',
      lifecycle: 'app',
      events: {} as { type: 'SET'; qty: number },
      context: { qty: 3 },
      initial: 'ready',
      states: {
        ready: {
          on: {
            SET: {
              do: (ctx, ev) => {
                ctx.qty = ev.qty
              },
            },
          },
        },
      },
      selectors: { qty: (ctx) => ctx.qty },
    })
    const store = new MachineStore([Inv], new InMemoryStore())
    await store.bootAppMachines()
    const runtime = new SessionRuntime('live-attrs', store)
    await runtime.loadGraph([Inv])
    const inv = runtime.proxyFor('InvMachine') as never

    const state = createRenderState('live-attrs', 'GET /p')
    const attrs = runInRender(state, () =>
      clientShellAttrs(
        { stock: read(inv, (i) => String((i as unknown as { qty: number }).qty)) },
        { stock: 'string' },
      ),
    )
    expect(attrs).toContain('data-stator-id=')
    expect(attrs).toContain('stock="3"')

    store.appInstance('InvMachine')!.actor.send({ type: 'SET', qty: 9 } as never)
    const patches = recompute(state, 'InvMachine', runtime)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ op: 'attr', name: 'stock', value: '9' })
  })
})
