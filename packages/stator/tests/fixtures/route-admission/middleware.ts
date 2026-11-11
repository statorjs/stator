import { defineMiddleware } from '../../../src/server/middleware.ts'

// The coarse-admission guard from guides/middleware.md: by path. `role=admin`
// stands in for a real credential; `role=banned` is refused outright.
export default defineMiddleware([
  async (c, next) => {
    if (c.req.path.startsWith('/admin')) {
      const cookie = c.req.header('cookie') ?? ''
      if (cookie.includes('role=banned')) return c.text('forbidden', 403)
      if (!cookie.includes('role=admin')) {
        c.header('Set-Cookie', 'returnTo=/admin/orders; Path=/')
        return c.redirect('/login')
      }
    }
    await next()
  },
])
