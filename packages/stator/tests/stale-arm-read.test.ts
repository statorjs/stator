// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { recompute } from '../src/server/recompute.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { match } from '../src/template/conditional.ts'
import { html } from '../src/template/html.ts'
import { read } from '../src/template/read.ts'
import type { InstanceOf } from '../src/template/types.ts'

/**
 * Regression for FINDINGS #3 (spec: conditional-arm-interiors-are-second-class).
 * A live connection keeps a long-lived runtime; fan-out `rehydrate()`s a touched
 * session machine (new actor, old one stopped). recompute re-evaluates registered
 * LEAF bindings against the fresh proxy — but when a branch key flips it
 * RE-RENDERS the arm body, whose nested `read()` uses the render-time closure
 * proxy, frozen at connect-time. So a `read()` inside a `match` arm renders stale
 * on the first data arrival. It must resolve the CURRENT proxy instead.
 */

function makeM() {
  return defineMachine({
    name: 'M',
    lifecycle: 'session',
    events: {} as { type: 'LOADED'; temp: number },
    context: { status: 'loading' as 'loading' | 'ready', temp: 0 },
    initial: 'loading',
    states: {
      loading: {
        on: {
          LOADED: {
            to: 'ready',
            do: (c, e) => {
              c.status = 'ready'
              c.temp = e.temp
            },
          },
        },
      },
      ready: {},
    },
    selectors: { status: (c) => c.status, temp: (c) => String(c.temp) },
  })
}

describe('read() inside a re-rendered arm is fresh on fan-out (FINDINGS #3)', () => {
  it('a match arm flipping loading->ready via fan-out carries FRESH nested-read data', async () => {
    const M = makeM()
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's1'

    // Connection runtime: renders at 'loading'. The ready-arm renderer closes
    // over THIS runtime's proxy.
    const conn = new SessionRuntime(sid, store)
    await conn.loadGraph([M])
    const m = conn.proxyFor('M') as InstanceOf<ReturnType<typeof makeM>>
    const state = createRenderState(sid, 'GET /')
    runInRender(
      state,
      () =>
        html`${match(
          read(m, (s) => s.status),
          {
            loading: () => html`loading`,
            ready: () => html`temp:${read(m, (s) => s.temp)}`,
          },
        )}`,
    )

    // Another runtime advances the machine to ready+data and persists it (a POST
    // or an effect completion in the real system).
    const worker = new SessionRuntime(sid, store)
    await worker.loadGraph([M])
    const touched = worker.processEvent('M', { type: 'LOADED', temp: 28 })
    await worker.persistTouched(touched)

    // Fan-out rehydrates the connection's actor from the store, then recomputes.
    await conn.rehydrate('M')
    const patches = recompute(state, 'M', conn)

    // The branch flipped loading->ready; the temp slot inside its html patch must
    // carry the fresh 28, not the stale 0 from the connect-time proxy.
    const branch = patches.find((p) => p.op === 'html')
    expect(branch).toBeDefined()
    expect(String(branch!.value)).toContain('>28</span>')
    expect(String(branch!.value)).not.toContain('>0</span>')
  })
})
