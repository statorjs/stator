// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createActor } from '../src/engine/actor.ts'
import type { EffectInvocation } from '../src/engine/types.ts'
import { defineMachine } from '../src/server/define-machine.ts'
import { reenterSessionEvent, scheduleSessionEffects } from '../src/server/effects.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * The work-lifetime contract: state-anchored ongoing work (entry effects,
 * `after` timers) has defined semantics across hydration.
 *   - entry effects are the LOAD role: a snapshot persisted with an unsettled
 *     `pendingEntry` re-invokes on hydration (same effectId) instead of
 *     wedging; settled or in-flight invocations never double-fire,
 *   - `after` timers re-arm on hydration with elapsed credit (deadline =
 *     enteredAt + delay), so a restart can't silently kill a countdown,
 *   - exiting a state aborts its entry effect's signal,
 *   - machine-driven re-entries don't refresh the session TTL and never
 *     resurrect an expired session.
 */

let fires = 0
let lastSignal: AbortSignal | undefined

function makeLoader(delayed = false) {
  return defineMachine({
    name: 'M',
    lifecycle: 'session',
    events: {} as { type: 'LOADED'; v: string } | { type: 'SKIP' },
    context: { v: '' },
    initial: 'loading',
    states: {
      loading: {
        entry: async (_ctx, meta): Promise<{ type: 'LOADED'; v: string } | null> => {
          fires += 1
          lastSignal = meta.signal
          if (delayed) return new Promise(() => {}) // never resolves
          return { type: 'LOADED', v: 'fresh' }
        },
        on: {
          LOADED: {
            to: 'ready',
            do: (ctx, ev) => {
              ctx.v = ev.v
            },
          },
          SKIP: { to: 'ready' },
        },
      },
      ready: {},
    },
    selectors: { v: (ctx) => ctx.v },
  })
}

describe('snapshot work-lifetime fields (engine)', () => {
  it('carries enteredAt + pendingEntry through persist, transition, and settle', () => {
    fires = 0
    const queued: EffectInvocation[] = []
    const actor = createActor(makeLoader(), { onEffect: (i) => queued.push(i) }).start()

    const snap = actor.getPersistedSnapshot()
    expect(typeof snap.enteredAt).toBe('number')
    expect(snap.pendingEntry?.effectId).toBe(queued[0]!.effectId)

    // Settling with the wrong id is a no-op; the right id clears the marker.
    expect(actor.settleEntry('nope')).toBe(false)
    expect(actor.settleEntry(queued[0]!.effectId)).toBe(true)
    expect(actor.getPersistedSnapshot().pendingEntry).toBeUndefined()

    // A transition stamps a fresh enteredAt and drops any stale marker.
    const before = actor.getPersistedSnapshot().enteredAt!
    actor.send({ type: 'SKIP' })
    const after = actor.getPersistedSnapshot()
    expect(after.value).toEqual(['ready'])
    expect(after.enteredAt).toBeGreaterThanOrEqual(before)
    expect(after.pendingEntry).toBeUndefined()
  })
})

describe('effect wedge: unsettled entry re-invokes on hydration', () => {
  it('a crashed load recovers with the SAME effectId and completes', async () => {
    fires = 0
    const M = makeLoader()
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's-wedge'

    // "Crash": the entry effect was scheduled but its invocation never ran —
    // the process died holding it. Persist the marker.
    const dead: EffectInvocation[] = []
    const crashed = createActor(M, { onEffect: (i) => dead.push(i) }).start()
    await store.persistence.set(sid, 'M', crashed.getPersistedSnapshot(), { ttlSeconds: 60 })
    expect(fires).toBe(0) // scheduled, never run

    // Fresh process hydrates: the pending marker (no in-flight invocation)
    // re-invokes the entry effect with the same id.
    const runtime = new SessionRuntime(sid, store)
    await runtime.loadGraph([M])
    const refired = runtime.drainPendingEffects()
    expect(refired).toHaveLength(1)
    expect(refired[0]!.effectId).toBe(dead[0]!.effectId)

    // Running it delivers the completion through the normal path: recovered.
    await refired[0]!.run().then((completion) => {
      expect(fires).toBe(1)
      expect(completion).toEqual({ type: 'LOADED', v: 'fresh' })
      return reenterSessionEvent(store, sid, 'M', completion!, {
        settles: refired[0]!.effectId,
      })
    })
    const healed = (await store.persistence.get(sid, 'M')) as { value: string[] }
    expect(healed.value).toEqual(['ready'])
    runtime.dispose()
  })

  it('does NOT re-invoke when hydrating a settled snapshot', async () => {
    fires = 0
    const M = makeLoader()
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's-settled'

    const queued: EffectInvocation[] = []
    const a = createActor(M, { onEffect: (i) => queued.push(i) }).start()
    a.settleEntry(queued[0]!.effectId)
    await store.persistence.set(sid, 'M', a.getPersistedSnapshot(), { ttlSeconds: 60 })

    const runtime = new SessionRuntime(sid, store)
    await runtime.loadGraph([M])
    expect(runtime.drainPendingEffects()).toHaveLength(0) // no marker, no refire
    runtime.dispose()
  })
})

describe('timer wedge: `after` re-arms on hydration with elapsed credit', () => {
  it('a countdown that expired while no process was alive fires promptly', async () => {
    const M = defineMachine({
      name: 'T',
      lifecycle: 'session',
      events: {} as { type: 'TIMEOUT' },
      context: {},
      initial: 'waiting',
      states: {
        waiting: {
          after: [{ delay: 60_000, send: { type: 'TIMEOUT' } }],
          on: { TIMEOUT: { to: 'done' } },
        },
        done: {},
      },
      selectors: {},
    })
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's-timer'

    // Snapshot from a "previous process": entered `waiting` long past the delay.
    await store.persistence.set(
      sid,
      'T',
      { value: ['waiting'], context: {}, enteredAt: Date.now() - 120_000 },
      { ttlSeconds: 60 },
    )

    // Hydration re-arms with credit → overdue floor → fires promptly.
    const runtime = new SessionRuntime(sid, store)
    await runtime.loadGraph([M])
    runtime.dispose()

    await vi.waitFor(
      async () => {
        const snap = (await store.persistence.get(sid, 'T')) as { value: string[] }
        expect(snap.value).toEqual(['done'])
      },
      { timeout: 2000, interval: 20 },
    )
  })
})

describe('exit-abort: leaving a state aborts its entry effect', () => {
  it('the load-role signal aborts when the machine transitions away', async () => {
    fires = 0
    lastSignal = undefined
    const M = makeLoader(true) // never-resolving entry
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()
    const sid = 's-abort'

    const runtime = new SessionRuntime(sid, store)
    await runtime.loadGraph([M]) // fresh: fires entry, queues invocation
    scheduleSessionEffects(runtime, store, sid) // starts it → registers in-flight
    await runtime.persistTouched(new Set(['M']))
    await vi.waitFor(() => expect(lastSignal).toBeDefined())
    expect(lastSignal!.aborted).toBe(false)

    // A user event moves the machine out of `loading` → exit hook aborts.
    runtime.processEvent('M', { type: 'SKIP' })
    expect(lastSignal!.aborted).toBe(true)
    runtime.dispose()
  })
})

describe('re-entry guards', () => {
  it('machine-driven re-entries do not refresh the session TTL', async () => {
    vi.useFakeTimers()
    try {
      const M = makeLoader()
      const store = new MachineStore([M], new InMemoryStore(), { sessionTtlSeconds: 10 })
      await store.bootAppMachines()
      const sid = 's-ttl'

      // User-driven persist at t=0: expiry t+10s.
      const runtime = new SessionRuntime(sid, store)
      await runtime.loadGraph([M])
      runtime.drainPendingEffects()
      await runtime.persistTouched(new Set(['M']))
      runtime.dispose()

      // t=8s: a machine-driven completion commits — must NOT extend expiry.
      vi.advanceTimersByTime(8_000)
      const late = { type: 'LOADED', v: 'late' }
      await reenterSessionEvent(store, sid, 'M', late)
      expect(await store.persistence.get(sid, 'M')).not.toBeNull()

      // t=12s: past the ORIGINAL expiry — the session is gone. (A refreshing
      // persist would have kept it until t=18s.)
      vi.advanceTimersByTime(4_000)
      expect(await store.persistence.get(sid, 'M')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an out-of-band event for an expired session is dropped, not resurrected', async () => {
    fires = 0
    const M = makeLoader()
    const store = new MachineStore([M], new InMemoryStore())
    await store.bootAppMachines()

    const zombie = { type: 'LOADED', v: 'zombie' }
    await reenterSessionEvent(store, 'ghost', 'M', zombie)

    expect(await store.persistence.get('ghost', 'M')).toBeNull()
    expect(fires).toBe(0) // no fresh machine was born, no entry effect fired
  })
})
