import { defineMachine } from '../../../../src/engine/index.ts'

export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as { type: 'BUMP' },
  context: { n: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        BUMP: (ctx: { n: number }) => {
          ctx.n += 1
        },
      },
    },
  },
})
