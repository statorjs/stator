import { defineMachine } from '../../../../src/server/define-machine.ts'

type Events =
  | { type: 'LOADED'; data: string }
  | { type: 'WATCH' }
  | { type: 'TICK' }
  | { type: 'PIN' }

// App-lifecycle (process singleton). Exercises entry effects + `after` at APP
// scope — no session, wall-clock only. `loading` fetches on boot via its entry
// effect and lands in the STABLE `ready` (no timer, so it's raceless to
// observe). `watching` is the timed state: a manual WATCH arms a 40ms timeout
// that TICKs to `ticked`, unless PINned first (the cancel path).
export default defineMachine({
  name: 'CacheMachine',
  lifecycle: 'app',
  events: {} as Events,
  context: { data: '', loads: 0 },
  initial: 'loading',
  states: {
    loading: {
      entry: async (): Promise<Events | null> => ({ type: 'LOADED', data: 'v1' }),
      on: {
        LOADED: {
          to: 'ready',
          do: (ctx, ev) => {
            ctx.data = ev.data
            ctx.loads += 1
          },
        },
      },
    },
    ready: {
      on: { WATCH: { to: 'watching' } },
    },
    watching: {
      after: [{ delay: 40, send: { type: 'TICK' } }],
      on: {
        TICK: { to: 'ticked' },
        PIN: { to: 'pinned' },
      },
    },
    ticked: {},
    pinned: {},
  },
  selectors: { data: (ctx) => ctx.data, loads: (ctx) => ctx.loads },
})
