---
title: Middleware & security
description: "Cross-cutting HTTP middleware via middleware.ts, the built-in cross-site guard, trustedOrigins, cors(), and securityHeaders()."
sidebar:
  order: 13.5
---

Stator handles cross-cutting HTTP concerns — auth guards, CORS, security headers —
with a single `middleware.ts` at your app root. Config holds *data* (which origins
you trust); *behavior* (a guard, a header) lives in code, in the middleware file.

## `middleware.ts`

Export a middleware definition as the default. Handlers are plain
[Hono](https://hono.dev) middleware and run in array order, ahead of every route —
so a guard added here can't be missed by a route added later.

```ts
// middleware.ts
import { defineMiddleware, cors, securityHeaders } from '@statorjs/stator/server'

export default defineMiddleware([
  securityHeaders(),
  cors(),
  // your own auth guard, rate limiter, etc.
  async (c, next) => {
    if (isProtected(c.req.path) && !(await isAuthed(c))) return c.redirect('/login')
    await next()
  },
])
```

The **framework security defaults run first**, then your handlers, then the route.
With no `middleware.ts` at all, the defaults still apply — safe by default, nothing
to remember.

## Middleware runs at the HTTP layer

Middleware runs *before* the per-request machine pipeline, so it sees the request
(cookies, headers, method, path) and resolved config via `stator(c)` — but **not
your machines' state**. It can't ask `AuthMachine.isAuthenticated`, because the
machine hasn't been touched yet. Fine-grained authorization that reads a machine
stays in your routes as a guard.

What middleware *can* read is **session claims** — a small, app-owned projection
of identity you mint at login (see below). That projection is enough for **coarse
admission**: redirect an anonymous visitor away from a members' area at the door,
before any route runs. The layering — coarse admission in middleware off claims,
fine-grained authorization in the machine chart and route guards — is what the
`with-auth` example demonstrates.

## Session identity — claims, lifecycle, cookies

Stator ships the *primitives* an auth flow needs, not an auth system. What a claim
contains, how you verify a password, which provider you federate to — all yours (or
a third-party toolkit's). The framework gives you three things, on `stator(c)` in
middleware and on the handler `ctx` in a route.

**Claims** — opaque per-session identity, persisted for you. Set the minimum a
coarse check needs, never the whole user record:

```ts
// routes/auth/login.ts — after verifying credentials against your own store
handler: async (request, { setClaims, rotateSession }) => {
  const user = await verify(request)        // your logic; a guard drop on failure
  if (!user) return { directives: [{ type: 'navigate', to: '/login?error=bad' }] }
  setClaims({ userId: user.id, role: user.role })
  rotateSession()                            // fixation defense — see below
  return { directives: [{ type: 'navigate', to: '/' }] }
}
```

```ts
// middleware.ts — coarse admission off the projection
async (c, next) => {
  const s = stator(c)
  if (c.req.path.startsWith('/members') && !s.claims()) return c.redirect('/login')
  await next()
}
```

Claims are a **projection**, not a second source of truth. Your machine still owns
identity; claims carry only what the machine-unaware edge needs to gate. Keep them
minimal and they can't meaningfully drift.

**Lifecycle** — `rotateSession()` moves the session to a fresh id (the fixation
defense: call it on any privilege change, so an id captured while anonymous is
worthless after login). `clearSession()` deletes the session outright (logout on a
shared machine). In a **handler** both are *deferred* — applied after the handler
returns, so state persists before the id changes, and claims set the same request
follow to the new id. In **middleware** both are *immediate* (`await`), because
there's no "after the handler" upstream:

```ts
// middleware.ts — kill a revoked session at the door
if (s.claims() && (await isRevoked(s.claims()))) {
  await s.clearSession()
  return c.redirect('/login')
}
```

**Cookies** — `stator(c).cookies` / `ctx.cookies` (`get`/`set`/`delete`) for
app-owned cookies, distinct from the framework's session cookie. The canonical use
is a login `returnTo`: middleware stashes where the visitor was headed, the login
route reads it back and redirects there.

```ts
// middleware.ts
s.cookies.set('returnTo', c.req.path, { httpOnly: true, path: '/', maxAge: 300 })
return c.redirect('/login')

// routes/auth/login.ts — consume it, guard against open redirects
const returnTo = cookies.get('returnTo')
cookies.delete('returnTo', { path: '/' })
const to = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
```

`cookies.get` reads the *inbound* request cookie — a `set` this request isn't
visible to a later `get` in the same request (standard cookie semantics).

Reserved: machine names may not start with `__` (the prefix namespaces per-session
framework keys like claims), and the session cookie is framework-managed — use the
lifecycle ops, not the cookie jar, to touch it.

## The cross-site guard (a default, always on)

Every state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) is checked for
cross-site origin — `Sec-Fetch-Site` first, an `Origin` host comparison as
fallback — and a cross-site write is rejected with 403, *before* route matching
(so a probe to an unknown path 403s rather than revealing it with a 404).
Same-origin and same-site (sibling subdomain) writes pass; server-to-server and
webhook callers (no browser signal) pass. This is on by default and needs no
configuration.

### `trustedOrigins` — allow specific cross-site writes

For a decoupled frontend or partner domain that legitimately writes cross-site,
allowlist it. Entries are exact or wildcard-subdomain:

```ts
// stator.config.ts
export default defineConfig({
  trustedOrigins: ['https://app.partner.com', 'https://*.tonysull.co'],
})
```

Matching is **boundary-safe**: `https://*.tonysull.co` matches `app.tonysull.co`
and `a.b.tonysull.co`, never `tonysull.co.evil.com`, `eviltonysull.co`, or the
apex `tonysull.co` (list it separately if you need it).

### Strict posture — `SameSite=Strict`

By default same-site siblings are allowed and `trustedOrigins` is *additive*. Opt
into allowlist-only control:

```ts
export default defineConfig({
  sessions: { cookie: { sameSite: 'Strict' } },
  trustedOrigins: ['https://*.tonysull.co'],
})
```

`Strict` sets the session cookie `SameSite=Strict` (withheld from every cross-site
request) and flips the guard: now a *same-site* write must also match
`trustedOrigins`. The allowlist becomes the whole gate.

## `cors()` — cross-origin reads

CSRF and CORS are different concerns. The guard governs cross-site **writes**;
CORS governs which cross-origin sites may **read** a response. If
`app.tonysull.co` needs to read `admin.tonysull.co`'s API, that's a `cors()` need:

```ts
// stator.config.ts
export default defineConfig({
  cors: { origins: ['https://*.tonysull.co'], credentials: true },
})
```

```ts
// middleware.ts
export default defineMiddleware([cors()])
```

`cors()` reflects the request `Origin` when it matches (never `*`, so
cookie-bearing reads work), sets `Vary: Origin`, and answers preflight `OPTIONS`
with 204. `cors.origins` defaults to `trustedOrigins`, so one entry can cover both
read and write trust for your own domains; pass `cors({ origins })` to diverge.

## `securityHeaders()` — opt-in hardening

```ts
export default defineMiddleware([
  securityHeaders({ hsts: 31536000, contentSecurityPolicy: "default-src 'self'" }),
])
```

Always sets `X-Content-Type-Options: nosniff`; `X-Frame-Options` (`SAMEORIGIN`) and
`Referrer-Policy` (`strict-origin-when-cross-origin`) with safe defaults; HSTS and
CSP are opt-in (they vary per deploy and app).

## Reading config in middleware — `stator(c)`

Middleware read resolved config off the request context, so the config file and
the middleware file never import each other:

```ts
import { stator } from '@statorjs/stator/server'

const guard: MiddlewareHandler = async (c, next) => {
  const { origin, trustedOrigins } = stator(c)
  // …
  await next()
}
```

## Opting out of the defaults

Dropping the security defaults is a deliberate, greppable **code** act, never a
config flag:

```ts
import { dangerouslyDefineMiddleware, crossSiteGuard } from '@statorjs/stator/server'

// This app owns its security — no defaults injected. Re-add what you want.
export default dangerouslyDefineMiddleware([
  crossSiteGuard(),
  // …
])
```

`dangerouslyDefineMiddleware` skips only the *security* defaults; framework request
plumbing (sessions, dispatch routing, logging, static serving) is never bypassed.

## Break-glass — the raw Hono app

For the rare thing the surface doesn't cover (mounting a sub-app, a protocol
upgrade), `createApp`/`createDevApp` expose the underlying Hono app as `.hono`.
It's the unsupported paved-road exit — mutate it before `listen`.
