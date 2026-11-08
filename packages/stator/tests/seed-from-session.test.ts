import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor } from '../src/engine/actor.ts'
import type { EffectInvocation, EffectSession } from '../src/engine/types.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { setCodeHash } from '../src/server/machine-hash.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { CLAIMS_KEY } from '../src/server/session.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { stampSnapshot } from '../src/server/snapshot-policy.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * `seed`: where a session machine starts when it has no usable snapshot — a
 * new session, or a reset — given the session's claims. Synchronous, applied
 * by the host before the first render, never when a snapshot hydrates. The
 * sign-in case: claims name the user, so the machine starts `authenticated`
 * instead of flashing the sign-in form until an entry effect lands.
 */

type Me = { userId: string; role: string }
type Events = { type: 'LOGIN'; userId: string } | { type: 'LOGOUT' }

const Auth = (hash = 'auth-v1') => {
  const def = defineMachine({
    name: 'AuthMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { userId: '', role: '', entered: [] as string[] },
    initial: 'anonymous',
    seed: (s) => {
      const me = s.claims<Me>()
      return me
        ? { state: 'authenticated', context: { userId: me.userId, role: me.role } }
        : undefined
    },
    states: {
      anonymous: {
        on: {
          LOGIN: {
            to: 'authenticated',
            do: (ctx, ev) => {
              ctx.userId = ev.userId
            },
          },
        },
      },
      authenticated: {
        entry: async (): Promise<Events | null> => null,
        on: {
          LOGOUT: {
            to: 'anonymous',
            do: (ctx) => {
              ctx.userId = ''
            },
          },
        },
      },
    },
    selectors: {},
  })
  setCodeHash(def, hash)
  return def
}

describe('engine: actor.seed with a state', () => {
  it('starts in the seeded state for real: entry effect fires, context merged', () => {
    const def = Auth()
    const invocations: EffectInvocation[] = []
    const entered: string[] = []
    const actor = createActor(def, {
      onEffect: (inv) => invocations.push(inv),
      onStateEnter: (state) => entered.push(state),
    })
    actor.seed({ userId: 'u1' }, 'authenticated')
    actor.start()
    assert.deepStrictEqual(actor.getSnapshot().value, ['authenticated'])
    assert.equal(actor.getSnapshot().context.userId, 'u1')
    assert.deepStrictEqual(entered, ['authenticated'])
    assert.deepStrictEqual(
      invocations.map((i) => i.stateKey),
      ['authenticated'],
    )
  })

  it('throws on a state the machine does not have, and is a no-op after start', () => {
    const def = Auth()
    const actor = createActor(def)
    assert.throws(() => actor.seed({}, 'nope'), /seeded into state "nope"/)
    actor.start()
    actor.seed({ userId: 'late' }, 'authenticated')
    assert.deepStrictEqual(actor.getSnapshot().value, ['anonymous'])
    assert.equal(actor.getSnapshot().context.userId, '')
  })
})

describe('defineMachine: seed is session-only', () => {
  it('rejects seed on an app machine', () => {
    assert.throws(
      () =>
        defineMachine({
          name: 'Tally',
          lifecycle: 'app',
          context: { n: 0 },
          initial: 'idle',
          seed: () => ({ context: { n: 1 } }),
          states: { idle: {} },
        }),
      /declares seed but is app-lifecycle/,
    )
  })
})

describe('server: seed on a fresh start', () => {
  const load = async (def: ReturnType<typeof Auth>, persistence: InMemoryStore) => {
    const store = new MachineStore([def], persistence)
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([def])
    const snap = runtime.handleFor('AuthMachine')!.actor.getSnapshot()
    runtime.dispose()
    return snap
  }

  it('a new session with claims starts authenticated, with no event dispatched', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u1', role: 'member' })
    const snap = await load(Auth(), persistence)
    assert.deepStrictEqual(snap.value, ['authenticated'])
    assert.partialDeepStrictEqual(snap.context, { userId: 'u1', role: 'member' })
  })

  it('a new session without claims starts at initial', async () => {
    const snap = await load(Auth(), new InMemoryStore())
    assert.deepStrictEqual(snap.value, ['anonymous'])
    assert.equal(snap.context.userId, '')
  })

  it('a usable snapshot wins — seed is not consulted', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u1', role: 'member' })
    const def = Auth('auth-v1')
    // The session signed out after its claims were set (say, LOGOUT without a
    // claims clear): the persisted snapshot says anonymous, and that stands.
    await persistence.set(
      's1',
      'AuthMachine',
      stampSnapshot(def, { value: ['anonymous'], context: { userId: '', role: '', entered: [] } }),
    )
    const snap = await load(def, persistence)
    assert.deepStrictEqual(snap.value, ['anonymous'])
  })

  it('a snapshot reset (code changed) starts from the seed, not from initial', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u1', role: 'owner' })
    const v1 = Auth('auth-v1')
    await persistence.set(
      's1',
      'AuthMachine',
      stampSnapshot(v1, { value: ['anonymous'], context: { userId: '', role: '', entered: [] } }),
    )
    const snap = await load(Auth('auth-v2'), persistence)
    assert.deepStrictEqual(snap.value, ['authenticated'])
    assert.partialDeepStrictEqual(snap.context, { userId: 'u1', role: 'owner' })
  })

  it('seed sees the session id and the persisted claims', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u9', role: 'member' })
    let seen: EffectSession | undefined
    const def = defineMachine({
      name: 'AuthMachine',
      lifecycle: 'session',
      events: {} as Events,
      context: { userId: '' },
      initial: 'anonymous',
      seed: (s) => {
        seen = s
        return undefined
      },
      states: { anonymous: {}, authenticated: {} },
      selectors: {},
    })
    const store = new MachineStore([def], persistence)
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([def])
    runtime.dispose()
    assert.equal(seen?.id, 's1')
    assert.deepStrictEqual(seen?.claims<Me>(), { userId: 'u9', role: 'member' })
  })

  it('rehydrate applies the seed too when nothing usable is stored', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', CLAIMS_KEY, { userId: 'u1', role: 'member' })
    const def = Auth()
    const store = new MachineStore([def], persistence)
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([def])
    await runtime.rehydrate('AuthMachine')
    assert.deepStrictEqual(runtime.handleFor('AuthMachine')!.actor.getSnapshot().value, [
      'authenticated',
    ])
    runtime.dispose()
  })
})
