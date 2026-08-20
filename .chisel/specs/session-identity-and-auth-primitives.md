---
title: Session identity and auth primitives
status: draft
created: 2026-08-16
updated: 2026-08-16
area: runtime
---

## What and Why

Auth does not generalize — the *flows* differ wildly and the *policies* are app-specific. Frameworks that tried to own auth as a system (Pilcrow → auth-astro, NextAuth/Auth.js) churned through large majors and, in Pilcrow's case, were abandoned. **Stator's job is to provide the session + request + state substrate that any auth flow leans on, and get out of the way of the auth logic itself** — so third parties can build reusable toolkits on top.

This spec records that strategy, the architectural decision behind it (middleware is *upstream of and unaware of* machines), the primitives it implies, and the 2.3-vs-2.5 split.

Related: [[http-middleware-and-security-hardening]] (the middleware seam these extend), [[toolchain-adapter-seam-and-the-vite-exit]] (the release sequence), [[config-api-and-the-extensibility-boundary]] (config-is-data). PR D of the security round is the event allowlist, `.chisel/docs/client-dispatch-allowlist.md`.

## The architectural decision: middleware is machine-unaware

Middleware sits **above** machines and never reads or writes them. Machines are already request-free (they process typed events; the session id addresses which session's machines an event lands in), so this is the existing grain, not a new constraint. The consequences:

- **Auth identity lives outside session machines** — in a token or a session-level **claims** bag the app owns — so middleware can validate a request without the machine layer. Machines become *consumers* of an established identity.
- **Coarse admission (middleware) + fine authz (routes/machines).** Middleware does "is this a valid session at all? refresh / clear / reject." Route guards do "may *this* user do *this*" reading `AuthMachine`/permissions. Same coarse-gate / fine-guard split as the event allowlist.
- **The rejection flow needs no machine reach-in.** Invalidation (expired/revoked) = delete/rotate the *whole* session (store + cookie, middleware-owned) — the machine state goes with it, nothing to signal. Selective downgrade ("log out but keep the anonymous cart") is a *normal event* through the pipeline, not a middleware concern.

This makes the middleware/machine-access question moot: middleware needs session/cookie/claims ops, **not** machine read/write. Far smaller surface, no shared-runtime/lock/dispatch-from-middleware complexity.

## Framework provides vs. library owns

**Framework primitives (this spec):**
- **Session claims** — a per-session KV (`sid → app-defined blob`), get/set/clear, readable in middleware *and* handlers. The thing middleware validates against. Not auth-specific (returnTo, tenant id, flags also use it).
- **Middleware session-lifecycle ops** via `stator(c)` — `rotateSession()` (fixation defense), `clearSession()` (logout/invalidation), read `sid`/claims.
- **Establish-once-per-request session** — one shared `sid` per request stored on the context, so middleware and route see the same session. The enabler for the above, and it closes the `getOrCreateSessionId` **double-create** bug.
- **Cookie surface** — a thin, consistent `stator(c).cookies` over `hono/cookie` (get/set/delete, full attribute options), the same shape in middleware and handlers — fixing today's three-idiom split (`response.cookies` / raw Hono / framework-internal). Thin, web-standard-adjacent, native `Response` escape; **no** `.json()/.number()` parsers (Astro's over-reach). Not built — Hono is the battle-tested library under it.
- **Signed cookies** *(SHIPPED 2.4)* — `hono/cookie`'s `getSignedCookie`/`setSignedCookie` surfaced through the same jar (`cookies.setSigned`/`getSigned`) on a config/env **secret** (`secret` ?? `STATOR_SECRET`). This *is* the "sealed short-lived state" primitive (OAuth `state`+PKCE, SSO relay, WebAuthn challenge). Sealing is a *convenience*, not a requirement — server-stored state in the `Store` keyed by an opaque cookie id is the env-free alternative. `getSigned` returns `undefined` on a missing OR invalid signature (tamper/rotation-safe); no-secret throws at call time (the local secret validation). Secret rotation (multi-key) deferred.
  - **Dogfood DEFERRED (no natural fit, 2026-08-17):** no current example has an
    OAuth/magic-link/WebAuthn flow, and signing nothing in `with-auth` (its `returnTo`
    is already same-origin-constrained) would improve — bolting it on = manufacturing a
    use case ([[feedback_evidence_before_primitives]]). The worked OAuth-`state` **recipe**
    (`recipes/sealed-state.md`, cross-linked from the middleware guide) is the substrate's
    proof-of-ergonomics. *Promotion trigger for a
    real example dogfood:* a starter that adds a genuine sealed-state flow — a
    mock-provider OAuth login or a magic-link second auth method on `with-auth` (email =
    logged link in dev, testable). Build it when the example lands, not before.

**Library / app owns (deliberately not ours — the Pilcrow trap):** the user store and schema, credential/token storage, password hashing policy, provider configs, JWT/SAML/OIDC verification, email delivery (an effect the app writes), the flow orchestration, and the UI. The app owns *how it proves validity*; the framework gives it `sid` + claims + session/cookie ops.

## Flow → framework-level needs (why this substrate is sufficient)

| Flow | Needs from the framework |
| --- | --- |
| email + password | body access · session establish + **claims** + **rotate** + **clear** |
| SSO (SAML/OIDC) | redirect · callback endpoint · sealed/short-lived relay state · session establish |
| OAuth (GitHub/Google/MS) | secure random (state, PKCE) · sealed **or** store-backed state · redirect · callback · token exchange (`fetch`/effect) · token storage · refresh in middleware · session establish |
| magic link | secure token · short-lived single-use `Store` entry · email (effect) · verify endpoint · session establish |
| passkey / WebAuthn | **client island** (`navigator.credentials`) · challenge + short-lived `Store` entry · challenge/verify endpoints · credential storage · session establish |

Everything not in bold already exists (endpoints, redirects, effects, islands, `Store`, `node:crypto`, the cross-site guard). The bold items are this spec.

## Sequencing

- **2.3 (PR C) — env-independent, ships now:** session **claims**, middleware **session-lifecycle ops**, the **establish-once** session (+ double-create fix), and the thin **cookie surface** (plain, over Hono). Validated by upgrading the **`with-auth` starter** to the layered model (middleware claims admission + route `AuthMachine` authz) — real acceptance vehicle, doubles as the reference.
- **2.5 — rides env:** **signed cookies** (= sealed state) via the env secret. Additive; unblocks nothing (store-backed state is the interim path).

## Evidence gate

These are primitives with obvious minimal shapes (a per-session KV, cookie get/set/delete over Hono), so the bar is *validate before the cut*, not *defer*. The `with-auth` upgrade is that validation — if claims-through-`rotateSession`, `clearSession`, or middleware-read feel awkward wiring a real starter, fix the primitive before shipping. No higher-level auth ergonomics ship ahead of a real toolkit (the `bind:` discipline).

## Alternatives Considered

- **Middleware reads/writes machines** (`stator(c).read`/`dispatch`) — rejected: it blurs the layer boundary and needs a shared per-request runtime + lock-span + dispatch-from-middleware. The upstream/machine-unaware model gets the same outcomes with a smaller, cleaner surface.
- **A framework-provided identity/claims *system*** (typed claims, providers) — rejected (the Pilcrow trap). The app owns validity; we give it a KV.
- **Build a cookie library** — rejected: `hono/cookie` is the battle-tested piece already under us; we only unify the surface.

## Open Questions

- Do claims survive `rotateSession` by moving to the new `sid` (yes, expected — identity persists through fixation rotation) — confirm + test.
- Are claims stored alongside machine snapshots in the session `Store` or in a separate namespace? (Lean: same `Store`, distinct key.)
- Exact `stator(c)` surface for the ops (`.sid`, `.claims`, `.rotateSession`, `.clearSession`, `.cookies`).
- Whether the plain cookie surface is PR C or its own small "cookie DX" item (it is useful independent of auth).

## Implementation Notes

<!-- Updated during/after implementation. -->
