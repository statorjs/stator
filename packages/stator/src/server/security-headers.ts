import type { MiddlewareHandler } from 'hono'

export interface SecurityHeadersOptions {
  /** `X-Frame-Options`. Default `SAMEORIGIN`; `false` to omit. */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  /** `Referrer-Policy`. Default `strict-origin-when-cross-origin`; `false` to omit. */
  referrerPolicy?: string | false
  /** `Strict-Transport-Security` max-age in seconds (HSTS). Off by default —
   *  only meaningful over HTTPS, and easy to lock yourself out with. */
  hsts?: number | false
  /** `Content-Security-Policy`. Off by default — CSP varies per app. */
  contentSecurityPolicy?: string | false
}

/**
 * Baseline security response headers — opt-in (not a default), matching SvelteKit
 * and Stator's current stance of leaving HTTP hardening to the app/platform.
 * `X-Content-Type-Options: nosniff` is always set; frame + referrer are on with
 * safe defaults; HSTS and CSP are opt-in.
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler {
  const frame = opts.frameOptions ?? 'SAMEORIGIN'
  const referrer = opts.referrerPolicy ?? 'strict-origin-when-cross-origin'
  return async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    if (frame) c.header('X-Frame-Options', frame)
    if (referrer) c.header('Referrer-Policy', referrer)
    if (opts.hsts) c.header('Strict-Transport-Security', `max-age=${opts.hsts}; includeSubDomains`)
    if (opts.contentSecurityPolicy) c.header('Content-Security-Policy', opts.contentSecurityPolicy)
    await next()
  }
}
