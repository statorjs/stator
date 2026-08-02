# Roadmap

How items earn a place here: Stator 1.0 shipped only after a full
application ([the demo](https://demo.statorjs.dev)) was built against the
API and every paper cut was logged and adjudicated. The roadmap keeps that
method — **content doubles as evidence**. Examples pressure-test the
framework; what they prove missing becomes a primitive; what they prove
awkward becomes a recipe. The full gap analysis (with evidence and design
sketches) lives in
[`.chisel/docs/primitive-gaps.md`](.chisel/docs/primitive-gaps.md); items
promote from there to here when the evidence is in.

## Example starters

**Why this category**: starters are *app shapes people build on* — they
teach by being run, gutted, and extended, and every one is scaffoldable
(`pnpm create stator my-app --template <name>`). They're also how the
framework gets stress-tested: the storefront demo found eight real bugs
before 1.0; each new example is aimed at surface nothing else exercises.

Shipped: `minimal`, `todomvc`, `desksmith` (the tutorial's finished app),
`live-poll` (shared app state over SSE). The reference storefront stays in
`apps/store` (it's deployed) and scaffolds directly via
`--template github:statorjs/stator/apps/store`.

- **`with-auth`** *(shipped 2026-07-14)* — login/logout with hashed
  credentials, gated routes, role-guarded machines, per-user durable state,
  and session rotation (which shipped as a framework primitive,
  `rotateSession()`, because this example demanded it).
  *Motivation*: the most-asked question any framework gets, and Stator's
  answer is genuinely distinctive — identity is *addressing* (events arrive
  into the sender's session; there's no userId field to forge), and
  authorization is guards reading the session's `AuthMachine`. Doubles as
  the pressure test for the **user-lifecycle** gap.
- **`planning-poker`** — multiplayer estimation rooms: URL-keyed shared
  state, per-session roles, reveal mechanics.
  *Motivation*: the multiplayer-room shape (games, retro boards, collab
  tools) is a common starting point, and it only lands experientially — two
  browsers or it didn't happen. Doubles as the scout for the **presence /
  connection-lifecycle** gap.
- **`weather`** *(in progress)* — a Metro-styled multi-location weather app on
  keyless Open-Meteo: one feature exercises entry effects, `after`
  revalidation, a transition effect, a cross-machine subscription, live client
  islands (canvas sky, flip/peek tiles), and server-canonical settings synced
  across tabs.
  *Motivation*: the densest single exercise of the effect model + islands we
  have — and it earned its keep immediately, surfacing two live-path
  correctness bugs (see **Runtime correctness** below).

## Docs recipes

**Why this category**: recipes are *patterns you graft into an app you
already have* — problem-shaped, short, searchable, and far cheaper to
maintain than workspace members. New "Recipes" section in the docs sidebar.

- **Authentication** — the distilled rules from `with-auth`: identity is
  addressing; guards are authorization; identity in emit payloads comes
  from server-side context, never the client event. *Motivation*: the guide
  is what search finds; the example is what proves it runs.
- **Where data lives** — machines hold UI-relevant state; datasets live in
  real storage (frontmatter reads, effects write); why a 10k-row context is
  a self-inflicted perf cliff (contexts are structuredCloned per transition
  and persisted per touch). *Motivation*: the second most-asked question
  ("where's my database?"), currently unanswered anywhere — and the doc
  that motivates the loader primitive below.
- **Receiving webhooks** — `dispatchToApp` from an API route, idempotency
  against duplicate delivery. *Motivation*: the one dispatch plane no
  example or guide covers.
- **File uploads** — multipart via `request.formData()`, where bytes belong
  (not in machines). *Motivation*: short, gotcha-dense, universally needed.

## Primitives

**Why this category**: these are the gaps where our own code stepped
*outside* the framework to solve a problem — the tell that separates a
missing primitive from a missing recipe. Only high-confidence items appear
here; the speculative tail stays in the gap analysis until an example
promotes it.

- **Async data on pages** *(shipped as `defer`)*: `defer(thunk, { ready,
  error })` marks an async region the framework resolves *outside* the
  synchronous render — kicked during render, awaited in parallel with every
  other defer on the page, rendered inline as complete HTML. Frontmatter
  stays synchronous (the permanent contract), and the live-page question
  got a firm answer: a defer slot is static, never re-diffed, and a machine
  read inside an arm is a build-time error. The *reactive* door is a
  machine with a `loading → ready | error` entry effect. What remains is
  the designed-in, non-breaking upgrade: placeholder-and-stream. Docs: the
  "Defer vs. machine" recipe.
- **Snapshot versioning/migrations**: hydrating old persisted snapshots
  into changed machine shapes is undefined behavior — we flushed Redis at
  our own demo cutover to dodge it. Shape: `version` on the def +
  `migrate(old)`, log-loud-start-fresh fallback. *Motivation*: silent until
  production, then data loss; small to build.
- **State timeouts (`after`)** *(shipped)*: a state declares
  `after: [{ delay, send }]` — armed on entry, cancelled on exit, `delay`
  may depend on context, and a hydrating host re-arms with elapsed credit
  so a restart doesn't silently kill a countdown. Shipped alongside entry
  effects (the load role), on session and app machines both. Still open:
  durable schedules (pairs with durable effects) — in-memory timers drop on
  restart by design.
- **Server-only events / origin-based trust** *(design first)*: an event (or
  machine) declares itself server-only — dispatchable from API routes,
  effects, and `dispatchToApp`, rejected at `/__events`. The underlying rule
  keys trust on *origin* (server code vs the wire), not on lifecycle plus
  transport path — which also covers route-gated app dispatch and the
  gateway-forgeability hazard in one stroke.
  *Motivation*: two independent apps hit the same wall. `with-auth` had to
  reject the natural handler-verifies-then-dispatches shape entirely, and
  dogfooding a real app showed the gateway pattern recreates the forgeable
  authority-event the auth recipe bans unless every such event proves itself
  with HMAC ceremony. "Prove itself or grant nothing" stays the app-side
  rule; this gives the framework side of it a home.
- **Data routes (non-HTML GET)** *(shipped 2026-07-29)*: `defineApiRoute`
  with `method: 'GET'` is a read-only data route — `{ machines }` read
  proxies and structurally no `dispatch`, plain values served as JSON,
  strings typed by the URL extension (`rss.xml.ts` → `/rss.xml`), raw
  `Response` passthrough, and free conditional GETs (body-hash `ETag` +
  bodyless 304; the revision-ledger 304-without-invoking-the-handler is the
  designed upgrade). Designed in
  [`.chisel/specs/active/route-capability-output-model-and-data-get-routes.md`](.chisel/specs/active/route-capability-output-model-and-data-get-routes.md),
  which also frames the long-term capability×output route model this fills
  the first cell of.
  *Motivation*: a JSON consumer API was inexpressible in 1.6 — dogfooding
  proved it with an HTTP-sidecar workaround wrapping `app.fetch`, the
  clearest stepped-outside-the-framework tell yet. The same wall blocked
  RSS, sitemaps, and calendar feeds.
- **Ambient by-def reads + a typed requirement channel** *(design note first)*:
  components can't own `Stator.reads` (route-only, correctly), so the weather
  refactor threads `weather={weather}` through every tile — prop-drilling
  *state*. A component should read a machine by its imported def from the
  ambient request context (`read(WeatherMachine, …)`, symmetric with client
  `dispatch(Machine, …)`), with the dependency carried in the type and enforced
  up the tree: any renderer must provide the machine or propagate the
  requirement until a route discharges it — a compile error, not today's runtime
  throw. Designed in
  [`.chisel/specs/active/ambient-by-def-machine-reads-with-a-typed-requirement-channel.md`](.chisel/specs/active/ambient-by-def-machine-reads-with-a-typed-requirement-channel.md).
  *Motivation*: prop-drilling shared state is the first DX wall a component tree
  hits at scale; the fix is inversion of control done with types.

## Developer tooling

**Why this category**: not app-facing primitives — DX for *building* with
Stator. Held to the same evidence bar (a spike proves it before it ships).

- **Client-side time-travel debugger** *(spike first)*: scrub back through what
  happened by inverting the wire patches on the client — the framework already
  ships fine-grained, cleanly-invertible DOM ops, so a patch-inverse undo stack +
  a scrubber in the inspector gives DOM/visual history with **no** server-side
  rewind. *Motivation*: Redux-style time-travel is a top-tier debugging win, and
  Stator is unusually well-positioned for it; the design + open edges (client
  islands, focus/scroll, keyed-list ordering) live in
  [`.chisel/specs/active/client-time-travel-devtool.md`](.chisel/specs/active/client-time-travel-devtool.md).
  Spike first because those DOM edge cases are where the surprises hide.
- **Introspection manifest (machines + components)** *(unscheduled; evidence-gated)*:
  a build-time JSON manifest of the declarative surfaces — machines (states,
  events, guards, selectors, effects, timers) and components (props, island
  `static attrs` with kinds, refs, regions). Most of it is assembling what the
  compiler already computes (`dts.ts`, `LowerMeta`, `analyzeScriptClasses`). The
  reframe: this is *not* "add Custom Elements Manifest to Stator" — Stator's
  declarative surfaces, machines especially, are unusually manifest-able, and the
  highest-value first output is **statechart visualization in the inspector** (a
  machine → rendered diagram, XState-visualizer-class, which no server-canonical
  framework offers). The manifest is a *substrate* with later consumers: auto-
  generated reference docs (kills doc drift), per-state/event test scaffolding,
  a component gallery / "stories" (server-rendered against mock machine snapshots,
  not client prop-knobs — a real design seam), and LSP enrichment. Shares its
  substrate with `stator check` below. *Motivation*: it is the vision serialized —
  "read the chart to audit" made machine-readable — but nothing has stepped
  outside the framework for it yet. *Promotion trigger*: a user or example that
  hand-builds a state diagram, a component gallery, or repetitive per-state test
  stubs. Fuller framing in
  [`.chisel/docs/introspection-manifest-and-checks.md`](.chisel/docs/introspection-manifest-and-checks.md).
- **`stator check` (flow verification beyond types)** *(unscheduled; evidence-gated)*:
  static checks that types alone don't give, over the same chart-as-data substrate
  as the manifest. Stator is uniquely positioned because it holds *both* halves in
  one compile pass — the event-emission sites (`on:click={() => m.send({type})}`)
  *and* the accepting chart (states/events/guards). A spectrum, cheap-and-sound to
  hard-and-heuristic:
  - **Sound tier (no false positives, ship first):** an event in the union handled
    in *no* state (dead everywhere → any UI that sends it is a guaranteed no-op);
    a state with no incoming transition (unreachable chart node); an event handled
    only in states unreachable from `initial`. Pure graph analysis on the chart —
    trivial once it is data. This is statechart linting the declarative chart makes
    nearly free, and most frameworks *cannot* do it (their reducer is opaque JS).
  - **Heuristic tier (opt-in warnings, research-y):** the hard one — "this button,
    in the render context where it appears, sends an event the state it renders
    under does not handle." Requires correlating render conditionals
    (`when(read(m, s => s.state === 'editing'))`) with chart states. Tractable only
    for the *idiomatic* conditional pattern, delivered as warnings (false positives
    on complex conditionals), never a hard error.
  - **Honest limits:** guards make "will this commit" undecidable — checks reason
    about the *structural presence* of a handler, not whether a guard passes (a
    guard-dropped event is legitimately a runtime concern). And events arrive from
    non-UI sources too (effect returns, `after:`, `dispatch:`, subscriptions), so
    "dead" means handled-nowhere, not merely UI-unsent.
  *Motivation*: catching whole-class UI→state mistakes at CI is the tooling
  embodiment of the audit-surface thesis; the sound tier is a small, high-signal
  seed. Listed in the 1.x set in the gap analysis. *Promotion trigger*: the
  manifest substrate landing, or an example whose UI ships a dead event a check
  would have caught. Worked examples (a dead-event catch and a false-negative
  boundary) in
  [`.chisel/docs/introspection-manifest-and-checks.md`](.chisel/docs/introspection-manifest-and-checks.md).

## Surface hygiene

**Why this category**: not features — debts against the small-and-legible
surface the vision promises, recorded here so they're paid deliberately
instead of discovered by a user.

- **`/server` runtime-tier split (structural)**: the docs now draw a
  Stable-vs-Toolchain line through `/server` and `/template` (the ~45
  plumbing symbols the Vite module graph needs importable), but the split
  is policy, not structure. The structural fix is a dedicated subpath
  (e.g. `@statorjs/stator/server/runtime`) so the import path itself
  carries the tier. *Timing matters more than usual*: external usage of
  the plumbing is provably zero today, so the move is free now and becomes
  a real breaking change the day someone builds on `SessionRuntime`. Own
  PR with a dev-server smoke test — it touches the Vite module-graph seam.
- **The `reads` family naming** *(standing note, not scheduled)*: four
  surfaces share one word — template `read()`, route `Stator.reads([...])`,
  the machine option `reads:`, and `helpers.reads` in actions/guards/
  selectors. The docs disambiguate (see the reads-family table in the
  reactivity concepts page); renaming is not worth a breaking change on
  its own. IF a major break happens for other reasons, revisit the naming
  then — likely deprecating the machine option's name in 2.0 and removing
  it in 3.0.
- **Example / scaffold toolchain devDeps drift** *(found dogfooding 1.8.0)*:
  `@statorjs/stator` in scaffolded apps is version-managed (the `STATOR_RANGE`
  sync + changesets), but the *other* devDeps in the example templates —
  `typescript`, `vite`, `tsx`, `@types/node` — are hand-pinned and silently
  drift. As of 1.8.0 the examples pin `typescript ^5.6` and `vite ^6.0` while
  latest is TS 7 / Vite 8, so every scaffolded app inherits ~2-majors-stale
  tooling. Two distinct causes: TS is **pure staleness** (Stator imposes no TS
  constraint — the compiler bundles its own), safe to bump; Vite is staleness
  **plus a real ceiling** — Stator's `peerDependencies` is
  `vite: "^6.0.0 || ^7.0.0"`, so Vite 8 isn't supported until the framework adds
  it to the peer range (a change with a real test surface). Follow-ups: (a) bump
  example devDeps (TS → 7, Vite → 7) and add Vite 8 to the peer range once
  tested; (b) a freshness guard so example devDeps don't silently re-drift —
  pairs with the deferred create-stator scaffold-freshness work (real ranges,
  `latest`-ref scaffolds, scaffold-smoke CI). *Motivation*: the scaffold is the
  first-run experience; stale tooling is a silent, compounding papercut on every
  new app.

## Runtime correctness

**Why this category**: not new surface — places the framework silently does the
*wrong* thing on a natural template, found by an example and confirmed with a
runnable repro. These jump the evidence queue: a correctness bug on a documented
pattern is a bigger liability than any missing primitive.

- **Composition-boundary bugs** *(shipped, #20)*: four bugs where the
  compose/identity layer did the wrong thing on ordinary markup — element ids not
  arm-scoped (patches mis-targeting inside `match`/`when`/`each` arms), a `read()`
  in an arm resolving against a frozen proxy, and `class`/`class:list` + root
  attributes dropped instead of merged. Surfaced by `weather`, fixed together;
  specs in
  [`shipped/`](.chisel/specs/shipped/conditional-arm-interiors-are-second-class-on-the-live-update-path.md).
- **Region wrappers break tables; we mutate the user's DOM** *(shipped 1.8.0)*:
  every reactive region (`each`/`when`/`match`/`defer`) wraps its body in a
  `<span style="display:contents">`. Inside `<table>`/`<tbody>`/`<tr>`/`<select>`
  the parser hoists the span out, so a reactive `each` of `<tr>` (a filterable
  table — the canonical admin/dashboard shape) does not render; and even where a
  span is legal, `display:contents` hides it from layout but not from the CSS
  selector graph (`.a + .b`, `:nth-child`), so we silently change which selectors
  match the user's authored elements. Fix: region boundaries become HTML comment
  markers (no box, legal anywhere), and DOM patches always materialize via
  `<template>` (the `insert` op already does; the `html` op does not — a latent
  copy of the same table bug). *This is the compose/identity seam the complexity
  review flagged*, so it is spike-first, and its acceptance test **must** run in a
  real browser: happy-dom does not implement the parser's table insertion modes,
  so the entire current suite is blind to this class (which is why it shipped) —
  the work adds the first real-browser (Playwright) test infra, itself a standalone
  win. Minor release (no API/wire change), but high regression risk. Designed in
  [`.chisel/specs/shipped/region-markers-and-template-parsed-dom-patches.md`](.chisel/specs/shipped/region-markers-and-template-parsed-dom-patches.md).
- **The compose/identity seam is the standing complexity risk** *(watch, not a
  task)*: slot scopes, key scopes, element ids — the addressing layer under the
  bindings. It generated the four bugs above, and a new binding *kind* re-tests
  it (item bindings hit a keyed render-time throw in #24, caught before merge).
  The diff-*kind* surface stays small on purpose (see
  [`.chisel/docs/recompute-model.md`](.chisel/docs/recompute-model.md)); the
  guardrail is on this seam — a new binding kind or position earns its place only
  after it regression-tests the seam and clears the same evidence bar as any
  primitive. *Motivation*: this is where a fine-grained model quietly acquires
  VDOM-shaped complexity if unwatched. The guardrail's first hard call: item
  reads inside `when`/`match`/`defer` arms are a compile error, not a supported
  position — supporting them means branch↔row context restoration, cross-owner
  machinery at exactly this seam (see the scope note in the conditional-arm
  spec). *Revisit trigger*: two more real templates carrying find-by-id machine
  reads inside arms for item-local data is the evidence bar for designing
  row-context restoration as deliberate 1.x work.

## Sequencing

1. "Where data lives" recipe (the async-data primitive shipped as `defer`;
   the recipe still owes the where-datasets-live story)
2. Webhooks + file-uploads recipes
3. Snapshot versioning/migrations (implement)
4. `planning-poker` → presence findings (state timeouts already shipped;
   presence is the remaining scout)
5. **Time-travel debugger spike** → findings note → ship if it holds (dev-tooling
   track; can run in parallel — it depends on nothing new server-side)

Known 1.x infrastructure (unchanged, tracked in the gap analysis): Redis
fan-out backplane, durable effects, `waitFor` coordination, lazy machine
refs, `stator check` CLI.
