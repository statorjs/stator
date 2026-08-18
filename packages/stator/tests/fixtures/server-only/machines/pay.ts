import { defineMachine } from '../../../../src/server/define-machine.ts'

// A checkout-shaped machine: the client sends CHARGE (intent); the charge
// EFFECT is the only legitimate source of the CHARGE_APPROVED completion. A
// forged CHARGE_APPROVED over /__events would settle the order without paying,
// so it's declared server-only.
type Events =
  | { type: 'CHARGE' }
  | { type: 'CHARGE_APPROVED'; receiptId: string }
  | { type: 'CHARGE_DECLINED' }

export default defineMachine({
  name: 'PayMachine',
  lifecycle: 'session',
  events: {} as Events,
  // Typechecked against the event union — a non-event name here is a compile error.
  serverOnly: ['CHARGE_APPROVED', 'CHARGE_DECLINED'],
  context: { status: 'idle' as 'idle' | 'charging' | 'paid' | 'declined', receiptId: '' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        CHARGE: {
          to: 'charging',
          do: (ctx) => {
            ctx.status = 'charging'
          },
          // The completion re-enters via the INTERNAL dispatch path (this effect
          // return), never through /__events — so the server-only wire gate
          // can't block the legitimate settlement.
          effect: async (): Promise<Events | null> => ({
            type: 'CHARGE_APPROVED',
            receiptId: 'rcpt_123',
          }),
        },
      },
    },
    charging: {
      on: {
        CHARGE_APPROVED: {
          to: 'paid',
          do: (ctx, ev) => {
            ctx.status = 'paid'
            ctx.receiptId = ev.receiptId
          },
        },
        CHARGE_DECLINED: {
          to: 'declined',
          do: (ctx) => {
            ctx.status = 'declined'
          },
        },
      },
    },
    paid: {},
    declined: {},
  },
  selectors: {
    status: (ctx) => ctx.status,
    receiptId: (ctx) => ctx.receiptId,
  },
})
