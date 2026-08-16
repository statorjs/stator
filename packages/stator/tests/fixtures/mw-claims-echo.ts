import { stator } from '../../src/server/context.ts'
import { defineMiddleware } from '../../src/server/middleware.ts'

// Test harness: set/clear claims from request headers, echo current claims back.
export default defineMiddleware([
  async (c, next) => {
    const s = stator(c)
    const set = c.req.header('x-set-claims')
    if (set) s.setClaims(JSON.parse(set))
    if (c.req.header('x-clear-claims')) s.clearClaims()
    await next()
    const claims = s.claims()
    if (claims !== undefined) c.header('x-claims', JSON.stringify(claims))
  },
])
