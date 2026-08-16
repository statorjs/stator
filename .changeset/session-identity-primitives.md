---
"@statorjs/stator": minor
---

Session identity primitives — the machine-unaware layer a third-party auth toolkit builds on. Stator ships the primitives, not an auth system: what a claim contains and whether it's still valid stays the app's job.

- **Session claims** — opaque per-session identity/data, readable from middleware (which runs upstream of the machine pipeline and cannot read a machine). `stator(c).claims()/setClaims()/clearClaims()` in middleware; the same three on the API-route handler `ctx`. Claims persist per session at a reserved `__claims` key; machine names may no longer start with the reserved `__` prefix. This is the projection a coarse edge-admission check needs — a redirect at the door — while your machines stay the source of truth.
- **Session lifecycle ops** — `rotateSession()` (fixation defense on privilege change: state moves to a fresh id) and `clearSession()` (delete the session, browser goes anonymous). Immediate in middleware (`await stator(c).rotateSession()`), deferred on the handler `ctx` (applied after the handler returns, so state persists before the id changes). Claims set the same request follow the rotation to the new id.
- **Cookie jar** — `stator(c).cookies` and handler `ctx.cookies`: `get`/`set`/`delete` over app-owned cookies (a login `returnTo`, a consent flag), distinct from the framework-managed session cookie. Thin over the platform; `get` reads the inbound request cookie.

The session is now established once per request and shared across middleware and handlers (one `sid`, one claims snapshot) — closing a latent double-issue on a request's first sight. A no-JS form POST that rotates the session or sets a cookie no longer drops the `Set-Cookie` on the empty-directive 204 path.

Non-breaking: apps that set no claims and touch no session ops are unaffected. The `with-auth` example gains a layered demonstration — coarse admission in middleware off the claims projection, fine-grained authorization still in the machine chart and in-route guards.
