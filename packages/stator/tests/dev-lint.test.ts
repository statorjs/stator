import { describe, expect, it } from 'vitest'
import { defineMachine } from '../src/server/define-machine.ts'
import { findPollLoops } from '../src/server/dev-lint.ts'

/**
 * The poll-loop lint flags weather's original sin — an `after`-driven cycle
 * with a data-loading entry effect — and stays quiet for the legitimate
 * shapes: after-rescue, action-only handlers, and app-machine housekeeping.
 */

const pollShaped = () =>
  defineMachine({
    name: 'Poll',
    lifecycle: 'session',
    events: {} as { type: 'REVALIDATE' } | { type: 'LOADED' },
    context: {},
    initial: 'ready',
    states: {
      ready: {
        after: [{ delay: 1000, send: { type: 'REVALIDATE' } }],
        on: { REVALIDATE: { to: 'revalidating' } },
      },
      revalidating: {
        entry: async (): Promise<{ type: 'LOADED' } | null> => ({ type: 'LOADED' }),
        on: { LOADED: { to: 'ready' } },
      },
    },
    selectors: {},
  })

const rescueShaped = () =>
  defineMachine({
    name: 'Rescue',
    lifecycle: 'session',
    events: {} as { type: 'LOADED' } | { type: 'TIMEOUT' },
    context: {},
    initial: 'loading',
    states: {
      loading: {
        entry: async (): Promise<{ type: 'LOADED' } | null> => null,
        after: [{ delay: 1000, send: { type: 'TIMEOUT' } }],
        on: { LOADED: { to: 'ready' }, TIMEOUT: { to: 'error' } },
      },
      ready: {},
      error: {},
    },
    selectors: {},
  })

describe('findPollLoops', () => {
  it('flags an after-driven cycle with an entry effect on the loop', () => {
    const findings = findPollLoops([pollShaped()])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      machine: 'Poll',
      state: 'ready',
      event: 'REVALIDATE',
      cycle: ['ready', 'revalidating', 'ready'],
    })
  })

  it('does NOT flag after-rescue (timer fires once into a terminal state)', () => {
    expect(findPollLoops([rescueShaped()])).toHaveLength(0)
  })

  it('does NOT flag a cycle with no entry effect on the loop', () => {
    const M = defineMachine({
      name: 'NoLoad',
      lifecycle: 'session',
      events: {} as { type: 'TICK' } | { type: 'BACK' },
      context: {},
      initial: 'a',
      states: {
        a: { after: [{ delay: 1000, send: { type: 'TICK' } }], on: { TICK: { to: 'b' } } },
        b: { on: { BACK: { to: 'a' } } },
      },
      selectors: {},
    })
    expect(findPollLoops([M])).toHaveLength(0)
  })

  it('does NOT flag app machines (housekeeping is their legitimate niche)', () => {
    const M = defineMachine({
      name: 'Sweep',
      lifecycle: 'app',
      events: {} as { type: 'SWEEP' } | { type: 'DONE' },
      context: {},
      initial: 'idle',
      states: {
        idle: {
          after: [{ delay: 1000, send: { type: 'SWEEP' } }],
          on: { SWEEP: { to: 'sweeping' } },
        },
        sweeping: {
          entry: async (): Promise<{ type: 'DONE' } | null> => ({ type: 'DONE' }),
          on: { DONE: { to: 'idle' } },
        },
      },
      selectors: {},
    })
    expect(findPollLoops([M])).toHaveLength(0)
  })
})
