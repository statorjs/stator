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

type CartEvents =
  | { type: 'ADD_ITEM'; productId: string }
  | { type: 'REMOVE_ITEM'; productId: string }
  | { type: 'INCREMENT'; productId: string }
  | { type: 'DECREMENT'; productId: string }
  | { type: 'CLEAR' }

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
  events: {} as CartEvents,
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
  subscribes: [{ from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' }],

  context: { items: [] } as CartContext,

  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD_ITEM: [
          // First-time add → ITEM_ADDED; repeat add of same product → quantity bump.
          {
            when: (ctx, ev) => !ctx.items.some((i) => i.productId === ev.productId),
            do: (ctx, ev, { reads }) => {
              const product = reads.ProductsMachine.byId(ev.productId)
              if (product)
                ctx.items.push({
                  productId: ev.productId,
                  quantity: 1,
                  unitPrice: product.price,
                })
            },
            emit: 'ITEM_ADDED',
          },
          {
            do: (ctx, ev) => {
              const existing = ctx.items.find((i) => i.productId === ev.productId)
              if (existing) existing.quantity += 1
            },
            emit: 'ITEM_QUANTITY_CHANGED',
          },
        ],
        REMOVE_ITEM: {
          do: (ctx, ev) => {
            ctx.items = ctx.items.filter((i) => i.productId !== ev.productId)
          },
          emit: 'ITEM_REMOVED',
        },
        INCREMENT: {
          do: (ctx, ev) => {
            const it = ctx.items.find((i) => i.productId === ev.productId)
            if (it && it.quantity < 99) it.quantity += 1
          },
          emit: 'ITEM_QUANTITY_CHANGED',
        },
        DECREMENT: [
          // Decrementing the last unit removes the line entirely.
          {
            when: (ctx, ev) => {
              const it = ctx.items.find((i) => i.productId === ev.productId)
              return !!it && it.quantity <= 1
            },
            do: (ctx, ev) => {
              ctx.items = ctx.items.filter((i) => i.productId !== ev.productId)
            },
            emit: 'ITEM_REMOVED',
          },
          {
            do: (ctx, ev) => {
              const it = ctx.items.find((i) => i.productId === ev.productId)
              if (it && it.quantity > 1) it.quantity -= 1
            },
            emit: 'ITEM_QUANTITY_CHANGED',
          },
        ],
        CLEAR: {
          do: (ctx) => {
            ctx.items = []
          },
          emit: 'CART_CLEARED',
        },
      },
    },
  },

  selectors: {
    items: (ctx) => ctx.items,
    itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
    total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    contains: (ctx) => (productId: string) => ctx.items.some((i) => i.productId === productId),
    isEmpty: (ctx) => ctx.items.length === 0,
  },
})
