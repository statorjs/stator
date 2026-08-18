import { stator } from '../../src/server/context.ts'
import { defineMiddleware } from '../../src/server/middleware.ts'

// Test harness: seal a value into a signed cookie from a header, and echo the
// verified value back — exercising cookies.setSigned/getSigned in middleware.
export default defineMiddleware([
  async (c, next) => {
    const s = stator(c)
    const toSeal = c.req.header('x-seal')
    if (toSeal !== undefined) await s.cookies.setSigned('sealed', toSeal, { path: '/' })
    await next()
    const value = await s.cookies.getSigned('sealed')
    if (value !== undefined) c.header('x-sealed', value)
  },
])
