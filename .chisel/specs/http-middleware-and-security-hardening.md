---
title: HTTP middleware and security hardening
status: draft
created: 2026-08-15
updated: 2026-08-15
area: runtime
---

## What and Why

2.3 introduces the user-facing **HTTP middleware seam** and formalizes Stator's **security defaults as composable middleware**. Two halves, co-cut: middleware is the *mechanism* (a `middleware.ts` for cross-cutting request logic — auth guards, CORS, headers), and the cross-site guard is its *first consumer*, so security exercises and validates the middleware API before it is public and freezes.

**Grounding reality (verified in code):** Stator already ships the CSRF default, and a stronger one than SvelteKit's. `stator_sid` is `HttpOnly; SameSite=Lax; Secure(prod)` (`session.ts`), and `isBlockedCrossSite` (`csrf.ts`) guards state-changing requests at the dispatch and `/__events` paths (`http.ts:294,411`,
403) using **`Sec-Fetch-Site`** (browser-supplied, unforgeable) with an `Origin` host-comparison fallback; server-to-server/webhook/test callers (no browser signal) pass. SvelteKit's only default is `csrf.checkOrigin` (an `Origin` check on form-content-type writes) plus `SameSite=Lax` cookies; neither framework adds hardening headers by default.

So this is **not "build CSRF"** — it is: lift the hardcoded guard into a composable, config-tunable, bypassable middleware primitive; add the *user* seam (auth guards); and ship opt-in security primitives.

**Boundary:** the HTTP/request layer only. This is **not** the event-dispatch allowlist (server-only-events / `client-dispatch-allowlist.md`) — a separate track whose own note states *"middleware must never inspect events."*

Related: [[config-api-and-the-extensibility-boundary]] (config-is-data principle, the four-tier taxonomy this security-owns-middleware decision extends), [[toolchain-adapter-seam-and-the-vite-exit]] (2.3 in the release sequence).

## Success Criteria

- A `middleware.ts` that adds user middleware (e.g. an auth guard) covering **all routes by position** — routes added later can't miss it — in dev and prod.
- Framework security defaults are **on by default** (continuing today's behavior), bypassable only via a named, greppable **code** escape — never a config flag.
- The cross-site guard (writes) and CORS (reads) are **config-tunable** (multi-domain + wildcard) without touching code.
- `cors()` and `securityHeaders()` ship as **exported, opt-in** primitives.
- Every existing app keeps working unchanged (the default guard *is* the current behavior).

## Constraints

- **Non-breaking.** The default stack reproduces today's `isBlockedCrossSite` behavior; existing apps are unaffected. New rejections happen only if an app actively narrows via config; new *allowances* only via config data.
- **Config is data, never behavior.** No `checkOrigin: true`. Turning a default off is a code act (`dangerouslyDefineMiddleware`), not a config value.
- **Middleware never inspects events.** Event legitimacy is the allowlist track.
- **Dev + prod parity.** The seam threads through both `createApp` and `createDevApp` (the Vite dual-instance needs the same care the runtime gets).

## Approach

### The middleware seam

- **`middleware.ts`** at the app root, file-discovered like `machines/`/`routes/`. Behavior lives in code, not config (the SvelteKit `hooks.server.ts` analog); config stays declarative.
- **Two authoring functions** (the bypass model):
  - `defineMiddleware(handlers)` — the blessed path: framework security defaults
    are prepended, then the app's handlers. With no `middleware.ts` at all, the
    defaults still apply — safe-by-default is absolute (no config line or file to
    delete loses them).
  - `dangerouslyDefineMiddleware(handlers)` — the escape: the handler list **is**
    the whole security stack; no defaults injected. `dangerously`-prefixed
    (React-style) so it is greppable and self-documenting — "this app owns its
    security."
  - Relationship (and the actual implementation): `defineMiddleware(h) ≡
    dangerouslyDefineMiddleware([...frameworkSecurityDefaults, ...h])`. The
    dangerous form is the primitive; the safe form is sugar injecting defaults.
  - This **replaces** granular `disable`/`replace` options: to drop or swap one
    default, drop to `dangerouslyDefineMiddleware` and re-add the exported
    primitives you want — cherry-pick by composition.
- **Scope of "defaults" = security only.** Framework *plumbing* (session handling, the wire/dispatch routing, request logging, static serving) lives in `buildHonoApp`, **not** in `middleware.ts` — so it is never bypassable. `dangerously…` means "don't auto-inject the security stack," never "break Stator."
- **Ordering:** `[security defaults] → [user handlers] → route`; the `dangerously` form is `[user handlers] → route`. Handlers are Hono-native `MiddlewareHandler`, author-ordered within the one file (no framework merge).
- **Config-on-context bridge `stator(c)`.** Middleware read app-global infra *data* (`trustedOrigins`, `cors`, `origin`, `host`) and request-scoped state (session id) off a typed Hono context; middleware-specific *options* come from constructor args. This is how `crossSiteGuard()` / `cors()` read config without the config file and the middleware file importing each other.
- **Break-glass:** expose the raw Hono `app` on `StatorApp`/`DevApp` for sub-app mount / WS upgrade — the unsupported paved-road exit.

### CSRF (writes) and CORS (reads) are DIFFERENT — the load-bearing distinction

A worked case makes it concrete. Admin site at `admin.tonysull.co`; a sibling `app.tonysull.co` wants to **read** the admin API:

- `app.tonysull.co → admin.tonysull.co` is **cross-origin** (different host) but **same-site** (same registrable domain `tonysull.co`).
- **CSRF / cross-site guard** protects *state-changing* requests. Same-site → `Sec-Fetch-Site: same-site` → **already allowed today**; and reads aren't guarded at all. So this scenario is **not** a `trustedOrigins`/CSRF need.
- **CORS** governs whether cross-*origin* JS may **read the response**. The browser requires `admin.tonysull.co` to return `Access-Control-Allow-Origin: https://app.tonysull.co` (+ `Access-Control-Allow-Credentials: true`, since the Lax cookie flows on the same-site request). **This is a `cors()` need.**

So the two config surfaces are distinct trust decisions:
- **`trustedOrigins`** → the CSRF **write** exception list: which *cross-site* (cross-registrable-domain) origins may mutate despite the cross-site block. Your own same-site subdomains never need it.
- **`cors()` origins** → the **read** allowlist: which cross-origin sites may read responses. The `admin.tonysull.co` ← `*.tonysull.co` case lives here.

Both consult the **same wildcard matcher** (below). For ergonomics, `cors()` **defaults to reading `trustedOrigins`** so one `*.tonysull.co` entry can cover both read and write trust for your own family of domains; pass `cors({ origins })` to diverge (e.g. allow a partner to read but never write).

### Controlled posture — `SameSite=Strict` + explicit allowlist (opt-in)

Today's default is permissive: the write guard blocks only `cross-site`, so every `same-site` sibling subdomain is implicitly allowed and `trustedOrigins` is *additive* (it grants cross-site writes on top). That is the right non-breaking default.

Opt into `sessions.cookie.sameSite: 'Strict'` for **allowlist-only** control:
- the `stator_sid` cookie is set `SameSite=Strict` — the browser withholds it from *every* cross-site request (the primary tightening);
- the write guard flips: `same-origin` still passes, but `same-site` is **no longer blanket-allowed** — a same-site write must match `trustedOrigins`, exactly like a cross-site one. No-signal callers (server/webhook/test) still pass: they carry no ambient cookie authority, and a Strict cookie is never sent cross-site anyway.

So under Strict, `trustedOrigins: ['https://*.tonysull.co']` becomes the *actual gate* — precisely the "I want to allowlist my subdomains" model — instead of redundant. Small to build (a cookie flag + one branch in the guard), and it unlocks the controlled use case in the same security round.

### Wildcard origin matching (shared by `crossSiteGuard` + `cors`)

Entries are origins with scheme, exact or wildcard-subdomain:

```ts
trustedOrigins: ['https://*.tonysull.co']               // wildcard cross-site WRITES
// cors.origins defaults to trustedOrigins, so the line above also allows reads
// from *.tonysull.co; override cors only to diverge (e.g. read-but-not-write):
cors: { origins: ['https://*.tonysull.co', 'https://partner.example.com'] }
```

`matchOrigin(incomingOrigin, patterns)` (one helper, both consumers):
- **Exact:** scheme + host match (port: see below).
- **Wildcard `scheme://*.domain`:** the incoming host must **end with `.domain` and carry a non-empty subdomain label** — `app.tonysull.co` and `a.b.tonysull.co` match (any depth); the apex `tonysull.co` does **not** (list it separately). Scheme must match.
- **Boundary safety (non-negotiable):** match on domain-label boundaries via the leading-dot suffix, so `*.tonysull.co` rejects `tonysull.co.evil.com` (suffix attack) and `eviltonysull.co` (no label boundary). Never substring match.

Proposed edge defaults (open): wildcard matches **any depth**; apex **not** included by `*.`; scheme **required** in the entry; **port** optional — absent matches any port, present must match.

### Security defaults + primitives

- **`crossSiteGuard()` — the default** (lifts `isBlockedCrossSite`): `Sec-Fetch-Site` primary, `Origin` fallback, on state-changing requests, reading `trustedOrigins` from context as the cross-site **write** exception. Exported so `dangerously…` users re-add it. Named for its mechanism — **not** `checkOrigin()`.
- **`cors(opts?)` — opt-in primitive** (NOT default): governs cross-origin **reads**; wildcard origins via the shared matcher; defaults to `trustedOrigins`, overridable; handles credentials + preflight. May wrap `hono/cors` behind Stator's config/context surface.
- **`securityHeaders(opts?)` — opt-in primitive** (NOT default, matching SvelteKit and today): `X-Content-Type-Options: nosniff`, a default frame policy, `Referrer-Policy`; HSTS opt-in. No restrictive CSP by default — CSP varies.
- The opt-in primitives ship **after** the core seam + guard land in 2.3 — the release boost, not a prerequisite.

### Config additions (all data)

- `trustedOrigins?: string[]` — CSRF **write** exception allowlist.
- `cors?: { origins?: string[]; credentials?: boolean; … }` — cross-origin **read** policy; `origins` defaults to `trustedOrigins`.
- `origin?: string` — canonical URL: absolute-URL generation (SSE reconnect, redirects, OG tags, cookie domain) *and* a spoof-proof same-origin anchor.
- `host?: string` — bind address, sibling to `port`. Pure infra, not security.
- `sessions?: { cookie?: { sameSite?: 'Lax' | 'Strict' } }` — default `Lax`.
  `Strict` opts into the controlled posture above (cookie withheld cross-site + the write guard becomes allowlist-only). `None` is intentionally not offered.

## Alternatives Considered

- **`defineMiddleware({ disable, replace })`** — granular opt-out flags. Rejected for the two-function model: compose via `dangerouslyDefineMiddleware` + exported primitives; the escape is one obvious, greppable act.
- **One combined "trusted origins" list for both CSRF and CORS** — rejected as the *model* (they are different trust decisions), but honored as an ergonomic *default* (`cors.origins` falls back to `trustedOrigins`).
- **`checkOrigin()` name** — rejected; misdescribes the `Sec-Fetch-Site` mechanism.
- **Default security headers / default CSP** — rejected as defaults; shipped as the opt-in `securityHeaders()`.
- **Substring / naive suffix host matching** — rejected: the suffix-attack class (`tonysull.co.evil.com`) makes label-boundary matching mandatory.

## Open Questions

- Wildcard specifics: any-depth vs single-level; apex inclusion; port semantics; scheme requirement (proposed answers above).
- `cors.origins` default = `trustedOrigins`: is the auto-share safe, or should the two always be explicit? (Lean: default-share for the same-family common case.)
- Context accessor shape (`stator(c)` helper vs raw `c.get('stator')`) and its typed surface.
- Dev dual-instance: how `middleware.ts` loads through the Vite runtime.

## Implementation Notes

Sequencing within 2.3 (co-cut, seam validated by its first consumer):
1. **Middleware seam:** discovery, the `stator(c)` context bridge, ordering, `defineMiddleware` / `dangerouslyDefineMiddleware`, raw-Hono break-glass. Pattern tests (ordering, all-routes coverage, bypass).
2. **`crossSiteGuard()` + `matchOrigin`:** lift `isBlockedCrossSite` into the default stack; add `trustedOrigins` matching (exact + wildcard) with boundary-safety tests (`tonysull.co.evil.com` / `eviltonysull.co` must fail); add the `sessions.cookie.sameSite: 'Strict'` allowlist-only branch (cookie flag
   + the same-site-requires-allowlist guard path).
3. **Opt-in primitives:** `cors()` (reusing `matchOrigin`), `securityHeaders()` — the release boost.
4. Docs (middleware guide, security guide, config reference) + changeset.

Explicitly out of 2.3: the event-dispatch allowlist (server-only-events track), `env`/`LOG_LEVEL` loader (2.5), version/build-id (2.6), first-party rate-limiting.
