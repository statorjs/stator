import { defineMachine } from '../../../src/server/define-machine.ts'

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  reads: [],
  emits: [],
  context: { count: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        INCREMENT: { actions: 'inc' },
        DECREMENT: { actions: 'dec' },
      },
    },
  },
  actions: {
    inc: (ctx) => {
      ctx.count += 1
    },
    dec: (ctx) => {
      ctx.count -= 1
    },
  },
  selectors: {
    count: (ctx) => ctx.count,
    label: (ctx) => `count is ${ctx.count}`,
  },
})
