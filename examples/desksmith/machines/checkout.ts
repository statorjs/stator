import { defineMachine } from '@statorjs/stator/server'
import { chargeCard } from '../lib/payments.ts'

type CheckoutContext = {
  shippingName: string
  shippingAddress: string
  paymentLast4: string
  orderNumber: string | null
  error: string
}

type Field = 'shippingName' | 'shippingAddress' | 'paymentLast4'

type CheckoutEvents =
  | { type: 'SET_FIELD'; field: Field; value: string }
  | { type: 'SUBMIT_SHIPPING' }
  | { type: 'SUBMIT_PAYMENT' }
  | { type: 'CHARGE_OK'; receipt: string }
  | { type: 'CHARGE_FAILED'; reason: string }
  | { type: 'CHARGE_TIMEOUT' }
  | { type: 'BACK' }
  | { type: 'RESET' }

// Shared by both the shipping and payment SET_FIELD transitions.
const setField = (ctx: CheckoutContext, ev: { field: Field; value: string }) => {
  ctx[ev.field] = String(ev.value)
}

const shippingValid = (ctx: CheckoutContext) =>
  ctx.shippingName.trim().length > 0 && ctx.shippingAddress.trim().length > 0

export default defineMachine({
  name: 'CheckoutMachine',
  lifecycle: 'session',
  events: {} as CheckoutEvents,
  emits: ['ORDER_PLACED'],

  context: {
    shippingName: '',
    shippingAddress: '',
    paymentLast4: '',
    orderNumber: null,
    error: '',
  } as CheckoutContext,

  initial: 'shipping',
  states: {
    shipping: {
      on: {
        SET_FIELD: (ctx, ev) => {
          setField(ctx, ev)
        },
        SUBMIT_SHIPPING: { to: 'payment', when: shippingValid },
      },
    },
    payment: {
      on: {
        SET_FIELD: (ctx, ev) => {
          setField(ctx, ev)
        },
        BACK: { to: 'shipping' },
        SUBMIT_PAYMENT: {
          // Pending state now, completion event later — the one pattern for
          // all async work. The charge is a COMMAND-role transition effect:
          // at-most-once, never re-invoked (see the effects guide).
          to: 'placing',
          when: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
          do: (ctx) => {
            ctx.error = ''
          },
          effect: async (ctx, _ev, meta): Promise<CheckoutEvents | null> => {
            try {
              const res = await chargeCard(ctx.paymentLast4, meta.effectId)
              return { type: 'CHARGE_OK', receipt: res.receipt }
            } catch {
              return { type: 'CHARGE_FAILED', reason: 'card declined' }
            }
          },
        },
      },
    },
    placing: {
      // The rescue: a completion that never arrives (crashed processor, lost
      // response) must not strand the user in `placing` forever. One `after`
      // bounds the wait — and since 1.5.0 the countdown re-arms across
      // hydration, so even a server restart can't kill it.
      after: [{ delay: 8_000, send: { type: 'CHARGE_TIMEOUT' } }],
      on: {
        CHARGE_OK: {
          to: 'complete',
          do: (ctx, ev) => {
            ctx.orderNumber = ev.receipt
          },
          emit: 'ORDER_PLACED',
        },
        CHARGE_FAILED: {
          to: 'payment',
          do: (ctx, ev) => {
            ctx.error = ev.reason
          },
        },
        CHARGE_TIMEOUT: {
          to: 'payment',
          do: (ctx) => {
            ctx.error = 'the payment processor never answered — nothing was charged'
          },
        },
      },
    },
    complete: {
      on: {
        RESET: {
          to: 'shipping',
          do: (ctx) => {
            ctx.shippingName = ''
            ctx.shippingAddress = ''
            ctx.paymentLast4 = ''
            ctx.orderNumber = null
            ctx.error = ''
          },
        },
      },
    },
  },

  selectors: {
    shippingName: (ctx) => ctx.shippingName || '(not set)',
    shippingAddress: (ctx) => ctx.shippingAddress || '(not set)',
    paymentLast4: (ctx) => ctx.paymentLast4 || '(not set)',
    orderNumber: (ctx) => ctx.orderNumber ?? '',
    error: (ctx) => ctx.error,
    canSubmitShipping: (ctx) =>
      ctx.shippingName.trim().length > 0 && ctx.shippingAddress.trim().length > 0,
    canSubmitPayment: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
  },
})
