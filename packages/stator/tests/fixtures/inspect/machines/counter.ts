import { defineMachine } from '../../../../src/engine/define-machine.ts'

type Events = { type: 'INCREMENT' } | { type: 'RESET' } | { type: 'SYNCED'; at: number }

// Session machine exercising the describe surface: a plain transition with an
// emit, an ordered guarded candidate list, a bare-function handler, and a
// server-only event.
export default defineMachine({
  name: 'CounterMachine',
  lifecycle: 'session',
  events: {} as Events,
  serverOnly: ['SYNCED'],
  emits: ['counted'],
  context: { count: 0, syncedAt: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        INCREMENT: {
          do: (ctx) => {
            ctx.count += 1
          },
          emit: 'counted',
        },
        RESET: [
          {
            when: (ctx) => ctx.count > 0,
            do: (ctx) => {
              ctx.count = 0
            },
          },
        ],
        SYNCED: (ctx, ev) => {
          ctx.syncedAt = ev.at
        },
      },
    },
  },
  selectors: {
    count: (ctx) => ctx.count,
  },
})
