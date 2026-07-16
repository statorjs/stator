import { defineMachine } from '../../../../src/server/define-machine.ts'

type Status = 'loading' | 'ready' | 'error'
type Events = { type: 'LOADED' } | { type: 'TIMEOUT' }

// `loading` fires an entry effect that never dispatches LOADED (returns null) —
// without `after`, the machine would be stranded in `loading` forever. The
// `after` timeout is the escape hatch: 20ms in `loading` sends TIMEOUT -> error.
export default defineMachine({
  name: 'TimeoutLoaderMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { status: 'loading' as Status },
  initial: 'loading',
  states: {
    loading: {
      entry: async (_ctx, _meta): Promise<Events | null> => null,
      after: [{ delay: 20, send: { type: 'TIMEOUT' } }],
      on: {
        LOADED: {
          to: 'ready',
          do: (ctx) => {
            ctx.status = 'ready'
          },
        },
        TIMEOUT: {
          to: 'error',
          do: (ctx) => {
            ctx.status = 'error'
          },
        },
      },
    },
    ready: {},
    error: {},
  },
  selectors: { status: (ctx) => ctx.status },
})
