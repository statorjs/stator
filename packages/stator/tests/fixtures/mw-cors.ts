import { cors } from '../../src/server/cors.ts'
import { defineMiddleware } from '../../src/server/middleware.ts'

export default defineMiddleware([cors()])
