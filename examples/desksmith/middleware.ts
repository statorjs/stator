import { defineMiddleware } from '@statorjs/stator/server'

/**
 * `/admin` shows every visitor's cart and the process's runtime metrics, and it
 * has no sign-in. It is a development view, so production answers 404. The
 * page's live updates and events are covered too: Stator runs this middleware
 * for them as a GET of the page's own URL. See the with-auth starter for a
 * gated admin area.
 */
export default defineMiddleware([
  async (c, next) => {
    const path = new URL(c.req.url).pathname
    const admin = path === '/admin' || path.startsWith('/admin/')
    if (admin && process.env.NODE_ENV === 'production') return c.notFound()
    await next()
  },
])
