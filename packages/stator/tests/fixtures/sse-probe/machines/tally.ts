import { defineMachine } from '@statorjs/stator/server'

/** Single-shot fan-out probe: an app-lifecycle tally bumped once per round.
 *  Its own fixture on purpose — the dev suites share `fixtures/dev-app` and
 *  edit files in it while each other's watchers are live. */
type Events = { type: 'BUMP'; by?: number }

export default defineMachine({
  name: 'ProbeTally',
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
