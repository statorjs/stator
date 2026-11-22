---
title: 'Per-visitor content on a cached page: late routes, request locals, and the load-time sync'
status: draft
created: 2026-11-22
updated: 2026-11-22
area: server
---

## What and Why

Two reports, one problem.

**A session-scoped region on an otherwise cached page.** Since 2.10 a page GET is cache-marked when the framework can prove it anonymous-identical. One declared session-machine read ends that: `renderGetCandidate` computes `needsSession = route.reads.some((def) => def.lifecycle === 'session')` (`server/http.ts:1037`), establishes a session on the GET, and `deriveCacheControl` requires `!needsSession` (`http.ts:1105`). `apps/store` shows the cost: every route declares `Stator.reads([CatalogMachine, CartMachine])` only so `templates/layout.stator` can print a cart count, so no storefront page is cacheable and every crawler hit mints a session. Parked in `.chisel/docs/landing-paper-cuts.md` and in the open questions of `lazy-session-establishment-and-cacheable-anonymous-reads.md`.

**Per-request locals.** A layout cannot call `Stator.reads` (`compiler/compile.ts:570`, route-only) or `Stator.request` (`compiler/lower.ts:62`), so an IndiePub theme layout cannot show the signed-in owner an Admin link unless every route passes the owner down. Direction chosen 2026-11-16: an `Astro.locals`-style per-request object that middleware fills and layouts can see.

**Why one spec.** The Admin link is a session-scoped region on a cacheable page. Today nothing a middleware computes can reach a rendered body, which is part of why the derived header is sound: the body is a function of the URL, app machines, and inputs the framework tracks (`request.headers` via `trackedHeaders` in `server/route-request.ts`, the cookie jar in `server/cookies.ts`, claims in `readClaims`, `server/session.ts`). Locals open a channel from untracked Hono middleware into the body. Designed alone, they either make every themed page uncacheable or put one visitor's markup in a `public` response.

The design below is one mechanism with two sources feeding it. A page that is not bound to a session is rendered **for everyone**: the visitor's session state and locals are not present in that render at all. The page runtime then asks for them once, after load, only when the browser holds a session, and they arrive as ordinary patches through the initial-sync path that live pages already use (`initialSyncPatches`, `server/recompute.ts:316`).

## Success Criteria

- **Cart count.** A storefront page that reads `CartMachine` only for the header count is served with the derived `Cache-Control: public, …` and no `Set-Cookie`, to every visitor, cookie or not.
- **Admin link.** A theme layout shows the owner an Admin link with no change to any route file and no prop from the route. The themed pages keep the derived `Cache-Control`.
- **A visitor with no session costs nothing.** On a non-live page: no extra request, no cookie, no session row. Same as an app-only page today.
- **A visitor with a session** gets their values patched in by one request after load (none extra on a live page, where the SSE connect already syncs).
- **Soundness by construction.** No arrangement of middleware, locals, and templates can place per-visitor data in a response the framework marks `public`. Uses that would break the sync (reading a late machine outside `read()`, a raw claims peek beside late bindings) are render errors, not documented caveats.
- No new binding kind, patch op, or template construct. The synchronous render contract is untouched.
- Non-breaking: an app that adopts nothing behaves exactly as on 3.0.3.

## Constraints

- A wrongly `public` response is a security bug. The 3.0 audit already closed one (`withdrawCachingForCookies`, `server/response-context.ts`).
- Sessions stay lazy: nothing here may establish a session on a GET.
- Middleware is plain Hono middleware (`server/middleware.ts`) and its reads of the raw request are not tracked. The design cannot depend on what middleware did or did not look at.
- `/__events`, `/__sse` and the new sync request act on a page they name out of band. Middleware that fills locals by path must see the page's path, not the endpoint's. The admission probe (`refusal`, `http.ts:382`) already replays the middleware stack as a GET for the page URL; locals ride it.
- Compiled component libraries (IndiePub themes) import their runtime surface from `@statorjs/stator/template`; a new import is a compiled-contract question (`compiler/contract.ts`).

## Approach

### 1. Two kinds of page render

A page render is a **session render** when the route declares a session-machine read and is not marked late. That is today's `needsSession` path, unchanged: it establishes, renders the visitor's state into the first HTML, and is never cache-marked.

Every other page render is a **shared render**. It is what an app-only page already gets; two things become possible inside it:

| Source | In a shared render | After load (visitor has a session) |
|---|---|---|
| A late route's session machines | A fresh instance at `initial`, never stored | The session's real state |
| `Stator.locals` | An empty object | What middleware set for this visitor on this page |

The invariant: **the HTML of a shared render is the page as a brand-new visitor sees it.** A first-contact visitor has no session, so that HTML is already correct for them and stays correct through their first dispatch (the new session starts from the same initial state the HTML shows).

### 2. Late routes (the cart count)

One opt-in, parallel to `live`:

```stator
---
// @stator late
import CartMachine from '../machines/cart.ts'
import CatalogMachine from '../machines/catalog.ts'
import Layout from '../templates/layout.stator'

const [catalog, cart] = Stator.reads([CatalogMachine, CartMachine])
---
<Layout cart={cart}>
  …
</Layout>
```

`defineRoute({ reads, render, late: true })` is the `.ts` form. `apps/store/templates/layout.stator` does not change: `when(!!cart, () => <span class="cart-count"> · {read(cart!, (c) => c.count)}</span>)` renders `0` into the cached HTML and is patched to the visitor's count after load.

On a late route's GET:

- No session is established and the store is not read. Session machines in the reads graph are created inert: no snapshot, `seed` called with an anonymous session (`claims()` undefined), effects dropped rather than queued, no `after` timers. This is the "inert-at-birth session reads" idea the cacheable-read-path spec deferred, made explicit instead of automatic.
- The remaining proof conditions apply as they do today (no tracked header, cookie or claims read; no `Set-Cookie`; status below 300; no hand-set header). When they hold the response gets the derived `Cache-Control`.

A late route's session machines are read only through `read()` (or a `when`/`match`/`each` over one). The proxies handed to the render are guarded: `cart.send(…)` works, `cart.count` outside a selector throws a render error naming the machine and the fix. A value read outside `read()` has no slot, so the sync could not correct it, and a branch on it would shift slot ids between the cached HTML and the sync render. The guard applies to every render of a late route (GET, sync, SSE connect, `/__events` baseline), so `stator dev` hits it on first load.

It is opt-in because the automatic version is breaking: a session-reading page today has the visitor's state in its first HTML and works without script.

### 3. Locals (the Admin link)

Middleware fills, any server template reads:

```ts
// middleware.ts
import { defineMiddleware, stator } from '@statorjs/stator/server'

declare module '@statorjs/stator/server' {
  interface Locals {
    owner?: { name: string }
  }
}

export default defineMiddleware([
  async (c, next) => {
    const s = stator(c)
    const owner = s.claims<{ owner?: { name: string } }>()?.owner
    if (owner) s.locals.owner = owner
    await next()
  },
])
```

```stator
<!-- a theme's layout.stator: no route passes anything -->
<nav>
  <a href="/">Home</a>
  {when(read(Stator.locals, (l) => !!l.owner), () => <a href="/admin">Admin</a>)}
</nav>
```

- `stator(c).locals` is a mutable per-request object typed by the `Locals` interface the app augments.
- `Stator.locals` is available in route and component fences and templates (a compile error in an island). It is an opaque handle, not the object: the only way to a value is `read(Stator.locals, selector)`, with the selector typed `(l: Partial<Locals>) => R`. Property access on the handle is a type error and throws at render. `Partial` is deliberate: a shared render sees `{}`, so every selector has to say what an anonymous visitor gets.
- A locals read registers an ordinary text, attr, branch or list binding whose source name is the reserved `__locals` (machine names cannot start with `__`, `session.ts` `RESERVED_KEY_PREFIX`). No route declaration is needed because there is nothing to load: the object already exists when the render starts.
- In a session render the binding evaluates against the real locals immediately. In a shared render it evaluates against `{}` and is filled by the sync. No per-route opt-in: a layout's locals read never changes whether a page is cacheable.

Locals reach a template only for a visitor with a session, since nobody else syncs. Request data that is not about the visitor (host, a locale header) stays on `Stator.request` in the route, where the existing tracking covers it. A CSP nonce cannot ride locals. This is narrower than `Astro.locals`, and it is the price of the proof.

Locals are fixed for the life of a render state. They refresh on the next load, sync, or SSE reconnect (`rotateSession` already hangs up a session's connections, so a live page picks up a login). A dispatch does not re-evaluate them.

### 4. The sync

The first HTML of a shared render carries `<meta name="stator-sync" content="1">` when the render registered at least one binding under a late session machine or `__locals` (read off `renderState.byMachine`; it depends on the route and app state, never on the visitor).

The session cookie is `HttpOnly`, so the page cannot see whether it has a session. `setSessionCookie` (`server/session.ts`) gains a companion: `stator_s=1`, same attributes without `HttpOnly`, set whenever the session cookie is. It carries no identity. `getOrCreateSessionId` backfills it for sessions that predate the upgrade; that function only runs on session-using requests, which are never cache-marked.

The page runtime (`client/runtime.ts`), on init and on a bfcache `pageshow`:

1. No sync meta, or no `stator_s` cookie: do nothing. This is the zero-cost path.
2. Live page: nothing new. The `/__sse` connect renders against the session and enqueues `initialSyncPatches` (`http.ts:620`).
3. Otherwise: one `GET /__sync?route=<routeKey>&build=<id>`, apply the returned patches. `data-stator-sync="pending"` sits on `<html>` while it is outstanding, and `stator:synced` fires after, so a stylesheet can hold a placeholder back (`[data-stator-sync] .cart-count { visibility: hidden }`).

`/__sync` is the SSE handshake without the connection: resolve the route key, run the admission probe, `peekSessionId` (never establish; no session answers `{ "patches": [] }`), load the graph under the session lock, `renderRoute` with the session and the page's locals, return `initialSyncPatches`. `Cache-Control: no-store`, never a `Set-Cookie`. It re-emits every binding, so app-machine values that went stale in a cache are refreshed as a side effect.

Ordering with dispatch:

- A dispatch waits for an outstanding sync, so an older sync cannot land over a newer response.
- A page with the sync meta that has not synced (no marker at load) sends `X-Stator-Unsynced: 1` on its dispatches until one succeeds. The server then answers with `initialSyncPatches` taken after the event instead of the selective recompute. Consistency no longer depends on the marker being right: a stale marker, a session started in another tab, or a pre-upgrade cookie all converge on the first interaction.

### 5. Why the proof stays sound

Today's proof (`http.ts:1104`): `!needsSession && !use.used && !use.claimsRead && !use.varied`, status below 300, no cookie, no hand-set header, and `withdrawCachingForCookies` after the whole stack. `claimsRead` is set only when a claims read resolves to a value (`readClaims`); `varied` by any `request.headers` or cookie-jar read; `used` by establishment.

What changes: `needsSession` is false for a late route. Nothing else in the condition moves, and no rule is added for locals, because a shared render has no per-visitor input to make a rule about:

- Its session machines are constants: fresh, unseeded by claims, never loaded from the store.
- Its locals are a constant: the empty object. What middleware wrote to `stator(c).locals` on that request is not passed to the render. It does not matter what the middleware read or whether the framework could have tracked it.
- The sync meta is a function of the render's binding set, not of the visitor.

So a middleware cannot make a cache-marked page personal, and a locals read cannot withdraw caching, both by construction. Per-visitor values exist only in responses to `/__sync`, `/__sse` and `/__events`, none of which is ever cache-marked. `request.raw` remains the one documented untracked input, as it is now.

One existing surface could break the sync rather than the proof. `Stator.request.claims()` in a route fence is a raw value, not a binding. If a cache serves the anonymous copy to a signed-in visitor, the sync render would see claims the cached HTML was not built with, and a branch on them shifts slot ids under the patches. So a shared render that calls `request.claims()` and also registers a late or locals binding throws at the end of the render, on the call, whether or not the claims resolved: on a page with late bindings, per-visitor values enter through `read()` only. Pages that only peek claims, as 2.12 allowed, are unaffected.

### 6. Where it lives

| Piece | File |
|---|---|
| `late` on `RouteDefinition` / `defineRoute` | `server/routing.ts` |
| `// @stator late` pragma | `compiler/compile.ts` (`VALID_PRAGMAS`, route emit) |
| Inert session machines | `server/session-runtime.ts` (a `loadInert` beside `loadOne`) |
| Guarded proxies for a late route's render | `server/instance-proxy.ts`, `server/render.ts`, unwrap in `template/read.ts` |
| Shared-render branch, sync meta, claims-peek check | `server/http.ts` `renderGetCandidate` |
| `/__sync`, shared with the SSE handshake | new `server/sync.ts`, mounted from `http.ts` |
| Unsynced dispatch | `/__events` in `server/http.ts`; header in `client/transport.ts` |
| `stator_s` marker | `server/session.ts` |
| Runtime sync, `data-stator-sync`, `stator:synced` | `client/runtime.ts` |
| `stator(c).locals`, `Locals` | `server/context.ts`, exported from `server/index.ts` |
| Locals from the admission probe | `server/http.ts` (`refusal` returns the probe's locals) |
| `RenderState.locals`, `__locals` source | `server/render-context.ts`, `server/render.ts`, `server/recompute.ts`, `template/read.ts` |
| `Stator.locals` macro and types | `compiler/compile.ts`, `compiler/lower.ts`, `editor.ts` (`StatorMacros`), `template/index.ts` |

## Alternatives Considered

**1. A recipe: an island that fetches a data GET route.** Works today, with costs. A `defineApiRoute({ method: 'GET' })` that reads a session machine establishes a session (`query-route.ts:82`), so the naive island gives every anonymous visitor a cookie and a request; avoiding that needs a marker the app has to invent, because `stator_sid` is `HttpOnly`. The count lives in two places (the island's markup and a JSON shape). It is outside the reads graph, so a dispatch that changes the cart does not patch it and the island has to refetch on its own. Every theme would ship script for one link. The `stator_s` marker from this spec makes the recipe viable for apps that want it; it is not enough to be the answer.

**2a. A `session()` region or a session-aware `defer`.** A new construct whose anonymous arm renders into the cached HTML and whose real arm replaces it. It is a new binding kind at the identity seam, and `defer` is deliberately not a binding (`DeferRecord`, `server/render-context.ts`). `read()` and `when()` already express "this value changes after first paint". The roadmap's defer placeholder-and-stream does not help either: a region streamed in the same response is cached with it.

**2b. Eager at the origin, late through a cache.** Render the visitor's truth when a cookie arrives, the anonymous page otherwise, and sync only the anonymous copy. No flash for visitors who reach the origin. But the page then exists in two structural variants, the sync has to be told which one it is patching, and the dev server (no cache) never exercises the late path. One behaviour everywhere is worth one request.

**2c. Late by default for every session read.** Breaking: first HTML loses the visitor's state, and a machine whose initial state loads on entry would never load for a visitor without a session.

**3. Astro server islands / Next partial prerendering.** Server islands: a deferred component becomes a placeholder plus a script that fetches a per-island HTML fragment. That needs a component address registry, props serialised into the URL (Astro encrypts them), a fragment-render entry point, and one request per island; the fragment is static once swapped in. PPR streams dynamic holes into a prerendered shell in one response, which needs a streaming renderer and a host that understands the split. Stator already has what both build: the route key is the address, slots are the regions, patches are the transport, the initial sync is the fill, and one request covers every region on the page. What it lacks is first-byte personalisation, which no cache-agnostic design has.

**4a. Locals as a plain object; a read withdraws the proof.** The Astro-faithful shape, and sound. Every themed page becomes uncacheable the moment the layout looks at `locals.owner`, silently. Softening it to "only a defined value withdraws" (the claims rule) makes `locals.isOwner = false` a site-wide cache kill and assumes `undefined` means anonymous, which the framework cannot know about a value middleware computed. And a plain value has no slot, so a late page could not correct it. **Runner-up.**

**4b. Two kinds of locals, visitor-independent and visitor-dependent.** Sound only if the framework can check the declaration, and it cannot: middleware reads are untracked. It would be the documented caveat this spec is meant to avoid.

**4c. A tracked resolver instead of middleware** (`defineLocals((request) => …)` over the tracked `RouteRequest`). The existing proof would cover it with no new rule, but it is a second place to put request logic, and its values would still be plain and unpatchable.

**4d. Claims only** (`read(Stator.claims, …)`, no locals object). Smaller: no `stator(c).locals`, no probe plumbing. It covers the Admin link. It ties every theme to the app's claims shape, where locals let the package that owns sign-in publish a contract (`locals.owner`) themes read. Kept as the fallback if the locals PR needs to shrink.

**4e. Ambient by-def machine reads.** Declined 2026-11-16 for this report; the route would still declare the load in every file.

## Open Questions

- **Name.** `late` (`// @stator late`, `late: true`) reads well beside `live`. `cached` and `anonymous` describe the effect rather than the mechanism.
- **Flash before the sync.** `client.js` loads at the end of `<body>`, so `data-stator-sync` may land after first paint. A one-line inline script in `<head>` would set it earlier, but an inline script needs a CSP hash and the page cannot carry a nonce. Proposed: ship the attribute from the runtime only, add the inline form if the flash shows up in the store.
- **Build mismatch on `/__sync`.** `/__sse` answers a stale `build` with a reload directive. For a page a CDN is still serving stale, a reload fetches the same HTML. Proposed: `/__sync` answers a mismatch with no patches and the page stays anonymous until the cache turns over. Whether `/__sse` on a cached live page can loop today is unverified and worth its own look.
- **A late machine whose initial state has an entry effect.** The effect is dropped in the shared render, so a visitor without a session sees the loading state until they interact. Proposed: a located error at discovery.
- **Static check.** The guarded-proxy and claims-peek errors fire at render. `stator check` could flag both statically; not required for the first release.
- **Compiled contract.** A theme compiled with `Stator.locals` imports a new name from `@statorjs/stator/template`. Additive, but `tests/contract-fingerprint.test.ts` will notice; decide whether `COMPILED_CONTRACT` moves.
- **Data GET routes.** A session-reading data route still establishes. A non-establishing form is a separate, smaller question.

## Implementation Notes

Not started.

**PR 1: late routes and the sync (M).** `server/routing.ts`, `compiler/compile.ts`, `server/session-runtime.ts`, `server/instance-proxy.ts`, `server/render.ts`, `template/read.ts`, `server/http.ts`, new `server/sync.ts`, `server/session.ts`, `server/inspect.ts`, `client/runtime.ts`, `client/transport.ts`. Tests: a new `tests/late-routes.test.ts` beside `lazy-sessions.test.ts` (late GET sets no cookie and is cache-marked, with and without an arriving cookie; store untouched; `/__sync` returns the session's values and never sets a cookie; no session gives empty patches; unsynced dispatch returns the full sync; direct proxy read throws; claims peek beside a late binding throws; marker set with the session cookie and backfilled), `compiler-route.test.ts` for the pragma, `client-runtime.test.ts` for the three runtime paths and dispatch ordering, one browser test for the store header. Closes the parked question on its own.

**PR 2: locals (M).** Depends on PR 1. `server/context.ts`, `server/index.ts`, `server/http.ts` (probe locals into `/__sync`, `/__sse`, `/__events`; page GET passes `{}` or the real object by render kind), `server/render.ts`, `server/render-context.ts`, `server/recompute.ts`, `template/read.ts`, `template/index.ts`, `compiler/compile.ts`, `compiler/lower.ts`, `compiler/virtual-code.ts`, `editor.ts`, contract fingerprint. Tests: a new `tests/locals.test.ts` (a middleware that sets a local from an untracked header on every request still yields a cache-marked body with no trace of it; session render sees real locals; sync patches the branch in; probe supplies the page's locals when middleware keys on path), `compiler-component.test.ts` and `compiler-island-fence.test.ts` for the macro, `client-types.test-d.ts` or a sibling for the opaque handle.

**PR 3: docs and adoption (S).** A guide page for per-visitor content on cached pages; `reference/config.md` proof paragraph; `guides/middleware.md` for locals; `apps/store` catalog routes marked late; `examples/with-auth` layout shows a signed-in nav item through locals; ROADMAP entries for both reports.

## Decision record (2026-11-22, Tony)

- The bundled design is not being built. The two reports are split again.
- **A, the Admin link:** let layouts and components read the request's claims the way routes already can (`Stator.request.claims()`), under the existing 2.12 caching rule. No locals object, no `late`, no sync. Pending a feasibility check of why `Stator.request` is route-only. It is a first step toward the parked ambient-reads idea (components reaching per-request data), so its access path should be designed with that and head contributions in mind.
- **B, late routes and the load-time sync (the cart count):** parked until there is real evidence. The island recipe is the documented answer meanwhile. Request locals, the `stator_s` marker cookie and `/__sync` are parked with it.
