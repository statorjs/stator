import { defineMachine } from '@statorjs/stator/server'
import { LOW_WATER, REFILL_LEVEL, RESTOCK_ETA_MS, seedStock } from '../lib/stock.ts'
import CartMachine from './cart.ts'

type Events =
  | { type: 'ORDER_PLACED'; items: Array<{ sku: string; qty: number }> }
  | { type: 'RESTOCK_ARRIVED'; skus: string[] }

/**
 * Shared, persisted stock — one instance for every session, hydrated from
 * the AppStore across restarts. Input is an explicit list: orders arrive via
 * the cart's `orderPlaced` emit; replenishment via this machine's own
 * restock effect (the supplier simulation).
 */
export default defineMachine({
  name: 'InventoryMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as Events,
  context: { stock: seedStock() },
  initial: 'tracking',
  states: {
    tracking: {
      on: {
        ORDER_PLACED: {
          do: (ctx, ev) => {
            for (const item of ev.items) {
              if (ctx.stock[item.sku] !== undefined) {
                ctx.stock[item.sku] = Math.max(0, ctx.stock[item.sku]! - item.qty)
              }
            }
          },
          // The supplier sim: anything at/below low water gets a restock
          // order with a delivery delay. Refill SETS the level, so racing
          // chains converge harmlessly.
          effect: async (ctx, _ev, _meta): Promise<Events | null> => {
            const lows = Object.keys(ctx.stock).filter((sku) => ctx.stock[sku]! <= LOW_WATER)
            if (lows.length === 0) return null
            await new Promise((r) => setTimeout(r, RESTOCK_ETA_MS))
            return { type: 'RESTOCK_ARRIVED', skus: lows }
          },
        },
        RESTOCK_ARRIVED: {
          do: (ctx, ev) => {
            for (const sku of ev.skus) {
              ctx.stock[sku] = Math.max(ctx.stock[sku] ?? 0, REFILL_LEVEL)
            }
          },
        },
      },
    },
  },
  subscribes: [{ from: CartMachine, event: 'orderPlaced', dispatch: 'ORDER_PLACED' }],
  selectors: {
    stock: (ctx) => ctx.stock,
    lowSkus: (ctx) => Object.keys(ctx.stock).filter((sku) => ctx.stock[sku]! <= LOW_WATER),
  },
})
