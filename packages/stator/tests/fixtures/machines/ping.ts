import { defineMachine } from '../../../src/server/define-machine.ts'

/** SSE fixture, session half: PING bumps local state and emits `pinged`,
 *  which BoardMachine (app) subscribes to — the cross-session display path. */
type Events = { type: 'PING' }

export default defineMachine({
  name: 'PingMachine',
  lifecycle: 'session',
  events: {} as Events,
  emits: { pinged: null },
  context: { sent: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        PING: {
          do: (ctx) => {
            ctx.sent += 1
          },
          emit: 'pinged',
        },
      },
    },
  },
  selectors: { sent: (ctx) => ctx.sent },
})
