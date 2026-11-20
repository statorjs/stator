import { defineMachine } from '../../../../src/server/define-machine.ts'

export default defineMachine({
  name: 'TallyMachine',
  lifecycle: 'app',
  events: {} as { type: 'BUMP' },
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
