import { defineMachine, activeConnectionCount } from 'stator/server'
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

export default defineMachine({
  name: 'AdminMachine',
  lifecycle: 'app',
  reads: [],
  emits: {},

  subscribes: [
    // Any session's CartMachine emit lands here with sourceSessionId set.
    { from: CartMachine, event: 'CART_CHANGED', dispatch: 'SESSION_CART_CHANGED' },
  ],

  context: { sessions: {} } as AdminContext,

  initial: 'ready',
  states: {
    ready: {
      on: {
        SESSION_CART_CHANGED: { actions: 'updateSessionCart' },
      },
    },
  },

  actions: {
    updateSessionCart: (ctx, ev) => {
      // ev shape: { type, items, itemCount, total, sourceSessionId } —
      // payload merged from CartMachine's emit + framework's sourceSessionId
      const sid = ev.sourceSessionId as string
      const items = ev.items as CartItem[]
      if (items.length === 0) {
        delete ctx.sessions[sid]
      } else {
        ctx.sessions[sid] = {
          items,
          itemCount: ev.itemCount as number,
          total: ev.total as number,
          lastUpdate: Date.now(),
        }
      }
    },
  },

  selectors: {
    sessions: (ctx) => ctx.sessions,
    sessionList: (ctx) =>
      Object.entries(ctx.sessions)
        .map(([sid, snap]) => ({ sid, ...snap }))
        .sort((a, b) => b.lastUpdate - a.lastUpdate),
    activeSessionCount: (ctx) => Object.keys(ctx.sessions).length,
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
