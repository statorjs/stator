import { describe, expect, it } from 'vitest'
import { createActor, defineMachine } from '../src/engine/index.ts'

// Machine-level `on:` — handlers that apply in any state, consulted only when the
// current state does not declare the event. State-scoped handlers win.

type Events =
  | { type: 'GO' } // moves off the state that handles PING
  | { type: 'PING' }
  | { type: 'BUMP' }

const make = () =>
  defineMachine({
    name: 'MLO',
    lifecycle: 'session',
    events: {} as Events,
    context: { pings: 0, bumps: 0, localBumps: 0 },
    initial: 'a',
    states: {
      a: {
        on: {
          GO: { to: 'b' },
          // State-scoped BUMP in `a` — should win over the machine-level one.
          BUMP: {
            do: (ctx) => {
              ctx.localBumps += 1
            },
          },
        },
      },
      b: {
        on: { GO: { to: 'a' } },
      },
    },
    // Applies in BOTH states, except where a state declares the event itself.
    on: {
      PING: {
        do: (ctx) => {
          ctx.pings += 1
        },
      },
      BUMP: {
        do: (ctx) => {
          ctx.bumps += 1
        },
      },
    },
  })

describe('machine-level on:', () => {
  it('handles an event in a state that does not declare it', () => {
    const a = createActor(make()).start() // state 'a' — no PING handler
    a.send({ type: 'PING' })
    a.send({ type: 'GO' }) // → 'b', also no PING handler
    a.send({ type: 'PING' })
    expect(a.getSnapshot().context.pings).toBe(2)
  })

  it('a state-scoped handler wins over the machine-level one (most specific)', () => {
    const a = createActor(make()).start() // state 'a' declares BUMP
    a.send({ type: 'BUMP' })
    expect(a.getSnapshot().context.localBumps).toBe(1)
    expect(a.getSnapshot().context.bumps).toBe(0) // machine-level not consulted

    a.send({ type: 'GO' }) // → 'b', which does NOT declare BUMP
    a.send({ type: 'BUMP' })
    expect(a.getSnapshot().context.bumps).toBe(1) // now the machine-level fires
    expect(a.getSnapshot().context.localBumps).toBe(1)
  })

  it('an event no state and no machine-level handler declares is still dropped', () => {
    const a = createActor(make()).start()
    const before = a.getSnapshot().context
    a.send({ type: 'NOPE' } as unknown as Events)
    expect(a.getSnapshot().context).toEqual(before)
  })
})
