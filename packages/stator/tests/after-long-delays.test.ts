import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { wireAppEffects } from '../src/server/effects.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { InMemoryStore } from '../src/server/store.ts'
import { APP_SCOPE, cancelAfterTimers, MAX_TIMEOUT_MS } from '../src/server/timers.ts'

/**
 * An `after` delay longer than `setTimeout`'s maximum (2^31-1 ms, ~24.8 days)
 * must fire at its deadline, not after 1 ms (Node's clamp). `mock.timers`
 * emulates the clamp, so these fail against a bare `setTimeout`.
 */

const DAY = 86_400_000
const TRIAL_MS = 30 * DAY

type Events = { type: 'START' } | { type: 'EXPIRE' } | { type: 'CANCEL' }

let n = 0
const trialMachine = (opts: { persist?: boolean } = {}) =>
  defineMachine({
    // Unique per test: the timer registry is process-wide.
    name: `LongTrialMachine${++n}`,
    lifecycle: 'app',
    persist: opts.persist ?? false,
    events: {} as Events,
    context: { expired: 0 },
    initial: 'idle',
    states: {
      idle: { on: { START: { to: 'trial' } } },
      trial: {
        after: [{ delay: TRIAL_MS, send: { type: 'EXPIRE' } }],
        on: {
          EXPIRE: {
            to: 'expired',
            do: (ctx) => {
              ctx.expired += 1
            },
          },
          CANCEL: { to: 'cancelled' },
        },
      },
      expired: { on: { START: { to: 'trial' } } },
      cancelled: {},
    },
    selectors: {},
  })
type Def = ReturnType<typeof trialMachine>

const boot = async (def: Def, appStore = new InMemoryAppStore()) => {
  const store = new MachineStore([def], new InMemoryStore(), { appStore })
  wireAppEffects(store)
  await store.bootAppMachines()
  return store
}

const stateOf = (store: MachineStore, def: Def) => {
  const snap = store.appInstance(def.name)!.actor.getSnapshot() as {
    value: string[]
    context: { expired: number }
  }
  return { value: snap.value[0], expired: snap.context.expired }
}

/** Let a fired timer's dispatch (async: persist, fan-out) finish. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

/** Advance fake time in chunks no larger than setTimeout's maximum. */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= MAX_TIMEOUT_MS) {
    mock.timers.tick(Math.min(left, MAX_TIMEOUT_MS))
    await flush()
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 1) })
})
afterEach(() => {
  mock.timers.reset()
})

describe('`after` delays longer than setTimeout allows', () => {
  it('does not fire early, and fires once at the deadline', async () => {
    const def = trialMachine()
    const store = await boot(def)
    await dispatchToApp(store, def, { type: 'START' })
    assert.equal(stateOf(store, def).value, 'trial')

    await advance(5)
    assert.equal(stateOf(store, def).value, 'trial', 'a 30-day delay must not fire after 1 ms')

    await advance(TRIAL_MS - 5 - 1)
    assert.equal(stateOf(store, def).value, 'trial', 'still 1 ms short of the deadline')

    await advance(1)
    assert.deepEqual(stateOf(store, def), { value: 'expired', expired: 1 })

    // Nothing left armed: another 60 days changes nothing.
    await advance(60 * DAY)
    assert.deepEqual(stateOf(store, def), { value: 'expired', expired: 1 })
  })

  it('leaving the state mid-way cancels whichever step is pending', async () => {
    const def = trialMachine()
    const store = await boot(def)
    await dispatchToApp(store, def, { type: 'START' })

    // Past the first step (~24.8 days) and into the second.
    await advance(26 * DAY)
    assert.equal(stateOf(store, def).value, 'trial')
    await dispatchToApp(store, def, { type: 'CANCEL' })
    assert.equal(stateOf(store, def).value, 'cancelled')

    await advance(60 * DAY)
    assert.deepEqual(stateOf(store, def), { value: 'cancelled', expired: 0 })
  })

  it('cancelling before the first step ends also holds', async () => {
    const def = trialMachine()
    const store = await boot(def)
    await dispatchToApp(store, def, { type: 'START' })
    await advance(DAY)
    cancelAfterTimers(APP_SCOPE, def.name, 'trial')

    await advance(60 * DAY)
    assert.deepEqual(stateOf(store, def), { value: 'trial', expired: 0 })
  })

  it('a restored remainder over the maximum waits out the rest of the delay', async () => {
    const def = trialMachine({ persist: true })
    const appStore = new InMemoryAppStore()
    const first = await boot(def, appStore)
    await dispatchToApp(first, def, { type: 'START' }) // persisted with enteredAt = now
    // The first process "dies": its timer goes with it.
    cancelAfterTimers(APP_SCOPE, def.name, 'trial')

    // Restart two days later: 28 days remain, which is over the maximum.
    mock.timers.setTime(Date.now() + 2 * DAY)
    const second = await boot(def, appStore)
    assert.equal(stateOf(second, def).value, 'trial')

    await advance(5)
    assert.equal(stateOf(second, def).value, 'trial', 'a 28-day remainder must not fire after 1 ms')

    await advance(28 * DAY - 5 - 1)
    assert.equal(stateOf(second, def).value, 'trial', 'still 1 ms short of the deadline')

    await advance(1)
    assert.deepEqual(stateOf(second, def), { value: 'expired', expired: 1 })
  })
})
