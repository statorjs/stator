import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { dispatchToApp } from '../src/server/app-dispatch.ts'
import { InMemoryAppStore } from '../src/server/app-store.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { setCodeHash } from '../src/server/machine-hash.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import {
  reconcileSnapshot,
  resetSnapshotPolicyCounters,
  SNAPSHOT_FORMAT,
  snapshotResetReason,
  stampSnapshot,
} from '../src/server/snapshot-policy.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * "Sessions never outlive the code that made them": a persisted snapshot is
 * hydrated only by a machine whose code hash matches the one stamped on it.
 * Unit cases over the policy, then the two real paths — a session machine
 * through SessionRuntime, an app machine through bootAppMachines.
 */

type Events = { type: 'INCREMENT' } | { type: 'BUMP'; by: number }

const makeCounter = () =>
  defineMachine({
    name: 'CounterMachine',
    lifecycle: 'session',
    events: {} as Events,
    context: { count: 0 },
    initial: 'idle',
    states: {
      idle: {
        on: {
          INCREMENT: (ctx) => {
            ctx.count += 1
          },
        },
      },
    },
    selectors: {},
  })

const makeTally = () =>
  defineMachine({
    name: 'TallyMachine',
    lifecycle: 'app',
    persist: true,
    events: {} as Events,
    context: { count: 0 },
    initial: 'ready',
    states: {
      ready: {
        on: {
          BUMP: (ctx, ev) => {
            ctx.count += ev.by
          },
        },
      },
    },
    selectors: {},
  })

beforeEach(() => resetSnapshotPolicyCounters())

describe('snapshot policy: stamp + reconcile', () => {
  it('stamps format and the def code hash; no hash ⇒ no code field', () => {
    const def = makeCounter()
    const bare = stampSnapshot(def, { value: ['idle'], context: { count: 1 } })
    assert.equal(bare.format, SNAPSHOT_FORMAT)
    assert.equal(bare.code, undefined)
    setCodeHash(def, 'h1')
    assert.equal(stampSnapshot(def, { value: ['idle'], context: { count: 1 } }).code, 'h1')
  })

  it('classifies every reset reason', () => {
    const def = makeCounter()
    setCodeHash(def, 'h1')
    const ok = { value: ['idle'], context: { count: 2 }, format: 1, code: 'h1' }
    assert.equal(snapshotResetReason(def, ok), null)
    assert.equal(snapshotResetReason(def, null), 'shape-invalid')
    assert.equal(snapshotResetReason(def, { context: {} }), 'shape-invalid')
    assert.equal(snapshotResetReason(def, { ...ok, format: SNAPSHOT_FORMAT + 1 }), 'format-newer')
    assert.equal(snapshotResetReason(def, { ...ok, code: 'h0' }), 'code-changed')
    assert.equal(snapshotResetReason(def, { value: ['idle'], context: {} }), 'code-changed') // pre-existing, unstamped
    assert.equal(snapshotResetReason(def, { ...ok, value: ['gone'] }), 'state-missing')
  })

  it('a def with no registered hash is never reset for code (stores assembled from defs directly)', () => {
    const def = makeCounter()
    assert.equal(snapshotResetReason(def, { value: ['idle'], context: {} }), null)
    assert.deepStrictEqual(
      reconcileSnapshot(def, { value: ['idle'], context: { count: 3 } }, 's'),
      {
        value: ['idle'],
        context: { count: 3 },
      },
    )
  })

  it('reconcile: nothing stored ⇒ fresh without a reset; unusable ⇒ undefined', () => {
    const def = makeCounter()
    setCodeHash(def, 'h1')
    assert.equal(reconcileSnapshot(def, null, 's'), undefined)
    assert.equal(
      reconcileSnapshot(def, { value: ['idle'], context: {}, code: 'other' }, 's'),
      undefined,
    )
  })
})

describe('session machines: hydrate only under the code that wrote the snapshot', () => {
  const run = async (
    store: MachineStore,
    def: ReturnType<typeof makeCounter>,
    increment: boolean,
  ) => {
    const runtime = new SessionRuntime('s1', store)
    try {
      await runtime.loadGraph([def])
      runtime.wireSubscriptions()
      if (increment) {
        const touched = runtime.processEvent('CounterMachine', { type: 'INCREMENT' })
        await runtime.persistTouched(touched)
      }
      return (
        runtime.handleFor('CounterMachine')!.actor.getPersistedSnapshot().context as {
          count: number
        }
      ).count
    } finally {
      runtime.dispose()
    }
  }

  it('keeps state across requests under the same hash, resets when the hash changes', async () => {
    const persistence = new InMemoryStore()
    const v1 = makeCounter()
    setCodeHash(v1, 'hash-v1')
    const store1 = new MachineStore([v1], persistence)
    assert.equal(await run(store1, v1, true), 1)
    const stored = (await persistence.get('s1', 'CounterMachine')) as {
      code?: string
      format?: number
    }
    assert.equal(stored.code, 'hash-v1')
    assert.equal(stored.format, SNAPSHOT_FORMAT)

    // Same code: the session continues.
    assert.equal(await run(store1, v1, false), 1)

    // "Deploy": the machine's code changed ⇒ new hash ⇒ fresh start.
    const v2 = makeCounter()
    setCodeHash(v2, 'hash-v2')
    const store2 = new MachineStore([v2], persistence)
    assert.equal(await run(store2, v2, false), 0)
    // …and the next persist re-stamps under the new code.
    assert.equal(await run(store2, v2, true), 1)
    assert.equal(
      ((await persistence.get('s1', 'CounterMachine')) as { code?: string }).code,
      'hash-v2',
    )
  })

  it('a snapshot from before stamping existed (no code) resets once', async () => {
    const persistence = new InMemoryStore()
    await persistence.set('s1', 'CounterMachine', { value: ['idle'], context: { count: 9 } })
    const def = makeCounter()
    setCodeHash(def, 'hash-v1')
    assert.equal(await run(new MachineStore([def], persistence), def, false), 0)
  })
})

describe('app machines (persist: true): same rule at boot', () => {
  it('restores under the same hash, boots fresh when the code changed', async () => {
    const appStore = new InMemoryAppStore()
    const v1 = makeTally()
    setCodeHash(v1, 'tally-v1')
    const store1 = new MachineStore([v1], new InMemoryStore(), { appStore })
    await store1.bootAppMachines()
    await dispatchToApp(store1, v1, { type: 'BUMP', by: 7 })
    assert.equal(
      ((await appStore.loadAppMachine('TallyMachine')) as { code?: string }).code,
      'tally-v1',
    )

    const same = makeTally()
    setCodeHash(same, 'tally-v1')
    const store2 = new MachineStore([same], new InMemoryStore(), { appStore })
    await store2.bootAppMachines()
    assert.equal(
      (store2.appInstance('TallyMachine')!.actor.getSnapshot().context as { count: number }).count,
      7,
    )

    const changed = makeTally()
    setCodeHash(changed, 'tally-v2')
    const store3 = new MachineStore([changed], new InMemoryStore(), { appStore })
    await store3.bootAppMachines()
    assert.equal(
      (store3.appInstance('TallyMachine')!.actor.getSnapshot().context as { count: number }).count,
      0,
    )
  })
})
