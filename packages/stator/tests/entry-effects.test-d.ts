// Type-level tests for entry-effect return typing (see the entry-effects spec's
// "Return typing"): an annotated `entry` return is checked against the machine's
// event union, exactly like a transition effect.
import { defineMachine } from '../src/server/define-machine.ts'

type Events = { type: 'LOADED'; items: string[] } | { type: 'FAILED' }

// Valid: entry returns a declared event.
defineMachine({
  name: 'Ok',
  lifecycle: 'session',
  events: {} as Events,
  context: { items: [] as string[] },
  initial: 'loading',
  states: {
    loading: {
      entry: async (): Promise<Events | null> => ({ type: 'LOADED', items: ['a'] }),
      on: { LOADED: { to: 'ready' }, FAILED: { to: 'ready' } },
    },
    ready: {},
  },
})

// Invalid: an undeclared completion event type is a compile error.
defineMachine({
  name: 'BadType',
  lifecycle: 'session',
  events: {} as Events,
  context: {},
  initial: 'loading',
  states: {
    loading: {
      entry: async (): Promise<Events | null> => {
        // @ts-expect-error — NOPE is not in the machine's event union
        return { type: 'NOPE' }
      },
    },
  },
})

// Invalid: a declared event missing a required field is a compile error.
defineMachine({
  name: 'BadShape',
  lifecycle: 'session',
  events: {} as Events,
  context: {},
  initial: 'loading',
  states: {
    loading: {
      entry: async (): Promise<Events | null> => {
        // @ts-expect-error — LOADED requires `items`
        return { type: 'LOADED' }
      },
    },
  },
})
