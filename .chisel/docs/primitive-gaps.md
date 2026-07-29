# Primitive gaps — the thought experiment (2026-07-13, with Tony)

> Working analysis. The commitments promoted from here live in the public
> [ROADMAP.md](../../ROADMAP.md); items graduate when an example or real
> app provides the evidence. This file keeps the full ranked list, the
> evidence, and the speculative tail.

What real apps need that has no home in the framework today. Ranked by
confidence, with the in-repo evidence that exposed each. The tell for a
missing PRIMITIVE (vs a missing recipe): we "solved" it by stepping outside
the framework entirely.

## Discovered by dogfooding a real app (2026-07-28)

- **Data routes / non-HTML GET.** discoverRoutes maps GET exclusively to
  defineRoute and handleGet unconditionally ships text/html plus the client
  runtime — a JSON consumer API (`GET /api/...`) is inexpressible, and so
  are RSS, sitemaps, ics, csv. The dogfood workaround: an HTTP sidecar
  wrapping app.fetch plus a module-level projection the machine writes on
  its touch path — textbook stepped-outside-the-framework. Design drafted
  in the route-model spec (capability × output; the constructor brand
  discriminates page-vs-data GET, the filename extension is URL/content-type
  sugar). PROMOTED to ROADMAP.
- **Route-gated app dispatch** (the app-machines guide's 1.x candidate; now
  has evidence). API routes can't dispatch to app machines (loadGraph skips
  non-session defs), so every handler-originated command to shared state
  transits a session gateway. The gateway pattern works end-to-end — but it
  composes into the forgeability hazard below. Covered by the origin-based
  trust reframe.

## Discovered by with-auth (2026-07-14)

- **Server-only events / event provenance.** A session machine cannot
  distinguish a handler's dispatch from a devtools POST to /__events, so
  any bare "grant" event (SET_IDENTITY) is forgeable. with-auth's answer:
  events must PROVE themselves (LOGIN carries credentials, verified in the
  guard) — sound, but the ceremony suggests a primitive (an origin marker
  or a `serverOnly` event flag). Evidence: the with-auth design had to
  reject the natural handler-verifies-then-dispatches shape entirely.
  SECOND evidence point (2026-07-28 dogfooding): because handlers can't
  dispatch to app machines, authority-carrying commands must transit a
  session gateway — whose REQUEST_* events are dispatchable from devtools,
  recreating the exact forgeable shape the recipe bans; the app-side
  mitigation (HMAC over claims, verified in the sync guard) works but is
  pure ceremony. The reframe both apps point at: key trust on ORIGIN
  (server code vs the wire), not lifecycle + transport path — server-origin
  code (handlers, effects, dispatchToApp) may send server-only events and
  reach app machines; /__events reaches session machines only, declared
  events only. That one rule dissolves this entry, route-gated app
  dispatch, and the gateway hazard together. PROMOTED to ROADMAP.
- **rotateSession SHIPPED** (was the Q3 experiment): renameSession on all
  stores + API-route orchestration. Promoted off this list.
- **API-route dispatch now returns `{committed}`** (login flows need to
  distinguish guard drops) — small, shipped alongside.

## Near-certain (our own repo worked around them)

1. **Async data loaders.** Frontmatter/render is synchronous (permanent
   contract) → `await db.query()` / `await fetch()` on a page has NO home.
   Evidence: the machines-native demo dodged databases entirely; the planned
   "working with a database" guide runs straight into it. Design questions:
   loader runs pre-render (sync diff preserved); live-page semantics (does
   fan-out re-run it? per-connection cache? loader-as-pseudo-machine with
   touch semantics?). Needs a design note BEFORE it's asked publicly.
2. **Snapshot migration/versioning.** Old persisted snapshots hydrate into
   new machine shapes = undefined behavior. Evidence: we FLUSHED REDIS at
   the Desksmith→Plimsoll cutover (same-named CartMachine, incompatible
   shape). Shape: `version` on defs + `migrate(old)` hook; log-loud fresh
   fallback exists for app machines already.
3. **Scheduled time.** No statechart `after` (per-state timeout events) and
   no durable recurring schedules. Evidence: the tide reset is a bare
   setInterval in apps/store/start.ts, outside every abstraction. Two
   primitives: host-scheduled state timeouts (cheap), durable schedules
   (pairs with durable effects).

## Likely (the scoped examples will prove them)

4. **User lifecycle** — session+app exist, user doesn't; userId-keyed
   app-machine slices are the pattern; primitive needs an identity resolver
   + a third fan-out scoping rule (user-touches → that user's connections
   across devices). `with-auth` example will pressure-test.
5. **Route middleware/guards** — section-wide gating (/admin/**) vs
   copy-pasted per-page when(); natural home for session rotation on
   privilege change.
6. **Presence + connection lifecycle** — no join/leave into machines, no
   per-key "who's here". planning-poker will make the case (multi-tab ≠
   people; refresh debounce).

## Worth the thought, lower urgency

7. **Effect cancellation** — stale completions are guard-dropped but
   in-flight WORK isn't aborted; AbortSignal in effect meta on state exit.
8. **Transient context keys** — everything in context persists +
   structuredClones; a `transient` marker covers secrets, caches, and
   softens the big-context perf cliff.
9. **Rate limiting** — maybe a recipe over middleware (#5), not a primitive.
10. Known 1.x set (unchanged): Redis backplane, durable effects/outbox,
    waitFor sagas, dispatch-returns-snapshot, lazy machine refs,
    stator check CLI.

## Examples/docs plan feeding this (2026-07-13)

- Example starters: `with-auth` (+auth guide: identity-is-addressing,
  guards-as-authz, identity-from-context-never-payload), `planning-poker`.
- Recipes section in docs: auth, webhooks, file uploads, where-data-lives.
- Build order: with-auth + guide → database guide → webhook/upload recipes
  → planning-poker.
