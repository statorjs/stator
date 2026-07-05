import { describe, expect, it } from 'vitest'
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
    expect(cycles.length).toBeGreaterThan(0)
    const flat = cycles[0]!.join(' → ')
    expect(flat).toContain('CycleA')
    expect(flat).toContain('CycleB')
  })

  it('a runtime cascade cycle aborts with a named trail, not a stack overflow', async () => {
    const { A, B } = cyclePair()
    const store = new MachineStore([A, B] as never, new InMemoryStore())
    const runtime = new SessionRuntime('s1', store)
    await runtime.loadGraph([A] as never)
    runtime.wireSubscriptions()

    expect(() =>
      withDispatchContext({ sessionId: 's1' } as never, () =>
        runtime.processEvent('CycleA', { type: 'GO' }),
      ),
    ).toThrowError(/emit cascade exceeded .* hops[\s\S]*CycleA —ping→ CycleB/)
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
    expect(store.findSubscriptionCycles()).toEqual([])
  })
})
