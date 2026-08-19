import { defineMachine } from '../../../../src/server/define-machine.ts'

// App-lifecycle singleton — a boot hook dispatches BUMP into it, and a route
// renders the count, so a test can observe that boot's dispatch landed.
type Events = { type: 'BUMP' }

export default defineMachine({
  name: 'BootCounter',
  lifecycle: 'app',
  events: {} as Events,
  context: { count: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        BUMP: {
          to: 'idle',
          do: (ctx) => {
            ctx.count += 1
          },
        },
      },
    },
  },
  selectors: { count: (ctx) => ctx.count },
})
