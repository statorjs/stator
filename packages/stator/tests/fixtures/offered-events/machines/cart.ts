import { defineMachine } from '../../../../src/engine/index.ts'

type Events =
  | { type: 'ADD'; id: string }
  | { type: 'REMOVE'; id: string }
  | { type: 'CLEAR' }
  | { type: 'CHECKOUT' }
  | { type: 'CHARGE_OK' }
  | { type: 'CHARGE_TIMEOUT' }
  | { type: 'PING' }

/** `CHARGE_OK` and `CHARGE_TIMEOUT` are what an effect and a timer would
 *  report. Neither is listed `serverOnly`: the gate is what refuses them. */
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { ids: [] as string[], paid: false },
  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD: (ctx, ev) => void ctx.ids.push(ev.id),
        REMOVE: (ctx, ev) => {
          ctx.ids = ctx.ids.filter((id) => id !== ev.id)
        },
        CLEAR: (ctx) => {
          ctx.ids = []
        },
        CHECKOUT: { to: 'paying' },
        PING: () => {},
      },
    },
    paying: {
      on: {
        CHARGE_OK: {
          to: 'idle',
          do: (ctx) => {
            ctx.paid = true
          },
        },
        CHARGE_TIMEOUT: { to: 'idle' },
      },
    },
  },
  selectors: { count: (ctx) => ctx.ids.length, ids: (ctx) => ctx.ids },
})
