import { defineMiddleware, securityHeaders } from '@statorjs/stator/server'

/**
 * HTTP-layer hardening for every response. `DENY` framing suits an auth app.
 *
 * Note what is NOT here: this app's identity lives in `AuthMachine` (session
 * state), and HTTP middleware runs before the session machinery and can't read a
 * machine — so authorization stays in the routes as guards reading `AuthMachine`
 * (see `routes/profile.stator`). Middleware is for cross-cutting HTTP concerns:
 * headers, CORS, and the built-in cross-site (CSRF) guard.
 */
export default defineMiddleware([securityHeaders({ frameOptions: 'DENY' })])
