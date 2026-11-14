import { defineMiddleware, securityHeaders, stator } from '@statorjs/stator/server'

/**
 * Two layers run here, upstream of every route.
 *
 * 1. `securityHeaders` — cross-cutting HTTP hardening. `DENY` framing suits an
 *    auth app.
 *
 * 2. Coarse admission — redirect anonymous visitors away from the members' area
 *    at the door, before any route logic runs.
 *
 * The catch this app teaches: HTTP middleware runs BEFORE the machine pipeline
 * and cannot read a machine — so it cannot ask `AuthMachine` whether you're
 * signed in. The answer is a *projection*: on login the route mirrors a minimal
 * `{ userId, role }` into session CLAIMS (see `routes/auth/login.ts`), and that
 * projection is all the edge needs to gate.
 *
 * `AuthMachine` stays the source of truth — claims carry only what coarse
 * admission needs (are-you-signed-in, and role), never the whole identity, so
 * the two can't meaningfully drift. Fine-grained authorization still lives in
 * the machine chart and in-route guards (see `routes/profile.stator`). This is
 * defense in layers, not a second source of truth.
 */
export default defineMiddleware([
  securityHeaders({ frameOptions: 'DENY' }),
  async (c, next) => {
    const s = stator(c)
    const path = new URL(c.req.url).pathname

    // The members' area. Anonymous → bounce to the sign-in page. A page
    // request stashes where it was headed, and the login route redirects back
    // there afterward; a form post (`/profile/name`) has no page to return to.
    if ((path === '/profile' || path.startsWith('/profile/')) && !s.claims()) {
      if (c.req.method === 'GET') s.cookies.set('returnTo', path, { httpOnly: true, path: '/', maxAge: 300 })
      return c.redirect('/login')
    }

    await next()
  },
])
