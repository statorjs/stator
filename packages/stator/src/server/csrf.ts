import type { Context } from 'hono'

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
 * Note the primary vector blocked is `cross-site`. `same-site` (sibling
 * subdomain) is allowed so legitimate multi-subdomain deployments keep working;
 * harden with `SameSite=Strict` / an app-level check if subdomains are
 * untrusted.
 */
export function isBlockedCrossSite(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'cross-site'
  const origin = c.req.header('origin')
  if (origin) {
    try {
      return new URL(origin).host !== new URL(c.req.url).host
    } catch {
      return true
    }
  }
  return false
}
