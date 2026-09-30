---
title: Lazy session establishment and cacheable anonymous reads
status: draft
created: 2026-09-10
updated: 2026-09-10
area: runtime
---

## What and Why

**This spec canvasses options; it does not choose one.** The problem is real and measured, but the right shape is not yet decided — that decision needs more evidence (a real public-reading site's traffic, not just the indie-blog example's synthetic benchmark).

Measured evidence (`indie-blog-stage-a` §A5, `indie-blog-paper-cuts.md` #7, `examples/indie-blog/scripts/measure-read-path.mjs`, production path, in-memory store): **500/500 cookie-less GETs carried `Set-Cookie`** — every anonymous request mints a session — and process RSS grew **~36KB per anonymous request** (+17.8MB over 500 requests), extrapolating to **~3.5GB parked per 100k crawler/CDN-stripped requests** until the 24h TTL expires. The render itself is fast (cold 11.7ms, warm anonymous median 0.4ms); the cost is state minted for visitors who never needed any.

Why this generalizes beyond one example: a public-reading site (a personal blog, in particular) sees a much higher ratio of anonymous/crawler/scraper traffic to authenticated interaction than a typical app Stator was first proven on (an ecommerce cart, an admin dashboard) — traffic where session identity is never touched. The framework's current default (always mint + `Set-Cookie` on first touch, unconditionally) trades a real, quantified cost for a guarantee most anonymous requests never draw on.

The personal-site IndiePub-on-Stator port is the next real evidence point for this — its traffic shape (public post pages, RSS/webmention crawlers, search-engine bots) is exactly the pattern indie-blog's benchmark only approximated synthetically.

## Candidates

**1. Lazy session establishment.** Don't mint a session (no `Set-Cookie`, no server-side row) until something actually needs one — a dispatch, or a machine read that requires session identity. A route whose declared `reads` are entirely app-lifecycle machines renders identically with or without a session, so skip the mint for that shape.
- *Pro:* fixes the cost at the source — no session wasted on a visitor who never interacts.
- *Con:* needs the render path to classify a route (session-touching vs. not) before responding, and needs an answer for a route that's *mostly* anonymous but has one session-scoped affordance (a login-aware nav item) — does that force a mint for the whole route, or does that affordance need its own boundary?

**2. Marker cookie (the WordPress-logged-in pattern).** Keep minting as today, but stop using the session cookie as the cache-eligibility signal. Set a separate, small marker cookie only for actually-authenticated/interacting visitors; a CDN in front keys cache-bypass on that marker's presence, ignoring the session cookie entirely.
- *Pro:* zero engine change — pure deployment/CDN configuration, shippable immediately, no framework risk.
- *Con:* doesn't touch the underlying cost. The server still mints and stores a session per anonymous hit; this only makes the *response* cacheable at the edge, not cheaper to produce.

**3. Derived `Cache-Control` from the declared reads-graph.** A route whose `reads` are all app-lifecycle machines and whose handler never touches claims/session identity is anonymous-identical by construction — the framework already has this graph (it's the same one driving SSE fan-out) and can emit a derived `Cache-Control`, plus surrogate-key/cache-tag headers keyed to the machines the route reads, with no app-level annotation.
- *Pro:* correct-by-construction, and the same graph gives purge-on-write for free — a CDN purges pages reading machine M the instant M commits, since the SSE fan-out hook already knows that moment.
- *Con:* the most machinery of the four. Needs the reads-graph classification promoted to a real capability, plus a purge-webhook integration that's inherently CDN-specific (Cloudflare, Fastly, etc. each differ).

**4. Hybrid — (1) + (3) together, with (2) as an independent immediate stopgap.** The `indie-blog-stage-a` spec's own open-question framing already names these three as "likely layered" rather than a single winner. (2) needs nothing from this spec and can ship today for anyone fronting Stator with a CDN; (1) and (3) are the framework-level answer and share the same underlying classification (which routes are anonymous-identical), so they're naturally built together rather than as alternatives.

## Constraints

- Must not weaken the CSRF/session-identity guarantees in [[http-middleware-and-security-hardening]] — a route that legitimately needs session identity must still get one; the anonymous-identical classification must be conservative (mint when in doubt).
- Non-breaking: an app with no opinion on this keeps today's mint-always behavior.
- Whatever the framework derives, it derives from information already static and public (the declared `reads` graph) — no new required annotation, consistent with the config spec's "no required machine-graph entry point" invariant and "config owns how it runs, code owns what it does."

## Open Questions

- Where does "reads are all app-lifecycle" classification live — compile-time (matching the framework's existing static-analyzability bias — introspection manifest, agent-readable-routes) or a request-time check? Compile-time is cheaper but must survive component composition (a route embedding a component that touches session state has to inherit "needs session").
- What forces a mint mid-route on an otherwise-lazy page (a nav bar that conditionally shows "log in" vs. the visitor's name)? Does that force session-eligibility for the whole route, or is it its own boundary (a deferred/client-hydrated affordance that doesn't need the initial render to know)?
- Is the surrogate-key/purge-webhook piece a tier-2 adapter the app configures (per the config-boundary four-tier taxonomy), or purely a documented recipe per CDN, with no framework-owned interface?
- Does lazy establishment reduce the pressure to ever lower the 24h session TTL default, or are the two orthogonal?

## Implementation Notes

Not started — options record only. Evidence: `examples/indie-blog` paper-cut #7 and the `indie-blog-stage-a` spec's own "Open Questions" (which first named these candidates without picking one). This spec exists so the question has its own tracked entry rather than staying buried inside an example-scoped spec, ahead of the personal-site IndiePub-port supplying real (not synthetic) anonymous-traffic evidence.