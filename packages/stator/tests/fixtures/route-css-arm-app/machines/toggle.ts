import { defineMachine } from '../../../../src/server/define-machine.ts'

type Events = { type: 'FLIP' }

export default defineMachine({
  name: 'ToggleMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { status: 'loading' as 'loading' | 'ready' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        FLIP: (ctx) => {
          ctx.status = ctx.status === 'loading' ? 'ready' : 'loading'
        },
      },
    },
  },
  selectors: {
    status: (ctx) => ctx.status,
  },
})
