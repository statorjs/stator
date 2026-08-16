import { defineMiddleware } from '../../src/server/middleware.ts'

export default defineMiddleware([
  async (c, next) => {
    await next()
    c.header('X-Mw-Test', 'ran')
  },
])
