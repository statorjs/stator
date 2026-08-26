import { defineMachine } from '../../../../src/engine/define-machine.ts'

type Events = { type: 'TICK' }

// App-lifecycle machine: its live snapshot appears in the inspect payload for
// every caller (process-global), unlike session machines.
export default defineMachine({
  name: 'TickerMachine',
  lifecycle: 'app',
  events: {} as Events,
  context: { ticks: 0 },
  initial: 'running',
  states: {
    running: {
      on: {
        TICK: (ctx) => {
          ctx.ticks += 1
        },
      },
    },
  },
  selectors: {
    ticks: (ctx) => ctx.ticks,
  },
})
