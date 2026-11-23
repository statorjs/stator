import { defineMachine } from '../../../../src/engine/index.ts'

type Events = { type: 'BUMP' }

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { count: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        BUMP: (ctx) => {
          ctx.count += 1
        },
      },
    },
  },
  selectors: { count: (ctx) => ctx.count },
})
