import { defineMachine } from '@statorjs/stator/server'
import CheckoutMachine from './checkout.ts'
import ProductsMachine from './products.ts'

type CartItem = {
  productId: string
  quantity: number
  unitPrice: number
}

type CartContext = {
  items: CartItem[]
}

/** Shared payload selector: every cart emit carries the post-transition
 *  snapshot. Subscribers that denormalize (e.g. AdminMachine) re-set their
 *  view from this; subscribers that care about the specific event semantic
 *  read the event `type` to discriminate. */
const cartSnapshot = (ctx: CartContext) => ({
  items: ctx.items,
  itemCount: ctx.items.reduce((s, i) => s + i.quantity, 0),
  total: ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
})

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  reads: [ProductsMachine],
  // Four domain-fact emits — each names a thing that happened in the cart,
  // not a generic "something changed." Transitions select between them via
  // guards so an ADD_ITEM that bumps an existing item's quantity correctly
  // emits ITEM_QUANTITY_CHANGED, not ITEM_ADDED.
  emits: {
    ITEM_ADDED: { payload: cartSnapshot },
    ITEM_REMOVED: { payload: cartSnapshot },
    ITEM_QUANTITY_CHANGED: { payload: cartSnapshot },
    CART_CLEARED: { payload: cartSnapshot },
  },
  subscribes: [
    { from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' },
  ],

  context: { items: [] } as CartContext,

  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD_ITEM: [
          // First-time add → ITEM_ADDED; repeat add of same product → quantity bump.
          {
            guard: 'isNewProduct',
            actions: 'addItem',
            emit: 'ITEM_ADDED',
          },
          { actions: 'addItem', emit: 'ITEM_QUANTITY_CHANGED' },
        ],
        REMOVE_ITEM: { actions: 'removeItem', emit: 'ITEM_REMOVED' },
        INCREMENT: { actions: 'increment', emit: 'ITEM_QUANTITY_CHANGED' },
        DECREMENT: [
          // Decrementing the last unit removes the line entirely.
          {
            guard: 'isLastUnit',
            actions: 'decrement',
            emit: 'ITEM_REMOVED',
          },
          { actions: 'decrement', emit: 'ITEM_QUANTITY_CHANGED' },
        ],
        CLEAR: { actions: 'clearCart', emit: 'CART_CLEARED' },
      },
    },
  },

  actions: {
    addItem: (ctx, ev, { reads }) => {
      const product = reads.ProductsMachine.byId(ev.productId)
      if (!product) return
      const existing = ctx.items.find((i) => i.productId === ev.productId)
      if (existing) existing.quantity += 1
      else ctx.items.push({ productId: ev.productId, quantity: 1, unitPrice: product.price })
    },
    removeItem: (ctx, ev) => {
      ctx.items = ctx.items.filter((i) => i.productId !== ev.productId)
    },
    increment: (ctx, ev) => {
      const it = ctx.items.find((i) => i.productId === ev.productId)
      if (it && it.quantity < 99) it.quantity += 1
    },
    decrement: (ctx, ev) => {
      const idx = ctx.items.findIndex((i) => i.productId === ev.productId)
      if (idx < 0) return
      const it = ctx.items[idx]!
      if (it.quantity > 1) it.quantity -= 1
      else ctx.items.splice(idx, 1)
    },
    clearCart: (ctx) => {
      ctx.items = []
    },
  },

  guards: {
    isNewProduct: (ctx, ev) => !ctx.items.some((i) => i.productId === ev.productId),
    isLastUnit: (ctx, ev) => {
      const it = ctx.items.find((i) => i.productId === ev.productId)
      return !!it && it.quantity <= 1
    },
  },

  selectors: {
    items: (ctx) => ctx.items,
    itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
    total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    contains: (ctx) => (productId: string) =>
      ctx.items.some((i) => i.productId === productId),
    isEmpty: (ctx) => ctx.items.length === 0,
  },
})
