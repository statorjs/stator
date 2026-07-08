import { defineMachine } from '@statorjs/stator/server'
import { LOW_WATER, REFILL_LEVEL, RESTOCK_ETA_MS, seedStock } from '../lib/stock.ts'
import AdminMachine from './admin.ts'

type Events =
  | { type: 'ORDER_PLACED'; items: Array<{ sku: string; qty: number }> }
  | { type: 'RESTOCK_ORDERED'; sku: string }
  | { type: 'RESTOCK_ARRIVED'; skus: string[] }
  | { type: 'TIDE_RESET' }

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
  context: { stock: seedStock(), pending: [] as string[] },
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
        RESTOCK_ORDERED: {
          // Idempotent while in flight: a second click is guard-dropped.
          when: (ctx, ev) => !ctx.pending.includes(ev.sku),
          do: (ctx, ev) => {
            ctx.pending.push(ev.sku)
          },
          // The admin-triggered supplier order: same ETA, same converging
          // refill as the automatic low-water path.
          effect: async (_ctx, ev, _meta): Promise<Events | null> => {
            await new Promise((r) => setTimeout(r, RESTOCK_ETA_MS))
            return { type: 'RESTOCK_ARRIVED', skus: [ev.sku] }
          },
        },
        RESTOCK_ARRIVED: {
          do: (ctx, ev) => {
            for (const sku of ev.skus) {
              ctx.stock[sku] = Math.max(ctx.stock[sku] ?? 0, REFILL_LEVEL)
              const i = ctx.pending.indexOf(sku)
              if (i !== -1) ctx.pending.splice(i, 1)
            }
          },
        },
        // The tide comes in: the public demo resets to seed state nightly
        // (see start.ts), undoing drift and vandalism alike.
        TIDE_RESET: {
          do: (ctx) => {
            ctx.stock = seedStock()
            ctx.pending.length = 0
          },
        },
      },
    },
  },
  // NOTE: the orderPlaced subscription is attached in cart.ts. Declaring it
  // here would need `from: CartMachine` while cart.ts needs `reads:
  // [InventoryMachine]` — a module cycle the loader resolves to undefined
  // (and the store now diagnoses). Mutual machine relationships wire the
  // second half post-definition at the importing end. AdminMachine imports
  // nothing of ours, so ITS subscription declares normally:
  subscribes: [{ from: AdminMachine, event: 'restockRequested', dispatch: 'RESTOCK_ORDERED' }],
  selectors: {
    stock: (ctx) => ctx.stock,
    lowSkus: (ctx) => Object.keys(ctx.stock).filter((sku) => ctx.stock[sku]! <= LOW_WATER),
    isPending: (ctx) => (sku: string) => ctx.pending.includes(sku),
  },
})
