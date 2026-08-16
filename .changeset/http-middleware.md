---
"@statorjs/stator": minor
---

HTTP middleware and a security-primitive toolkit. Add a `middleware.ts` at your app root — `export default defineMiddleware([...])` — for cross-cutting request logic (auth guards, CORS, headers). The framework's security defaults run first, then your handlers, then the route, so a guard here can't be missed by a route added later; with no `middleware.ts` the defaults still apply (safe by default). `dangerouslyDefineMiddleware([...])` opts out of the defaults — a deliberate, greppable *code* act, never a config flag, and it skips only the security defaults, never framework plumbing.

New exported middleware primitives:
- `cors()` — cross-origin *read* policy (distinct from `trustedOrigins`, which governs cross-site *writes*); reflects an allowed `Origin` for credentialed reads and answers preflight. `cors.origins` defaults to `trustedOrigins`.
- `securityHeaders()` — opt-in baseline headers (`nosniff` always; frame/referrer with safe defaults; HSTS/CSP opt-in).
- `crossSiteGuard()` — the default write guard, exported so a `dangerously…` app can re-add it.

Middleware read resolved config off the request via `stator(c)`. New config data: `origin` (canonical URL), `host` (bind address), and `cors`. `createApp`/`createDevApp` also expose the raw Hono app as `.hono` for break-glass extension.
