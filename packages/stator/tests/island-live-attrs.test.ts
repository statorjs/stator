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
import { when } from '../src/template/conditional.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import { createHtmlFragment, type InstanceOf } from '../src/template/types.ts'
import { applyPatches } from '../src/wire/apply.ts'

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

  it('an island rendered inside a when-arm: arm-scoped shell id, attr patches target it after the arm renders, the element upgrades and reacts', async () => {
    // The shape the registration starter's inline edit form had: the island
    // exists only while an arm is open, so it is rendered by a branch flip over
    // the wire, not by the page's first render. Its shell id must be arm-scoped
    // (stable across re-renders of that arm), a later attr patch must address
    // that id, and the browser must upgrade the element the patch inserted.
    const Inv = defineMachine({
      name: 'ArmInv',
      lifecycle: 'app',
      events: {} as { type: 'SET'; qty: number } | { type: 'EDIT' },
      context: { qty: 3, editing: false },
      initial: 'ready',
      states: {
        ready: {
          on: {
            SET: {
              do: (ctx, ev) => {
                ctx.qty = ev.qty
              },
            },
            EDIT: (ctx) => {
              ctx.editing = true
            },
          },
        },
      },
      selectors: { qty: (ctx) => ctx.qty, editing: (ctx) => ctx.editing },
    })
    const store = new MachineStore([Inv], new InMemoryStore())
    await store.bootAppMachines()
    const runtime = new SessionRuntime('arm-island', store)
    await runtime.loadGraph([Inv])
    const inv = runtime.proxyFor('ArmInv') as InstanceOf<typeof Inv>

    class ArmWatcher extends StatorElement {
      static attrs = { stock: Number }
      static seen: unknown[] = []
      stockChanged(next: unknown) {
        ArmWatcher.seen.push(next)
      }
    }
    defineElement(ArmWatcher as never, 'arm-watcher')

    const state = createRenderState('arm-island', 'GET /p')
    const page = runInRender(
      state,
      () =>
        html`<main>${when(
          read(inv, (i) => i.editing),
          () =>
            createHtmlFragment(
              `<arm-watcher${clientShellAttrs({ stock: read(inv, (i) => String(i.qty)) }, { stock: 'string' })}></arm-watcher>`,
            ),
        )}</main>`,
    )
    expect(page.html).not.toContain('<arm-watcher')
    document.body.innerHTML = page.html

    // The arm opens over the wire: the island's shell arrives in the branch
    // patch with an arm-scoped id and the seed attr.
    store.appInstance('ArmInv')!.actor.send({ type: 'EDIT' } as never)
    const flip = recompute(state, 'ArmInv', runtime)
    const branch = flip.find((p) => p.op === 'html')
    expect(branch).toBeDefined()
    const shellId = /data-stator-id="([^"]+)"/.exec(String(branch!.value))?.[1]
    expect(shellId).toMatch(/:btrue:e\d+$/)
    expect(String(branch!.value)).toContain('stock="3"')

    applyPatches(flip)
    const el = document.querySelector('arm-watcher')
    expect(el).toBeInstanceOf(ArmWatcher)
    expect(el!.getAttribute('data-stator-id')).toBe(shellId)

    // A later change patches the attr at the arm-scoped id, and the upgraded
    // element observes it.
    store.appInstance('ArmInv')!.actor.send({ type: 'SET', qty: 9 } as never)
    const next = recompute(state, 'ArmInv', runtime)
    expect(next.find((p) => p.op === 'attr')).toMatchObject({
      op: 'attr',
      name: 'stock',
      value: '9',
      target: { kind: 'element', id: shellId },
    })
    applyPatches(next)
    expect(el!.getAttribute('stock')).toBe('9')
    expect(ArmWatcher.seen.at(-1)).toBe(9)
  })
})
