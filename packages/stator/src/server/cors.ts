import type { MiddlewareHandler } from 'hono'
import { stator } from './context.ts'
import { matchOrigin } from './origin-match.ts'

export interface CorsOptions {
  /** Allowed origins (exact or wildcard-subdomain). Defaults to the app's
   *  `cors.origins`, which itself defaults to `trustedOrigins`. */
  origins?: readonly string[]
  /** Send `Access-Control-Allow-Credentials: true` (needed to read a response
   *  with cookies). Defaults to the app's `cors.credentials`. */
  credentials?: boolean
  /** Methods advertised on preflight. Default: GET/POST/PUT/PATCH/DELETE/OPTIONS. */
  methods?: readonly string[]
  /** Request headers advertised on preflight. Default: reflects the request's. */
  headers?: readonly string[]
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

/**
 * CORS middleware — governs which cross-origin sites may READ responses (distinct
 * from `crossSiteGuard`, which governs cross-site WRITES). Opt-in, not a default.
 * Reflects the request `Origin` when it matches the allowlist — never `*`, so
 * credentialed (cookie-bearing) reads work — and answers preflight with 204.
 * Wildcards go through the shared boundary-safe matcher.
 */
export function cors(opts: CorsOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const ctx = stator(c)
    const origins = opts.origins ?? ctx.cors?.origins ?? ctx.trustedOrigins
    const credentials = opts.credentials ?? ctx.cors?.credentials ?? false
    const reqOrigin = c.req.header('origin')

    if (reqOrigin && matchOrigin(reqOrigin, origins)) {
      c.header('Access-Control-Allow-Origin', reqOrigin)
      c.header('Vary', 'Origin')
      if (credentials) c.header('Access-Control-Allow-Credentials', 'true')
    }

    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', (opts.methods ?? DEFAULT_METHODS).join(', '))
      const reqHeaders = opts.headers?.join(', ') ?? c.req.header('access-control-request-headers')
      if (reqHeaders) c.header('Access-Control-Allow-Headers', reqHeaders)
      return c.body(null, 204)
    }
    await next()
  }
}
