import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { classList } from '../src/template/directives/list-attr.ts'
import { spreadAttrs } from '../src/template/directives/spread.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'

/**
 * `{...spread}` on an element (compiled to `${spreadAttrs(bag)}`). Static values
 * render with the shared boolean/url semantics; a machine `read(...)` in the bag
 * becomes the SAME live attr binding a direct `attr={read(...)}` would — so it
 * patches on machine events with no separate wire. Item reads and directive
 * invocations are rejected loudly (the deferred + nonsensical cases).
 */

const Toggle = defineMachine({
  name: 'ToggleMachine',
  lifecycle: 'session',
  events: {} as { type: 'FLIP'; on: boolean },
  context: { on: true },
  initial: 'idle',
  states: {
    idle: {
      on: {
        FLIP: {
          do: (ctx, ev) => {
            ctx.on = ev.on
          },
        },
      },
    },
  },
  selectors: { busy: (ctx) => ctx.on },
})

async function harness() {
  const store = new MachineStore([Toggle], new InMemoryStore())
  const runtime = new SessionRuntime('spread', store)
  await runtime.loadGraph([Toggle])
  const proxy = runtime.proxyFor('ToggleMachine') as never
  const state = createRenderState('spread', 'GET /x')
  return { runtime, proxy, state }
}

describe('element spread ({...} → spreadAttrs)', () => {
  it('spreads static values with boolean + url semantics', () => {
    const state = createRenderState('spread-static', 'GET /x')
    const out = runInRender(
      state,
      () =>
        html`<a ${spreadAttrs({
          target: '_blank',
          hidden: false,
          draggable: true,
          'data-id': '7',
          href: 'javascript:alert(1)',
        })}>x</a>`,
    )
    assert.ok(out.html.includes('target="_blank"'))
    assert.ok(out.html.includes('data-id="7"'))
    assert.ok(out.html.includes('draggable=""')) // true → present-and-empty
    assert.ok(!out.html.includes('hidden')) // false → absent
    assert.ok(!out.html.includes('javascript:')) // url-bearing name scheme-guarded
  })

  it('a machine read in a spread bag is a live attr binding and patches on events', async () => {
    const { runtime, proxy, state } = await harness()
    const out = runInRender(
      state,
      () =>
        html`<button ${spreadAttrs({
          disabled: read(proxy, (t) => (t as unknown as { busy: boolean }).busy),
        })}>go</button>`,
    )
    assert.ok(out.html.includes('disabled=""')) // busy=true initially → present

    runtime.processEvent('ToggleMachine', { type: 'FLIP', on: false }) // busy → false
    const patches = recompute(state, 'ToggleMachine', runtime)
    assert.equal(patches.length, 1)
    assert.partialDeepStrictEqual(patches[0], { op: 'attr', name: 'disabled', value: null }) // removed
  })

  it('rejects an item read forwarded through a spread, naming the direct-bind fix', () => {
    const state = createRenderState('spread-item', 'GET /x')
    // The shape isItemReadResult recognizes — what the compiler lowers a
    // read(item, …) to. Forwarding it through a spread is the deferred case.
    const itemRead = { __isItemRead: true, selector: () => 'x', value: 'x' }
    assert.throws(
      () =>
        runInRender(state, () => html`<button ${spreadAttrs({ disabled: itemRead })}>go</button>`),
      /read\(item, …\) can't be forwarded through/,
    )
  })

  it('rejects a directive invocation as a spread value', () => {
    const state = createRenderState('spread-directive', 'GET /x')
    assert.throws(
      () =>
        runInRender(
          state,
          () => html`<button ${spreadAttrs({ class: classList('a') })}>go</button>`,
        ),
      /a directive .* can't be a/,
    )
  })
})
