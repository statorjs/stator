import { defineMachine, activeConnectionCount } from '@statorjs/stator/server'
import CartMachine from './cart.ts'

type CartItem = { productId: string; quantity: number; unitPrice: number }

type SessionCartSnapshot = {
  items: CartItem[]
  itemCount: number
  total: number
  lastUpdate: number
}

type AdminContext = {
  // Denormalized per-session cart state. Keyed by sourceSessionId — the
  // framework injects this on cross-lifecycle dispatches automatically.
  sessions: Record<string, SessionCartSnapshot>
}

type AdminEvents = {
  type: 'SESSION_CART_CHANGED'
  items: CartItem[]
  itemCount: number
  total: number
  sourceSessionId: string
}

export default defineMachine({
  name: 'AdminMachine',
  lifecycle: 'app',
  events: {} as AdminEvents,

  subscribes: [
    // Every cart-mutating event delivers a fresh snapshot here, with
    // sourceSessionId injected by the framework (cross-lifecycle). The
    // four semantic events all dispatch to the same updater since admin
    // denormalizes — but the schema-export view preserves each event's
    // domain meaning on the source side.
    { from: CartMachine, event: 'ITEM_ADDED', dispatch: 'SESSION_CART_CHANGED' },
    { from: CartMachine, event: 'ITEM_REMOVED', dispatch: 'SESSION_CART_CHANGED' },
    { from: CartMachine, event: 'ITEM_QUANTITY_CHANGED', dispatch: 'SESSION_CART_CHANGED' },
    { from: CartMachine, event: 'CART_CLEARED', dispatch: 'SESSION_CART_CHANGED' },
  ],

  context: { sessions: {} } as AdminContext,

  initial: 'ready',
  states: {
    ready: {
      on: {
        // ev: { items, itemCount, total, sourceSessionId } — payload merged
        // from CartMachine's emit + framework-injected sourceSessionId.
        SESSION_CART_CHANGED: (ctx, ev) => {
          const sid = ev.sourceSessionId
          if (ev.items.length === 0) {
            delete ctx.sessions[sid]
          } else {
            ctx.sessions[sid] = {
              items: ev.items,
              itemCount: ev.itemCount,
              total: ev.total,
              lastUpdate: Date.now(),
            }
          }
        },
      },
    },
  },

  selectors: {
    sessions: (ctx) => ctx.sessions,
    sessionList: (ctx) =>
      Object.entries(ctx.sessions)
        .map(([sid, snap]) => ({ sid, ...snap }))
        .sort((a, b) => b.lastUpdate - a.lastUpdate),
    activeCartCount: (ctx) => Object.keys(ctx.sessions).length,
    totalItemsInCarts: (ctx) =>
      Object.values(ctx.sessions).reduce((s, c) => s + c.itemCount, 0),
    totalValueInCarts: (ctx) =>
      Object.values(ctx.sessions).reduce((s, c) => s + c.total, 0),
    // Per-product aggregate: how many of each productId are currently
    // sitting in someone's cart, server-wide.
    countByProduct: (ctx) => {
      const counts: Record<string, number> = {}
      for (const session of Object.values(ctx.sessions)) {
        for (const item of session.items) {
          counts[item.productId] = (counts[item.productId] ?? 0) + item.quantity
        }
      }
      return counts
    },

    // Same aggregate as `countByProduct`, but shaped for direct rendering:
    // only productIds with at least one unit currently in some cart, sorted
    // by total count desc. Lets the admin dashboard render an N-row list
    // that grows/shrinks with real activity instead of showing every
    // product permanently with mostly-zero counts.
    inCartProducts: (ctx) => {
      const counts: Record<string, number> = {}
      for (const session of Object.values(ctx.sessions)) {
        for (const item of session.items) {
          counts[item.productId] = (counts[item.productId] ?? 0) + item.quantity
        }
      }
      return Object.entries(counts)
        .map(([productId, count]) => ({ productId, count }))
        .sort((a, b) => b.count - a.count)
    },

    // DEBUG: intentionally non-pure — these selectors sample live process
    // state every time they're read. Used by the admin dashboard for
    // leak/connection visibility. Every recompute re-evaluates them, so
    // the values refresh on every fan-out push. Not safe to use outside
    // debug surfaces.
    runtimeMetrics: () => {
      const m = process.memoryUsage()
      const mb = (bytes: number) => +(bytes / 1024 / 1024).toFixed(2)
      return {
        heapUsedMB: mb(m.heapUsed),
        heapTotalMB: mb(m.heapTotal),
        rssMB: mb(m.rss),
        externalMB: mb(m.external),
        arrayBuffersMB: mb(m.arrayBuffers),
        activeConnections: activeConnectionCount(),
        uptimeSeconds: Math.round(process.uptime()),
      }
    },
  },
})
