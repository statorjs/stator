---
title: 'The cacheable read path: lazy sessions, derived Cache-Control, and the surrogate-key upgrade'
status: draft
created: 2026-08-29
updated: 2026-08-29
area: server
---

## What and Why

The ROADMAP's item 2, spec'd before building per the house rule. Measured problem (indie-blog A5, paper-cut #7): every anonymous GET mints a session and sets `Set-Cookie` — 500/500 cookie-less requests got cookies, ~36KB of RSS re-rendered per crawler poll, ~3.5GB of parked session state per 100k crawler hits until the 24h TTL. `Set-Cookie` also makes CDNs refuse to cache, so the edge cannot shield the origin: a public blog's pages are CDN-uncacheable BY CONSTRUCTION. The layered design promoted from the caching investigation, now with a production forcing function (the tonysull.co cutover wants bot traffic absorbed at the edge).

## Layer 1 — lazy session establishment

**Today**: the context bridge (`server/http.ts` `app.use('*')`) calls `getOrCreateSessionId` unconditionally; the cookie is written on first contact, before any route runs — `/static/*` and `/media/*` responses carry `Set-Cookie` too.

**The change**: no session exists until something NEEDS one. The bridge exposes a lazy handle; establishment (create sid + `Set-Cookie` + store row) happens at the first of:

- a DISPATCH into a session machine (route handler `dispatch()`, `/__events`, the internal effect-completion path for a session target)
- a session-machine READ in a route's `Stator.reads` (hydration requires identity)
- an SSE connect (`/__sse` — the connection registry is per-session)
- an explicit session op: `setClaims`, `rotateSession`, `cookies.setSigned` on the session's behalf

**Peeks never establish**: `claims()` returns `undefined` sessionless (middleware gates keep working — an anonymous /admin probe redirects without minting state); `sid` reads as null; reading APP-lifecycle machines requires nothing (app actors are process singletons). An arriving `stator_sid` cookie resumes that session exactly as today — laziness governs CREATION only.

**Compat notes**: session TTL refresh only happens for requests that carry a sid (no change); CSRF guard is header-based, sessionless-safe; the wire tests' `sidOf(first GET)` idiom breaks DELIBERATELY (tests must take their sid from the login response — the new truth).

## Layer 2 — the authed-bypass question, adjudicated

The WordPress pattern (a marker cookie the CDN keys cache-bypass on) exists for sites that render session state INTO public pages. The dogfood's answer: don't — public pages carry no owner affordances precisely so they stay anonymous-identical (the audit below). For that app class the marker cookie is unnecessary: the CDN may ignore cookies entirely on derived-cacheable routes. Apps that DO render session state on public pages keep the marker-cookie pattern as CDN configuration — documented in the caching guide, NOT framework surface. No primitive ships for layer 2.

## Layer 3 — derived Cache-Control

The framework PROVES a page anonymous-identical and says so itself — no static/dynamic route tagging, the opaque-reducer frameworks' commodity answer inverted. The proof, per GET page/data route, all statically knowable or request-observable:

1. every declared read is app-lifecycle (or there are none)
2. the handler/render touched no session surface (no claims read, no cookie write, no establishment happened)

When it holds: emit `Cache-Control: public, s-maxage=<config>, stale-while-revalidate=<config>` (config `caching: { sMaxAge, staleWhileRevalidate }`, modest defaults; a hand-set `ctx.response` Cache-Control always wins; non-provable routes keep today's no-store posture). Layers 1+3 ship as ONE framework PR in practice — the sequencing story: "the framework knows your static pages."

## Layer 4 — reads-graph surrogate keys (designed in, ships later)

`fanOut(touched…)` (`server/sse.ts`) already knows the exact commit moment and the reverse-reads graph. The upgrade: stamp derived-cacheable responses with `Surrogate-Key: machine:<name> …`, and on commit call a config-provided `purge(keys)` adapter (CDN-specific, the capability-seam pattern — never a host plugin). Never-stale CDN pages, purged the moment a machine commits; its own minor. Interim for apps now: an app-side publish effect calling the CDN purge API.

## Evidence: the tonysull.co public-surface audit (2026-08-30)

Walked every public route: `[slug]` reads only the app-lifecycle MentionsMachine; home/sections/tags/archive/about/now read NO machines (SQLite from frontmatter); feeds/sitemap/robots/OG are read-free data routes; nothing public touches claims. Session consumers are exactly `/admin*`, `/__events`, `/__sse`, and the webmention POST's gateway dispatch. The live pages' GETs are sessionless; only an opened SSE stream establishes. Every public page is anonymous-identical BY CONSTRUCTION — including because owner affordances were deliberately kept off public pages. Layer 1 alone therefore makes the entire public surface cookie-free; layer 3's proof holds everywhere it should and nowhere it shouldn't (admin pages read session machines → unprovable → uncached, correctly).

## Companion (own spec): `revision()` on data routes

Cheap conditional answers without invoking the handler — see [`seo-surfaces`](seo-surfaces-route-head-as-data-runtime-sitemaps-and-the-revision-hook.md). Complements these layers: revision answers the origin-side cost of whatever polling still reaches the origin.

## Sequencing

1. Layer 1 + layer 3 as one PR on the integration branch (pre-cutover — the bot-defense forcing function), wire-tested: anonymous GET carries no `Set-Cookie` and carries derived Cache-Control; login/dispatch/SSE each establish; claims peek doesn't.
2. tonysull.co: delete nothing (it never hand-set headers) — add CF cache rules keyed on the now-cookie-free responses; the app IS the promotion proof.
3. `revision()` (seo-surfaces spec) rides alongside for feeds + sitemap.
4. Layer 4 as its own minor ("never-stale pages") post-cutover, with the app-side CF-purge effect as the interim.
