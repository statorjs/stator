import { stator } from '../../../src/server/context.ts'
import { defineMiddleware } from '../../../src/server/middleware.ts'
import { securityHeaders } from '../../../src/server/security-headers.ts'

export default defineMiddleware([
  securityHeaders(),
  // A per-visitor cookie minted in middleware (an A/B bucket, a visitor id).
  async (c, next) => {
    const s = stator(c)
    if (c.req.path === '/landing' && c.req.header('x-poc-bucket')) {
      s.cookies.set('bucket', crypto.randomUUID(), { path: '/' })
    }
    await next()
  },
])
