import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/server/define-machine.ts'
import { withDispatchContext } from '../src/server/dispatch-context.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { SessionRuntime } from '../src/server/session-runtime.ts'
import { InMemoryStore } from '../src/server/store.ts'

/**
 * Emit→subscribe cascades run synchronously; a subscription cycle used to
 * recurse to a bare stack overflow. These pin the two guards: the wire-time
 * cycle warning (machine-level, advisory) and the runtime depth cap (hard,
 * with a diagnosable trail).
 */

function cyclePair() {
  // A --ping--> B --pong--> A, no guard: a true runtime loop.
  const A: any = defineMachine({
    name: 'CycleA',
    lifecycle: 'session',
    events: {} as { type: 'GO' } | { type: 'PONGED' },
    emits: { ping: { payload: () => ({}) } },
    context: {},
    initial: 'idle',
    states: {
      idle: {
        on: {
          GO: { emit: 'ping' },
          PONGED: { emit: 'ping' },
        },
      },
    },
    selectors: {},
  })
  const B = defineMachine({
    name: 'CycleB',
    lifecycle: 'session',
    events: {} as { type: 'PINGED' },
    emits: { pong: { payload: () => ({}) } },
    context: {},
    initial: 'idle',
    states: {
      idle: {
        on: {
          PINGED: { emit: 'pong' },
        },
      },
    },
    subscribes: [{ from: A, event: 'ping', dispatch: 'PINGED' }],
    selectors: {},
  })
  // Close the loop: A subscribes back to B.
  const AClosed = defineMachine({
    ...(A as object),
    subscribes: [{ from: B, event: 'pong', dispatch: 'PONGED' }],
  } as never)
  return { A: AClosed as typeof B, B }
}

describe('subscription cycle guards', () => {
  it('findSubscriptionCycles reports the machine-level loop', () => {
    const { A, B } = cyclePair()
    const store = new MachineStore([A, B] as never, new InMemoryStore())
    const cycles = store.findSubscriptionCycles()
    assert.ok(cycles.length > 0)
    const flat = cycles[0]!.join(' → ')
    assert.ok(flat.includes('CycleA'))
    assert.ok(flat.includes('CycleB'))
  })

  it('a runtime cascade cycle aborts with a named trail, not a stack overflow', async () => {
    const { A, B } = cyclePair()
    const store = new MachineStore([A, B] as never, new InMemoryStore())
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([A] as never)
    runtime.wireSubscriptions()

    assert.throws(
      () =>
        withDispatchContext({ sessionId: 's1' } as never, () =>
          runtime.processEvent('CycleA', { type: 'GO' }),
        ),
      /emit cascade exceeded .* hops[\s\S]*CycleA —ping→ CycleB/,
    )
  })

  it('an undefined `from` (circular-import symptom) gets the named diagnosis', () => {
    // Cross-file subscription cycles do NOT crash at import time — Vite SSR
    // and tsx interop both resolve the mid-cycle binding to `undefined`
    // silently (verified empirically). The store must convert that into a
    // circular-import diagnosis instead of an opaque TypeError.
    const Broken = defineMachine({
      name: 'BrokenSub',
      lifecycle: 'session',
      events: {} as { type: 'X' },
      context: {},
      initial: 'idle',
      states: { idle: {} },
      subscribes: [{ from: undefined as never, event: 'ping', dispatch: 'X' }],
      selectors: {},
    })
    assert.throws(
      () => new MachineStore([Broken] as never, new InMemoryStore()),
      /circular import between machine modules/,
    )
  })

  it('an acyclic graph stays silent and works', () => {
    const Source = defineMachine({
      name: 'DagSource',
      lifecycle: 'session',
      events: {} as { type: 'GO' },
      emits: { went: { payload: () => ({}) } },
      context: {},
      initial: 'idle',
      states: { idle: { on: { GO: { emit: 'went' } } } },
      selectors: {},
    })
    const Sink = defineMachine({
      name: 'DagSink',
      lifecycle: 'session',
      events: {} as { type: 'NOTED' },
      context: { seen: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            NOTED: {
              do: (ctx) => {
                ctx.seen += 1
              },
            },
          },
        },
      },
      subscribes: [{ from: Source, event: 'went', dispatch: 'NOTED' }],
      selectors: { seen: (ctx) => ctx.seen },
    })
    const store = new MachineStore([Source, Sink] as never, new InMemoryStore())
    assert.deepStrictEqual(store.findSubscriptionCycles(), [])
  })
})
