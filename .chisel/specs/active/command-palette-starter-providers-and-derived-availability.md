---
title: The command-palette starter — providers, Run-as-data, and derived availability
status: draft
created: 2026-07-29
updated: 2026-07-29
area: examples
---

## What and Why

A ⌘K command palette looks like the worst possible Stator fit — an
instant-feeling, keyboard-driven, client-side overlay. Decomposed, almost
none of it is client-side:

- **The registry** (what can you do?) is global knowledge no single route
  has. In Stator it is *derivable*: the state charts already enumerate
  every legal action, and the auth recipe's audit rule — "read the chart:
  every state, every accepted event, every guard" — flips from a security
  property into a product feature.
- **Entity search** over any real dataset cannot ship to the client.
  Linear, GitHub, and Slack all round-trip for it, so the "instant" bar is
  already "debounced server search."
- **Execution** is dispatch — the thing the framework is.
- **Viewer-awareness** (you see what your role permits) is the with-auth
  `/api/notices` pattern generalized: the machines that gate pages gate
  commands.

The lineage argument (SST console): a palette-first UI let that team ship
features without deciding where they live in the IA — but their registry
was still maintained by hand. Stator's version is structurally stronger:
**a feature is an event plus a guard, and the palette derives its
reachability.** Adding a command never touches the palette.

Only the invocation layer is client: the ⌘K listener, dialog, focus trap,
highlighted index, debounced input. That is a client island — the "where
the UI genuinely needs to feel instant" case, verbatim.

## The example: Drydock

A palette-first issue tracker (things under repair, moving through stages —
the harbor naming line continues). Issue workflows are guarded machines
(`triage → in progress → review → done`), issues live as rows in SQLite
with FTS for search, roles exist from day one, and the board page is live.
The two-browser demo: execute "Move #14 to review" from the palette in one
window, watch the card move in the other — the palette as remote control
for shared state.

Pages are mostly views; actions live in ⌘K. That inversion is the point of
the example, and also what makes it a legitimate production starting point
for the SST-console-shaped app class.

## The provider contract

Providers are a **discovered directory** — `providers/*.ts`, one file per
feature, found at boot exactly like `machines/` and `routes/`. Not a
central manifest (the thing the SST team was escaping), and not
render-tree registration (kbar's model — wrong here, because the registry
is server truth and must not depend on what is rendered). Co-location by
adjacency: `providers/issues.ts` beside `machines/issues.ts`.

```ts
interface CommandProvider {
  id: string                    // doubles as the display group
  title: string                 // group heading ("Issues", "People", "Go to")
  reads?: AnyMachineDef[]       // machines availability/search read — unioned, see below
  suggest?(ctx: Ctx): Result[]  // the empty-query rows (bare ⌘K)
  search(q: string, ctx: Ctx): Result[] | Promise<Result[]>
}

interface Ctx {
  machines: RouteContext        // read proxies for this provider's reads
  route: { key: string; params: Record<string, string> }
  db: Database                  // the example's storage handle
}

interface Result {
  id: string
  title: string
  hint?: string                 // subtitle / kbd hint
  score?: number                // fuzzy-match score; palette ranks with it
  run: Run
}

type Run =
  | { kind: 'navigate'; to: string }                     // → response directive
  | { kind: 'dispatch'; machine: string; event: Event }  // → guards decide, as always
  | { kind: 'flow'; id: string }                         // → multi-step, a palette state
```

**Execution is data, never a closure.** A result row crosses the wire
carrying a serializable `Run`; the client executes by posting
`EXECUTE { commandId }` and the server resolves it through the registry.
Two properties follow:

1. **Zero added attack surface.** `/__events` means anyone can POST
   `EXECUTE` with any command id — and that is fine *because* execution
   only resolves to guarded dispatches and navigations. Availability
   filtering is UX; guards are enforcement; both derive from the same
   charts. The discipline that keeps this true: there is no
   `{ kind: 'server-fn' }` escape hatch, and the example says so out loud.
   The moment arbitrary server functions ride a `Run`, the palette becomes
   an unguarded RPC surface.
2. **Providers are unit-testable** — pure-ish functions over
   `(query, machines, db)`, no framework harness needed.

## Derived availability

For `dispatch`-kind commands, "is this available?" is a question the
engine already answers: does the target machine's current state handle the
event, and does its guard pass? Guards are pure and synchronous, so
evaluating one read-only for display is free. Mutation commands therefore
**never declare availability** — writing the machine was declaring it.
This replaces the VS Code `when`-clause DSL with the chart itself.

Provider `reads` union into the palette's reads (static after discovery —
the declared-reads doctrine holds). That puts availability on the normal
recompute/fan-out path, which yields the sleeper feature: with the palette
open on a live page, **a command appears or disappears over SSE when
someone else changes the state it depends on**. Live availability costs
this design nothing.

## Groups and flows

Group = provider: the provider's `title` is the section heading, results
rank within their group by score, groups order by best result with a
per-group cap. Groups do double duty as **flow scopes**:

```ts
interface Flow {
  id: string
  steps: Array<
    | { prompt: string; source: ProviderId }   // pick from a provider
    | { prompt: string; input: 'text' }        // free-text argument
  >
  finish(args: Args): Run                      // terminal, almost always a dispatch
}
```

"People" is a root section and the candidate source inside "Assign #14 →
who?", from one registration. Flows are **palette states** —
`root → collecting-argument → confirming` as literal machine states, so
cancel is a transition and the multi-step UX everyone hand-rolls with
component state becomes chart-readable.

## Search execution — decided 2026-07-29

**The effect path (chosen).** `QUERY` commits the query and enters a
`searching` state whose entry effect runs the async providers:

- Sync-capable providers (registry, navigation, small in-memory sets)
  resolve inline in the same POST — instant sections with the keystroke's
  response.
- Async providers (SQLite is the sync exception; Postgres/network stores
  have no sync clients) run in the entry effect. Leaving the state aborts
  `meta.signal`, so typing again cancels the in-flight query at the
  source. The completion event carries the query it answered; a guard
  drops stale results — "stale completions drop themselves" is the
  documented idiom, not new machinery. Results land as a second wave over
  SSE: progressive, Raycast-style sections, falling out of the model
  rather than built.
- Per-provider isolation inside the effect: a slow or throwing provider
  costs only its own group.

**The query-route alternative (documented, not chosen).** Search as a data
GET (`/api/palette?q=…`) is async-legal by construction (the lock releases
before a query handler runs) and maps neatly onto the capability split —
but it pulls results out of the patch system: no keyed moves under ranking
churn, no live availability, recents stop accumulating in machine context,
and the island must render JSON or inject fragments. Right shape only when
a palette is *search-only*.

## Settled constraints

- **Results are viewer-gated, assumed.** Providers read `AuthMachine` and
  filter like the notices API — fuzzy search over titles is a data-leak
  surface, and the example ships a provider that demonstrates the gating.
- **Route context is already on the wire.** Every event POST carries the
  route key, so `ctx.route` enables "Close *this* issue" with zero new
  plumbing — contextual commands are a filter predicate, not architecture.
- **Recents/frecency are palette-machine context** — session persistence
  does the product work localStorage hacks do badly.
- **Empty query ≠ search**: bare ⌘K shows recents plus `suggest()` rows,
  never an entity dump.

## What this scouts (the dogfooding payload)

1. **Where data lives** — first example with a real dataset *under* the
   machines (rows + FTS below, stateful layer above). The proving ground
   the unwritten recipe needs.
2. **The async-load seam** — abortable entry effects with stale-guarded
   completions on a hot path. Evidence for the loader-primitive gap.
3. **Session-scoped live channels** — async results arrive over SSE, and
   the palette lives on every route: an app-wide overlay wants a
   connection scoped to the session, not to a route's `live:` flag. Second
   independent forcing function (planning-poker's presence scout is the
   first).
4. **The instance-machine gap** — issues want to *be* machines but
   machines are singletons by name, so lifecycles become validated fields
   under a coordinator. Fresh evidence for lazy machine refs.
5. **Ranked keyed moves** — reordering under ranking churn stresses the
   compose/identity seam the roadmap watches, differently than
   insert/remove-heavy lists.
6. **Patching hidden DOM** — a live results list inside a closed dialog is
   an untested corner of the patch path.

## Open questions

- Does a value-changing self-transition (`searching → searching` with a
  new query) re-fire the entry effect, or does the palette need a
  two-state bounce? Verify against the engine before building.
- What does the palette do on a route that is not `live: true` — degrade
  to sync-only providers, or open a channel of its own? (This is the
  session-scoped-channel question wearing UX clothes.)
- Per-group caps: fixed N, or N with a "…more" expansion row?
- Global shortcuts: commands with `kbd` hints eventually fire without the
  palette — the registry serializing a keymap for the island is the door.
  Named, not built.

## Non-goals

Per-command priority knobs, alias/synonym systems, and i18n of command
titles (tracked as the roadmap's internationalization investigation — the
registry is an obvious catalog consumer when that lands). `keywords` plus
match score covers a starter; each of these is complexity someone can add
when their app demands it.
