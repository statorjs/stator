import { defineMachine } from '@statorjs/stator/server'

type CheckoutContext = {
  shippingName: string
  shippingAddress: string
  paymentLast4: string
  orderNumber: string | null
}

type Field = 'shippingName' | 'shippingAddress' | 'paymentLast4'

type CheckoutEvents =
  | { type: 'SET_FIELD'; field: Field; value: string }
  | { type: 'SUBMIT_SHIPPING' }
  | { type: 'SUBMIT_PAYMENT' }
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
          to: 'complete',
          when: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
          do: (ctx) => {
            ctx.orderNumber = `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
          },
          emit: 'ORDER_PLACED',
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
    canSubmitShipping: (ctx) =>
      ctx.shippingName.trim().length > 0 && ctx.shippingAddress.trim().length > 0,
    canSubmitPayment: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
  },
})
