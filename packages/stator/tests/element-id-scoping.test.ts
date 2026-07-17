// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { renderBranchBody, when } from '../src/template/conditional.ts'
import { each } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'

/**
 * Regression for FINDINGS #2 (spec: conditional-arm-interiors-are-second-class).
 * Element ids (`data-stator-id`, used for attr patches, `on:` handlers, and
 * islands) must be scoped by the arm/list they render in — exactly like slot
 * ids — so a node inside a `match`/`when`/`each` keeps a STABLE id across a
 * re-render. A flat global counter shifted the id whenever the number of
 * element-id'd siblings changed, so the live wire patched the wrong node.
 */

function makeM() {
  return defineMachine({
    name: 'M',
    lifecycle: 'app',
    events: {} as { type: 'X' },
    context: { v: 'a' },
    initial: 'r',
    states: {
      r: {
        on: {
          X: (c) => {
            c.v = 'b'
          },
        },
      },
    },
    selectors: { v: (c) => c.v },
  })
}

async function build() {
  const M = makeM()
  const store = new MachineStore([M], new InMemoryStore())
  await store.bootAppMachines()
  const runtime = new SessionRuntime('s', store)
  await runtime.loadGraph([M])
  return { m: runtime.proxyFor('M') as InstanceOf<ReturnType<typeof makeM>> }
}

const idsOf = (h: string): string[] =>
  [...h.matchAll(/data-stator-id="([^"]+)"/g)].map((m) => m[1]!)

describe('element-id scoping (FINDINGS #2)', () => {
  it('a top-level element id is unscoped; one inside a when-arm is arm-scoped', async () => {
    const { m } = await build()
    const state = createRenderState('s', 'GET /')
    const out = runInRender(
      state,
      () =>
        html`<a class="${read(m, (s) => s.v)}">top</a>${when(
          true,
          () => html`<span class="${read(m, (s) => s.v)}">in-arm</span>`,
        )}`,
    )
    const ids = idsOf(out.html)
    expect(ids[0]).toBe('e0') // top-level scope: unprefixed
    // The in-arm node is scoped by its branch arm, so its id doesn't depend on
    // how many element-id'd siblings rendered before it.
    expect(ids[1]).toMatch(/:btrue:e\d+$/)
  })

  it('re-rendering a branch arm reproduces the IDENTICAL in-arm element id', async () => {
    const { m } = await build()
    const state = createRenderState('s', 'GET /')
    // Mirror what recompute does on a branch flip: re-run renderBranchBody for
    // the same (slot, arm). The element id inside must be identical both times.
    const renderArm = () =>
      runInRender(state, () =>
        renderBranchBody(
          state,
          's0',
          true,
          () => html`<span class="${read(m, (s) => s.v)}">in</span>`,
        ),
      )
    const first = idsOf(renderArm())[0]!
    const second = idsOf(renderArm())[0]!
    expect(first).toMatch(/^s0:btrue:e\d+$/)
    expect(second).toBe(first) // flat counter would give e0 then e1 → wrong target
  })

  it('element ids inside keyed-list items are key-scoped (stable across a wholesale re-render)', async () => {
    const { m } = await build()
    const state = createRenderState('s', 'GET /')
    const out = runInRender(
      state,
      () =>
        html`<ul>${each(
          [{ id: 'a' }, { id: 'b' }],
          (r) => html`<li class="${read(m, (s) => s.v)}">${r.id}</li>`,
          { key: (r) => r.id },
        )}</ul>`,
    )
    // Key-scoped, so the SSE initial-sync (which re-renders keyed lists
    // wholesale) reproduces the same ids the server's bindings target.
    expect(idsOf(out.html)).toEqual(['s0:ka:e0', 's0:kb:e0'])
  })
})
