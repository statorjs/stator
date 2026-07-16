import { defineMachine } from '../../../../src/server/define-machine.ts'

type Events = { type: 'PING' }

// Trivial session machine: a POST target for the "defer thunk is not re-run on
// /__events" test. PING commits (action-only) so the event is genuinely handled.
export default defineMachine({
  name: 'Pinger',
  lifecycle: 'session',
  events: {} as Events,
  context: { pings: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        PING: {
          do: (ctx) => {
            ctx.pings += 1
          },
        },
      },
    },
  },
  selectors: { pings: (ctx) => ctx.pings },
})
