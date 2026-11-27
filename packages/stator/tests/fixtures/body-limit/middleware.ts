import { defineMiddleware } from '../../../src/server/middleware.ts'

// Reads the body in middleware for /hook (a matched route) and /webhook (no
// route at all), the way a webhook signature check would.
export default defineMiddleware([
  async (c, next) => {
    if (c.req.path === '/hook' || c.req.path === '/webhook') {
      const text = await c.req.text()
      return c.json({ middleware: text.length })
    }
    await next()
  },
])
