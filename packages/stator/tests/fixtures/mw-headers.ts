import { defineMiddleware } from '../../src/server/middleware.ts'
import { securityHeaders } from '../../src/server/security-headers.ts'

export default defineMiddleware([securityHeaders()])
