import { describe, expect, it } from 'vitest'
import { createActor } from '../src/engine/actor.ts'
import type { EffectInvocation, EffectSession } from '../src/engine/types.ts'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { scheduleSessionEffects, wireAppEffects } from '../src/server/effects.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { CLAIMS_KEY } from '../src/server/session.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * `meta.session` — the session an effect runs for, so an entry effect can
 * reload a durable fact by identity after a fresh start or a snapshot reset
 * with no client round trip. Set by the server host for session machines;
 * absent for app machines and for the engine's local default scheduling.
 */

type Events = { type: 'LOADED'; who: string } | { type: 'PING' }
type Me = { userId: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('meta.session on effects', () => {
  it('engine: the host merges the session it passes to run() into meta; none ⇒ undefined', async () => {
    const seen: Array<EffectSession | undefined> = []
    const def = defineMachine({
      name: 'Probe',
      lifecycle: 'session',
      events: {} as Events,
      context: {},
      initial: 'loading',
      states: {
        loading: {
          entry: async (_ctx, meta): Promise<Events | null> => {
            seen.push(meta.session)
            return null
          },
        },
      },
      selectors: {},
    })
    const invocations: EffectInvocation[] = []
    createActor(def, { onEffect: (inv) => invocations.push(inv) }).start()
    expect(invocations).toHaveLength(1)
    await invocations[0]!.run(undefined)
    await invocations[0]!.run(undefined, { id: 's1', claims: <T>() => ({ userId: 'u1' }) as T })
    expect(seen[0]).toBeUndefined()
    expect(seen[1]?.id).toBe('s1')
    expect(seen[1]?.claims<Me>()).toEqual({ userId: 'u1' })
  })

  it('server: a session machine entry effect sees the session id and its claims', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u1' })
    let session: EffectSession | undefined
    const Cart = defineMachine({
      name: 'CartMachine',
      lifecycle: 'session',
      events: {} as Events,
      context: { who: '' },
      initial: 'loading',
      states: {
        loading: {
          entry: async (_ctx, meta): Promise<Events | null> => {
            session = meta.session
            return { type: 'LOADED', who: meta.session?.claims<Me>()?.userId ?? 'nobody' }
          },
          on: {
            LOADED: {
              to: 'ready',
              do: (ctx, ev) => {
                ctx.who = ev.who
              },
            },
          },
        },
        ready: {},
      },
      selectors: {},
    })
    const store = new MachineStore([Cart], persistence)
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([Cart])
    runtime.wireSubscriptions()
    await runtime.persistTouched(new Set(['CartMachine']))
    scheduleSessionEffects(runtime, store, 's1')
    runtime.dispose()
    await sleep(50)
    expect(session?.id).toBe('s1')
    expect(session?.claims<Me>()).toEqual({ userId: 'u1' })
    // The completion re-entered the session: the durable fact was reloaded by identity.
    const snap = (await persistence.get('s1', 'CartMachine')) as {
      value: string[]
      context: { who: string }
    }
    expect(snap.value).toEqual(['ready'])
    expect(snap.context.who).toBe('u1')
  })

  it('server: an app machine effect has no session', async () => {
    let session: EffectSession | undefined | 'unset' = 'unset'
    const Tally = defineMachine({
      name: 'TallyMachine',
      lifecycle: 'app',
      events: {} as Events,
      context: { n: 0 },
      initial: 'ready',
      states: {
        ready: {
          on: {
            PING: {
              do: (ctx) => {
                ctx.n += 1
              },
              effect: async (_ctx, _ev, meta) => {
                session = meta.session
                return null
              },
            },
          },
        },
      },
      selectors: {},
    })
    const store = new MachineStore([Tally], new InMemoryStore())
    wireAppEffects(store)
    await store.bootAppMachines()
    await dispatchToApp(store, Tally, { type: 'PING' })
    await sleep(20)
    expect(session).toBeUndefined()
  })
})
