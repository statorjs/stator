import { defineMachine } from '../../../src/server/define-machine.ts'
import Ping from './ping.ts'

/** SSE fixture, app half: a cross-session board that tallies every session's
 *  pings. Live routes reading it receive fan-out pushes. */
type Events = { type: 'BUMP'; by?: number }

export default defineMachine({
  name: 'BoardMachine',
  lifecycle: 'app',
  subscribes: [{ from: Ping, event: 'pinged', dispatch: 'BUMP' }],
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
