import { defineMachine } from '@statorjs/stator/server'
import CartMachine from './cart.ts'

export interface OrderRecord {
  receiptId: string
  amountCents: number
  summary: string
  placedAt: number
}

/** The order log for the admin feed — deliberately PII-free: receipt, items
 *  summary, amount, timestamp. Persisted; capped at the last 50. */
export default defineMachine({
  name: 'OrdersMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as {
    type: 'ORDER_PLACED'
    receiptId: string
    amountCents: number
    summary: string
  },
  context: { orders: [] as OrderRecord[] },
  initial: 'logging',
  states: {
    logging: {
      on: {
        ORDER_PLACED: {
          do: (ctx, ev) => {
            ctx.orders.unshift({
              receiptId: ev.receiptId,
              amountCents: ev.amountCents,
              summary: ev.summary,
              placedAt: Date.now(),
            })
            if (ctx.orders.length > 50) ctx.orders.length = 50
          },
        },
      },
    },
  },
  subscribes: [{ from: CartMachine, event: 'orderPlaced', dispatch: 'ORDER_PLACED' }],
  selectors: {
    recent: (ctx) => ctx.orders,
    total: (ctx) => ctx.orders.length,
  },
})
