import { defineMachine } from '@statorjs/stator/server'
import { STEP } from '../lib/step.ts'

type Events = { type: 'INCREMENT' }

export default defineMachine({
  name: 'CarryCounterMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { count: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        INCREMENT: (ctx) => {
          ctx.count += STEP
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.count,
    label: (ctx) => `count is ${ctx.count}`,
  },
})
