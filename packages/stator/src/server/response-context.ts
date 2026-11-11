import type { Context } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'

/**
 * A `Response` a handler built itself (`new Response(…)`: a download, a
 * proxied body, a redirect) carries none of what the request's context
 * gathered on the way in: headers a middleware set before the route ran
 * (`securityHeaders()`, `cors()`), the session cookie, a rotated id, the
 * cookie jar. Hono applies those only to responses built through the context.
 * This rebuilds the response through it. The handler's own headers win, and
 * `Set-Cookie` from both sides is kept.
 */
export function withContextHeaders(c: Context, res: Response): Response {
  const headers: Record<string, string | string[]> = {}
  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  const cookies = res.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return c.newResponse(res.body, res.status as StatusCode, headers)
}

// Requests whose `Cache-Control` the framework derived, as opposed to one the
// app set by hand.
const derived = new WeakSet<Request>()

/** Record that this response's `Cache-Control: public` is the framework's. */
export function markDerivedCaching(c: Context): void {
  derived.add(c.req.raw)
}

/**
 * The derived header claims the response is the same for everyone. A
 * `Set-Cookie` on it, from middleware or a handler, says otherwise, and a
 * shared cache that stores it would hand one visitor's cookie to the next.
 * Run once the whole stack has had its say.
 */
export function withdrawCachingForCookies(c: Context): void {
  if (!derived.has(c.req.raw) || c.res.headers.getSetCookie().length === 0) return
  try {
    c.res.headers.delete('cache-control')
  } catch {
    // Immutable headers. Assigning `c.res` over an existing response copies
    // the old headers back, so clear it first.
    const headers = new Headers(c.res.headers)
    headers.delete('cache-control')
    const rebuilt = new Response(c.res.body, { status: c.res.status, headers })
    c.res = undefined
    c.res = rebuilt
  }
}
