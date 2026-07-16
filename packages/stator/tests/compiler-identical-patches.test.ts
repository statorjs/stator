import { describe, expect, it } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import {
  classList,
  defer,
  each,
  html,
  match,
  on,
  read,
  styleList,
  when,
} from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/**
 * The Phase 3a gate: a compiled `.stator` template must produce byte-identical
 * HTML and byte-identical patches to the hand-written `html\`\`` equivalent,
 * through the real runtime. We evaluate the lowered `html\`\`` expression with
 * the runtime helpers + a live machine proxy in scope, render it next to the
 * hand-written reference, mutate the machine, and compare recompute output.
 */

function makeCart() {
  type Item = { id: string; qty: number }
  type Events = { type: 'ADD'; id: string } | { type: 'BUMP'; id: string }
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
            ctx.items.push({ id: ev.id, qty: 1 })
          },
          BUMP: (ctx, ev) => {
            const it = ctx.items.find((i) => i.id === ev.id)
            if (it) it.qty += 1
          },
        },
      },
    },
    selectors: {
      items: (ctx) => ctx.items,
      count: (ctx) => ctx.items.reduce((s, i) => s + i.qty, 0),
    },
  })
}

async function cartProxy() {
  const Cart = makeCart()
  const store = new MachineStore([Cart], new InMemoryStore())
  const runtime = new SessionRuntime('s1', store)
  await runtime.loadGraph([Cart])
  return { runtime, cart: runtime.proxyFor('CartMachine') as any }
}

/** Evaluate a lowered `html\`…\`` expression with the runtime + machine in scope. */
function evalLowered(htmlExpr: string, scope: Record<string, unknown>): HtmlFragment {
  const names = Object.keys(scope)
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `return (${htmlExpr})`)
  return fn(...names.map((n) => scope[n])) as HtmlFragment
}

describe('compiler: identical patches vs hand-written template', () => {
  it('matches HTML and patches for read + each + on + classList', async () => {
    const statorTemplate =
      '<div class="cart">' +
      '<span class="count">{read(cart, c => c.count)}</span>' +
      '<ul>{each(read(cart, c => c.items), (i) => ' +
      '<li class:list={{ line: true }}><button on:click={() => cart.send({ type: "BUMP", id: i.id })}>{i.id}: {i.qty}</button></li>)}</ul>' +
      '</div>'

    const handWritten = (cart: any): HtmlFragment =>
      html`<div class="cart"><span class="count">${read(cart, (c) => c.count)}</span><ul>${each(
        read(cart, (c) => c.items as any[]),
        (i: any) =>
          html`<li ${classList({ line: true })}><button ${on('click', () =>
            cart.send({ type: 'BUMP', id: i.id }),
          )}>${i.id}: ${i.qty}</button></li>`,
      )}</ul></div>`

    const lowered = lowerTemplate(statorTemplate)
    const scope = { html, read, each, when, match, defer, on, classList, styleList }

    // Two independent runtimes/render states so bindings don't collide.
    const a = await cartProxy()
    const b = await cartProxy()
    a.cart.send?.({ type: 'ADD', id: 'p1' }) // proxy.send during non-render = actor send
    b.cart.send?.({ type: 'ADD', id: 'p1' })

    const stateA = createRenderState('s1', 'GET /')
    const stateB = createRenderState('s1', 'GET /')

    const htmlA = runInRender(stateA, () => handWritten(a.cart)).html
    const htmlB = runInRender(stateB, () => evalLowered(lowered, { ...scope, cart: b.cart })).html

    expect(htmlB).toBe(htmlA)

    // Mutate both identically, then compare recompute patches.
    a.runtime.processEvent('CartMachine', { type: 'BUMP', id: 'p1' })
    b.runtime.processEvent('CartMachine', { type: 'BUMP', id: 'p1' })

    const patchesA = recompute(stateA, 'CartMachine', a.runtime)
    const patchesB = recompute(stateB, 'CartMachine', b.runtime)

    expect(patchesB).toEqual(patchesA)
    expect(patchesB.length).toBeGreaterThan(0)
  })
})
