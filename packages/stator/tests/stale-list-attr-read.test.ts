// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { classList } from '../src/template/directives/list-attr.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'
import type { Patch } from '../src/wire/index.ts'

/**
 * Sibling of FINDINGS #3, one composition boundary further out. A `class:list`
 * spec is built ONCE at render: its ReadResults capture `.instance` — the
 * connect-time proxy. The compound directive's registered selector ignores the
 * proxy recompute passes in and re-walks that frozen spec, so after fan-out
 * `rehydrate()` replaces the connection's actor (stopping the old one), the
 * composed class re-reads the STOPPED actor's snapshot forever: the class
 * attribute never patches over a live connection.
 */

function makeM() {
  return defineMachine({
    name: 'M',
    lifecycle: 'session',
    events: {} as { type: 'TOGGLE' },
    context: { spin: false },
    initial: 'idle',
    states: {
      idle: {
        on: {
          TOGGLE: {
            do: (c) => {
              c.spin = !c.spin
            },
          },
        },
      },
    },
    selectors: { spin: (c) => c.spin },
  })
}

describe('class:list read is fresh on fan-out after rehydrate', () => {
  it('a spec read flipping false->true via fan-out patches the class attribute', async () => {
    const M = makeM()
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's1'

    // Connection runtime: renders at spin=false. The class:list spec's
    // ReadResult closes over THIS runtime's proxy.
    const conn = new SessionRuntime(sid, store)
    await conn.loadGraph([M])
    const m = conn.proxyFor('M') as InstanceOf<ReturnType<typeof makeM>>
    const state = createRenderState(sid, 'GET /')
    runInRender(
      state,
      () => html`<button ${classList(['btn', { spinning: read(m, (s) => s.spin) }])}>x</button>`,
    )

    // Another runtime commits spin=true and persists it (a POST in the real
    // system), then fan-out rehydrates the connection's actor and recomputes.
    const worker = new SessionRuntime(sid, store)
    await worker.loadGraph([M])
    await worker.persistTouched(worker.processEvent('M', { type: 'TOGGLE' }))
    await conn.rehydrate('M')
    const patches = recompute(state, 'M', conn)

    // The composed class must re-read through the CURRENT proxy: one attr
    // patch carrying `spinning`.
    const isClassAttr = (p: Patch): p is Extract<Patch, { op: 'attr' }> =>
      p.op === 'attr' && p.name === 'class'
    const attr = patches.find(isClassAttr)
    expect(attr).toBeDefined()
    expect(String(attr!.value)).toBe('btn spinning')

    // And back again — the un-spin patch a second commit must produce.
    const worker2 = new SessionRuntime(sid, store)
    await worker2.loadGraph([M])
    await worker2.persistTouched(worker2.processEvent('M', { type: 'TOGGLE' }))
    await conn.rehydrate('M')
    const patches2 = recompute(state, 'M', conn)
    const attr2 = patches2.find(isClassAttr)
    expect(attr2).toBeDefined()
    expect(String(attr2!.value)).toBe('btn')
  })
})
