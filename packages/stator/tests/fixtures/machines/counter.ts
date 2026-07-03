import { defineMachine } from '../../../src/server/define-machine.ts'

type Events = { type: 'INCREMENT' } | { type: 'DECREMENT' }

export default defineMachine({
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
        DECREMENT: (ctx) => {
          ctx.count -= 1
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.count,
    label: (ctx) => `count is ${ctx.count}`,
  },
})
