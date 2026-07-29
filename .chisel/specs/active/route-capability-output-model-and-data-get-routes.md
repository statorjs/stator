---
title: The route capability×output model, and data GET routes as its first cell
status: draft
created: 2026-07-28
updated: 2026-07-29
area: server
---

## Status

Part 2 (data GET routes) **shipped 2026-07-29** as designed, with one
deliberate v1 narrowing: the ETag is a body hash (handler still runs on a
304; bandwidth saved, compute not) — the revision-ledger
304-without-invoking-the-handler remains the designed upgrade and rides the
same header contract. Part 1 stays the standing model for the unfilled cells
(GET commands, command-plus-atomic-read, origin-based trust) — each is its
own spec when an app forces it.

## What and Why

Stator at the HTTP boundary is CQRS: pages project machine state, commands
transition it. 1.6 spells that with two constructors — `defineRoute` (GET,
renders a template, live-capable) and `defineApiRoute` (POST/PUT/PATCH/DELETE,
dispatch but no reads). Dogfooding a real app found the walls of that spelling
in one week:

- **A JSON consumer API is inexpressible.** `discoverRoutes` maps GET
  exclusively to `defineRoute` (`route-discovery.ts:65`) and `handleGet`
  unconditionally ships `text/html` with the client runtime injected
  (`http.ts:505,525`). The workaround was an HTTP sidecar wrapping
  `app.fetch` plus a module-level projection — the clearest
  stepped-outside-the-framework tell we have. The same wall blocks RSS,
  sitemaps, `robots.txt`, ics, csv.
- **Handler-originated commands to shared state transit a session gateway**
  (API routes can't dispatch to app machines), and gateway `REQUEST_*` events
  are dispatchable from devtools — recreating the forgeable authority-event
  the auth recipe bans. See the server-only-events entry in
  `primitive-gaps.md`.

Rather than patch each wall separately, this spec claims the model those
patches should land inside, then designs the first missing cell.

## Part 1 — the north star

**Two axes, with method as metadata.** Every route is a point in
*capability* × *output*:

| capability ↓ / output → | page (HTML, template, live-capable) | data (raw `Response`) |
|---|---|---|
| **read** | `defineRoute` (1.6) | **this spec** |
| **command** | link-click commands (future) | `defineApiRoute` (1.6) |
| **command + atomic read** | dispatch-then-render (future) | "redirect-to-created-id" (promised at `api-routes.md`, 1.x) |

The HTTP method stops being the capability discriminant and becomes routing
metadata with HTTP-semantics defaults: GET defaults to read, mutation verbs
default to command, and departures are declared, loudly. (This is what later
makes POST queries — GraphQL-shaped reads with request bodies — expressible
for free.)

**The safety invariant, restated.** What the concurrency model bans is not
"reading in a handler" — it is *interleaving*: read, dispatch, read again,
where the second read races effect completions and cross-session emits, and
preventing the race means holding the session lock across handler I/O (the
deadlock trap). Three shapes respect the invariant:

1. **Read**: hydrate the reads graph under the session lock, release, run the
   handler against the frozen actors. A coherent snapshot; nothing to
   interleave with, because the handler structurally cannot dispatch.
2. **Command**: dispatch under the lock, effects scheduled after commit,
   never under the lock — exactly today.
3. **Command + atomic read**: dispatch, then read/render *in the same lock
   hold*. This is not new machinery — it is what `/__events` already does
   (baseline render → `processEvent` → recompute, `http.ts:326-377`).
   Exposing it to command routes fills the two remaining cells and demotes
   `/__events` to an instance of the general shape.

**Origin-based trust.** The trust rule that dissolves the
server-only-events, app-dispatch, and gateway-forgeability findings together:
*server-origin code* (route handlers, effects, `dispatchToApp`, cron) may
dispatch server-only events and reach app machines; *the wire* (`/__events`)
reaches session machines only, declared events only. Trust keys on origin,
never on lifecycle + transport path. Designed separately (ROADMAP:
server-only events); named here because the matrix depends on it — a GET
command endpoint is server-origin, so it may carry authority the wire never
could.

**GET commands are real, and opt-in.** The genuine GET-that-mutates cases
are link-click flows — magic-link login, email confirmation, unsubscribe,
OAuth callbacks — where the client (a mail reader, a browser navigation) can
only GET. Decided 2026-07-28: supported, as an *explicit declaration*, with
the consequences documented honestly:

- **CSRF protection is impossible** for a link-click GET (a cross-site GET
  *is* the use case), so the cross-site block that guards command routes
  does not apply; in-band proof is required instead. The auth recipe's rule
  generalizes: the event proves itself (a one-time token verified in the
  synchronous guard) or grants nothing. A GET command without proof is a
  confused-deputy generator (`<img src="/api/admin/delete?id=1">`).
- **Prefetchers will click the link** — unfurlers, mail scanners — before
  any human does, sometimes repeatedly. Idempotency is the primary case,
  not an edge: a consumed one-time token guard-drops the second GET
  (`committed: false` → render "already confirmed"). The machinery already
  behaves correctly; the docs must set the expectation.
- A link command usually wants to *render the outcome* — which is the
  command-plus-atomic-read cell wearing page output, not a new shape.

**Simplicity accounting.** The concept count is three capabilities × two
outputs, not five route kinds. Constructor names are cheap; concepts are
not. The surface should let the three capabilities show through, and 2.0 —
if the naming ever breaks for other reasons (see the ROADMAP surface-hygiene
note on the `reads` family) — becomes a rename, not a rethink.

## Part 2 — the first cell: data GET routes

A GET route with read capability and data output: serve JSON (or XML, text,
ics, csv) computed from the machines the route reads.

```ts
// routes/api/collections/[name].ts
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Sites],
  handler: (request, { machines }) =>
    Response.json(machines.SitesMachine.forConsumers()),
})
```

### Discrimination: the brand, not the filename

Discovery already loads every route module and checks constructor brands
(`route-discovery.ts:65-69`) — so page-vs-data GET forks on the export's
brand, and compiled `<name>.stator.ts` pages stay unambiguous. This is the
decisive difference from Astro, which must classify statically from the
filename (`.astro` vs `.ts`) because its discovery never loads the module.
Nothing in the dev server, the production build, or Vite middleware ordering
needs to know the route kind before module load (checked 2026-07-28).

### Spelling: capability declared on `defineApiRoute` (recommended)

One constructor; a `method: 'GET'` literal discriminates the options union,
so GET handlers are typed with `{ machines }` (read proxies, no `dispatch`)
and command handlers keep today's `{ dispatch, rotateSession }` unchanged —
zero migration. Discovery cross-checks the declared method against the
export name (a mismatch is an error in the same family as today's
constructor-mismatch errors, which since 2026-07-28 fire even when the bad
export is the file's only one).

Alternatives considered:

- **`defineQueryRoute`** (a third constructor): maximum
  legality-in-constructors purity, but adds a concept and reads as "GET is
  not a real API route" — and once GET commands exist, method-implies-
  capability is dead anyway, so the constructor split buys less than it
  costs.
- **Method-keyed `defineApiRoutes({ reads, GET: h, POST: h })`**: the nicest
  mixed-file DX (shared reads, each handler perfectly typed, no
  name/declaration mismatch possible), but a second authoring surface beside
  the existing one. Worth revisiting if mixed-method files turn out to be
  the common case.

Note mixed files need no new mechanism in any spelling: discovery already
merges same-URL exports across files, and one file exporting
`GET` + `POST` works today.

### The read context

`machines` is keyed by machine name and backed by the same
`createInstanceProxy` selector proxy frontmatter reads use
(`instance-proxy.ts`): session machines hydrate via `loadGraph`, app
machines resolve through `store.appInstance` — the `SessionRuntime.proxyFor`
fallback already implements exactly this. Lock discipline: hydrate under the
session lock, release, run the handler against the frozen actors. The lock
is never held across handler I/O; the handler cannot dispatch, so there is
nothing to interleave with. This is the dual of `api-routes.md`'s settled
position — the "will not exist in any version" sentence targets reads
interleaved with dispatches in async handlers, which a dispatch-free handler
cannot do.

### The extension convention (DX sugar, not mechanism)

Astro's `data.json.ts` idea survives as pure DX because the brand carries
the load:

- **URL half — already works.** `filePathToRoute` strips only the final
  extension (`route-discovery.ts:202`): `rss.xml.ts` → `/rss.xml` today.
- **Content-type half — new, trivial.** For a data GET, infer the default
  from the *URL's* extension at response time (extend `contentTypeFor`,
  `http.ts:532`): a plain object/array return is JSON, always; a string
  return takes the extension's type (else `text/plain`); a raw `Response`
  passes through, `Content-Type` filled only if the handler set none.
- **Validation layer.** An extension-named file (`*.json.ts`, `*.xml.ts`)
  is unambiguously a route — discovery hard-errors on malformed exports in
  one, never skips. (`.stator.ts` keeps its existing, different second-level
  meaning; the namespaces don't collide.)
- **Extensionless stays first-class.** A clean-URL consumer API
  (`GET /api/collections/:name`) declares no extension and defaults to
  JSON. The extension is for when the URL *should* carry the type
  (`/rss.xml`, `/sitemap.xml`, `/robots.txt`).

### Free conditional GETs

The framework owns the state-change ledger, so it can stamp `ETag` from the
read machines' revisions and answer `If-None-Match` with 304 *without
invoking the handler* — polling consumers become no-ops between commits.
This falls out of the same touch-tracking fan-out already uses; no handler
cooperation needed.

### Dev parity

The dev server's Vite middlewares see requests first (`dev.ts`), so:

- `GET /rss.xml` must fall through to Hono when no such file exists on disk
  (it does — Vite serves only real files/modules) — but a stray
  `public/rss.xml` would shadow the route silently. Discovery should warn
  when a static file shadows a data route.
- The loader parity lesson from the raw-`Response` finding applies: every
  behavior above gets asserted through `createDevApp` (Vite-loaded modules)
  *and* `createApp` (native loader), in the same test file.

## Non-goals (this spec)

- Implementing GET commands or command-plus-atomic-read — Part 1 fixes their
  place in the model; each is its own spec when an app forces it.
- Server-only events / origin-based trust — designed separately (ROADMAP);
  Part 1 only states the dependency.
- Live data routes (re-running a query on touched-machine fan-out, streaming
  the result). The ETag design deliberately leaves this door open — a data
  route's staleness signal is the same ledger — but liveness stays
  page-territory until something real asks.

## Open questions

- Dev banner: do data routes count in the routes total as-is, or split
  ("7 routes, 2 data")?
- `HEAD`: answer from the ETag path for free, or leave to the handler?
- Should a data GET be able to opt *out* of the session cookie entirely
  (a public API probably shouldn't mint sessions for every poller)? Touches
  the session-TTL story for anonymous high-volume consumers.
- The `method: 'GET'` literal is stated twice (export name + field). Live
  with the redundancy (it is what makes the types select), or is the
  method-keyed `defineApiRoutes` worth its surface after all?
