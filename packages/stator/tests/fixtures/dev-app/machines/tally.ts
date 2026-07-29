import { defineMachine } from '@statorjs/stator/server'

/** dispatchToApp fixture: an app-lifecycle tally the test bumps through
 *  `devApp.dispatchToApp` — the live /tally route must receive the fan-out. */
type Events = { type: 'BUMP'; by?: number }

export default defineMachine({
  name: 'TallyMachine',
  lifecycle: 'app',
  events: {} as Events,
  context: { total: 0 },
  initial: 'ready',
  states: {
    ready: {
      on: {
        BUMP: (ctx, ev) => {
          ctx.total += ev.by ?? 1
        },
      },
    },
  },
  selectors: { total: (ctx) => ctx.total },
})
