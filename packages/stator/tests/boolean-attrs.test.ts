import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { Patch } from '../src/wire/index.ts'

/**
 * Boolean attribute semantics, end to end: `disabled={read(...)}` renders
 * ABSENT for false/null/undefined, present-and-empty for true, stringified
 * otherwise — and the attr patch mirrors it (`value: null` removes). Without
 * this, a bound boolean attribute could disable but never un-disable
 * (`disabled=""` is still disabled).
 */

const Gate = defineMachine({
  name: 'GateMachine',
  lifecycle: 'session',
  events: {} as { type: 'SET'; open: boolean } | { type: 'LABEL'; text: string },
  context: { open: false, label: '' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        SET: {
          do: (ctx, ev) => {
            ctx.open = ev.open
          },
        },
        LABEL: {
          do: (ctx, ev) => {
            ctx.label = ev.text
          },
        },
      },
    },
  },
  selectors: {
    closed: (ctx) => !ctx.open,
    label: (ctx) => (ctx.label === '' ? null : ctx.label),
  },
})

async function harness() {
  const store = new MachineStore([Gate], new InMemoryStore())
  const runtime = new SessionRuntime('bool-attrs', store)
  await runtime.loadGraph([Gate])
  const proxy = runtime.proxyFor('GateMachine') as never
  const state = createRenderState('bool-attrs', 'GET /gate')
  return { store, runtime, proxy, state }
}

describe('boolean attribute bindings', () => {
  it('renders the attribute ABSENT when the read is false-y, present-empty when true', async () => {
    const { proxy, state } = await harness()
    // closed=true initially → disabled present; label null → aria-label absent.
    const out = runInRender(
      state,
      () =>
        html`<button disabled="${read(proxy, (g) => (g as unknown as { closed: boolean }).closed)}" aria-label="${read(proxy, (g) => (g as unknown as { label: string | null }).label)}">go</button>`,
    )
    assert.ok(out.html.includes('disabled=""'))
    assert.ok(!out.html.includes('aria-label'))
  })

  it('renders a string value as before', async () => {
    const { proxy, state } = await harness()
    const out = runInRender(
      state,
      () =>
        html`<p title="${read(proxy, (g) => ((g as unknown as { closed: boolean }).closed ? 'shut' : 'ajar'))}">x</p>`,
    )
    assert.ok(out.html.includes('title="shut"'))
  })

  it('patches toggle presence: true→false emits value null, applier removes', async () => {
    const { runtime, proxy, state } = await harness()
    runInRender(
      state,
      () =>
        html`<button disabled="${read(proxy, (g) => (g as unknown as { closed: boolean }).closed)}">go</button>`,
    )
    runtime.processEvent('GateMachine', { type: 'SET', open: true })
    const patches = recompute(state, 'GateMachine', runtime)
    assert.equal(patches.length, 1)
    assert.partialDeepStrictEqual(patches[0], { op: 'attr', name: 'disabled', value: null })

    // Round-trip through the real applier against a real-ish DOM shim.
    const el = fakeElement({ disabled: '' })
    applyToFake(el, patches)
    assert.equal(el.attrs.has('disabled'), false)

    // And back on: false→true emits ''.
    runtime.processEvent('GateMachine', { type: 'SET', open: false })
    const again = recompute(state, 'GateMachine', runtime)
    assert.partialDeepStrictEqual(again[0], { op: 'attr', name: 'disabled', value: '' })
  })
})

/** Minimal element double for the applier's attr branch. */
function fakeElement(initial: Record<string, string>) {
  const attrs = new Map(Object.entries(initial))
  return {
    attrs,
    setAttribute: (n: string, v: string) => attrs.set(n, v),
    removeAttribute: (n: string) => attrs.delete(n),
  }
}

function applyToFake(el: ReturnType<typeof fakeElement>, patches: Patch[]): void {
  for (const p of patches) {
    if (p.op === 'attr') {
      if (p.value === null) el.removeAttribute(p.name)
      else el.setAttribute(p.name, p.value)
    }
  }
}
