import { defineMachine } from 'stator/server'
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

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  reads: [ProductsMachine],
  emits: ['ITEM_ADDED', 'ITEM_REMOVED', 'CART_CLEARED'],
  subscribes: [
    { from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' },
  ],

  context: { items: [] } as CartContext,

  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD_ITEM: { actions: 'addItem', emit: 'ITEM_ADDED' },
        REMOVE_ITEM: { actions: 'removeItem', emit: 'ITEM_REMOVED' },
        INCREMENT: { actions: 'increment' },
        DECREMENT: { actions: 'decrement' },
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

  selectors: {
    items: (ctx) => ctx.items,
    itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
    total: (ctx) => ctx.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
    contains: (ctx) => (productId: string) =>
      ctx.items.some((i) => i.productId === productId),
    isEmpty: (ctx) => ctx.items.length === 0,
  },
})
