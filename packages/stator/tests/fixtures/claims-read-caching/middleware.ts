import { stator } from '../../../src/server/context.ts'
import { defineMiddleware } from '../../../src/server/middleware.ts'

export default defineMiddleware([
  async (c, next) => {
    if (c.req.path === '/admitted') stator(c).claims()
    await next()
  },
])
