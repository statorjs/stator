import { defineMachine } from '../../../../src/server/define-machine.ts'

type Events = { type: 'INCREMENT' }

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as Events,
  // `marker` is a canary for the identity-import stub test: if the real
  // machine module ever reaches a browser bundle, this string appears in it.
  context: { count: 0, marker: 'server-only-machine-body' },
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
  selectors: {
    count: (ctx) => ctx.count,
  },
})
