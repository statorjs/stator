import { defineMachine } from '@statorjs/stator/server'

type Events = { type: 'INCREMENT' }

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
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.count,
    label: (ctx) => `count is ${ctx.count}`,
  },
})
