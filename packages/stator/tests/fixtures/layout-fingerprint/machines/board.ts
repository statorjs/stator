import { defineMachine } from '../../../../src/server/define-machine.ts'
import Ping from './ping.ts'

type Events = { type: 'BUMP'; by?: number }

export default defineMachine({
  name: 'BoardMachine',
  lifecycle: 'app',
  subscribes: [{ from: Ping, event: 'pinged', dispatch: 'BUMP' }],
  events: {} as Events,
  context: { total: 7, members: 42 },
  initial: 'ready',
  states: {
    ready: {
      on: {
        BUMP: (ctx, ev) => {
          ctx.total += ev.by ?? 1
          ctx.members += 100
        },
      },
    },
  },
  selectors: { total: (ctx) => ctx.total, members: (ctx) => ctx.members },
})
