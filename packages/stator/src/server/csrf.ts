import type { Context, MiddlewareHandler } from 'hono'
import { matchOrigin } from './origin-match.ts'

/**
 * CSRF signal check for state-changing requests. The session cookie
 * (`stator_sid`) is `SameSite=Lax`, which already withholds itself from most
 * cross-site POSTs — this is defense-in-depth using the browser-supplied
 * request metadata (`Sec-Fetch-Site`, falling back to `Origin`).
 *
 * Only browser-originated cross-origin writes are rejected. Requests with no
 * such signal (server-to-server API/webhook callers, the test harness) pass —
 * they carry no ambient cookie authority a forgery could abuse, and the header
 * is browser-only, so a real browser can never suppress it.
 *
 * `trustedOrigins` is an allowlist (exact or wildcard-subdomain — see
 * `matchOrigin`) of origins permitted despite being cross-site, for a decoupled
 * frontend or partner domain that legitimately writes. `same-site` (sibling
 * subdomain) is allowed by default; under `strict` (the `SameSite=Strict`
 * posture) a same-site write must match `trustedOrigins`, exactly like a
 * cross-site one — the allowlist becomes the whole gate.
 */
export function isBlockedCrossSite(
  c: Context,
  trustedOrigins: readonly string[] = [],
  strict = false,
): boolean {
  const origin = c.req.header('origin')
  const site = c.req.header('sec-fetch-site')

  if (site) {
    if (site === 'same-origin' || site === 'none') return false
    // same-site is allowed by default; under strict it must be allowlisted.
    if (site === 'same-site') return strict ? !matchOrigin(origin, trustedOrigins) : false
    // cross-site: allowed only if allowlisted.
    return !matchOrigin(origin, trustedOrigins)
  }

  // No Sec-Fetch-Site (older browsers): fall back to an Origin host comparison.
  if (origin) {
    let sameHost: boolean
    try {
      sameHost = new URL(origin).host === new URL(c.req.url).host
    } catch {
      return true
    }
    if (sameHost) return false
    return !matchOrigin(origin, trustedOrigins)
  }

  // No browser signal at all — server-to-server / webhook / test harness.
  return false
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The framework's default cross-site write guard, as composable middleware. It
 * rejects state-changing (non-safe-method) requests that `isBlockedCrossSite`
 * flags — before route matching, so a cross-site write to an unknown path 403s
 * rather than revealing its existence with a 404. Reads its `trustedOrigins`
 * allowlist from options; exported so an app on `dangerouslyDefineMiddleware`
 * can re-add it.
 */
export function crossSiteGuard(
  opts: { trustedOrigins?: readonly string[]; strict?: boolean } = {},
): MiddlewareHandler {
  const trusted = opts.trustedOrigins ?? []
  const strict = opts.strict ?? false
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && isBlockedCrossSite(c, trusted, strict)) {
      return c.json({ error: 'cross-site request blocked' }, 403)
    }
    await next()
  }
}
