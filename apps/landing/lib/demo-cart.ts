import { defineMachine } from '@statorjs/stator/machine'
import {
  addItem,
  type CartEvents,
  type CartItem,
  canCheckout,
  countOf,
  itemsText,
  labelFor,
} from './cart-rules.ts'

/**
 * The demo cart as an app would write it: a session machine with real states.
 * The home page's test band shows its test. The hero island cannot import
 * this module (island bundles stub every `defineMachine` module), so it runs
 * the same rules through a client `machine()`.
 */
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as CartEvents,
  context: { items: [] as CartItem[] },
  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD: (ctx, ev) => addItem(ctx.items, ev.productId),
        CHECKOUT: {
          to: 'checking-out',
          when: (ctx) => canCheckout(ctx.items),
        },
      },
    },
    'checking-out': {
      on: {
        BACK: { to: 'idle' },
      },
    },
  },
  selectors: {
    count: (ctx) => countOf(ctx.items),
    labelP1: (ctx) => labelFor(ctx.items, 'p1'),
    labelP2: (ctx) => labelFor(ctx.items, 'p2'),
    labelP3: (ctx) => labelFor(ctx.items, 'p3'),
    itemsText: (ctx) => itemsText(ctx.items),
  },
})
