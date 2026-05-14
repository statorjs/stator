import { defineMachine } from 'stator/server'

type CheckoutContext = {
  shippingName: string
  shippingAddress: string
  paymentLast4: string
  orderNumber: string | null
}

export default defineMachine({
  name: 'CheckoutMachine',
  lifecycle: 'session',
  reads: [],
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
        SET_FIELD: { actions: 'setField' },
        SUBMIT_SHIPPING: { target: 'payment', guard: 'shippingValid' },
      },
    },
    payment: {
      on: {
        SET_FIELD: { actions: 'setField' },
        BACK: { target: 'shipping' },
        SUBMIT_PAYMENT: {
          target: 'complete',
          guard: 'paymentValid',
          actions: 'placeOrder',
          emit: 'ORDER_PLACED',
        },
      },
    },
    complete: {
      on: {
        RESET: { target: 'shipping', actions: 'reset' },
      },
    },
  },

  actions: {
    setField: (ctx, ev) => {
      if (ev.field === 'shippingName') ctx.shippingName = String(ev.value)
      else if (ev.field === 'shippingAddress') ctx.shippingAddress = String(ev.value)
      else if (ev.field === 'paymentLast4') ctx.paymentLast4 = String(ev.value)
    },
    placeOrder: (ctx) => {
      ctx.orderNumber = 'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase()
    },
    reset: (ctx) => {
      ctx.shippingName = ''
      ctx.shippingAddress = ''
      ctx.paymentLast4 = ''
      ctx.orderNumber = null
    },
  },

  guards: {
    shippingValid: (ctx) =>
      ctx.shippingName.trim().length > 0 && ctx.shippingAddress.trim().length > 0,
    paymentValid: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
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
