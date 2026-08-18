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
- **`registration`** *(first cut 2026-08-09; browser jank verification + docs
  flip pending)* — event-registration desk leaning
  hard into forms: attendee rows (keyed, inline-editable), two-tier validation
  (shape rules as one pure function shared by client machine + server guard;
  truth rules — duplicates, capacity — server-only via typed dispatch), blur
  commits, populate-for-edit, reset.
  *Motivation*: the reactive-model proving starter (see Surface hygiene) —
  built ONLY on `ref:` + `on:` + `read()` + platform constraints, its
  paper-cut log decides what (if any) draft ergonomics ship, and its
  jank-free form experience is the exit bar before `bind:` is removed in 2.0.
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
- **Server-only events (`serverOnly` declaration)** *(shipped, 2.3)*: a machine
  lists event types no client may dispatch (effect completions, `after:` timers,
  cross-machine internals); a client `POST /__events` of one is rejected with **403**
  (403 not 404 — don't reveal which events exist), enforced in **dev and prod** (the
  declaration is explicit, so no false positives and no dev/prod divergence). The list
  is typechecked against the event union. Closes the forged-`CHARGE_APPROVED`/
  `COMMIT_OK` hazard with no compiler analysis. The completion still re-enters via the
  internal dispatch path (never `/__events`). Dogfooded on `apps/store` (cart charge
  completions) with a "Server-only events" recipe.
- **Compiler-derived client-dispatch allowlist** *(post-Vite-exit, evidence-gated)*: the
  *automatic* version — the compiler derives, per machine, the set of events client
  code actually dispatches (template `on:` + island `dispatch`) and enforces it at
  `/__events`, excluding completions/internals *by construction*. Cut from 2.3 and
  re-slotted **after the Vite exit (now 2.6)**: it needs the owned build pipeline (its
  allowlist is a build artifact) and the introspection-manifest substrate, and its
  prod-only-403 failure mode (compiler misses a legit dispatch → false 403 in prod
  only) fights the dev==prod goal the pipeline release chases — so it should land first
  as a dev-visible `stator check` lint, not a silent gate. *Promotion bar*: the manifest
  substrate landing **and** a justification beyond the manual `serverOnly` flag (real
  `serverOnly` usage painful to hand-maintain, or a non-security manifest consumer).
  Design in
  [`.chisel/docs/client-dispatch-allowlist.md`](.chisel/docs/client-dispatch-allowlist.md).
  *Motivation*: two independent apps hit the wall — `with-auth` couldn't do
  handler-verifies-then-dispatches, and the gateway pattern recreates a forgeable
  authority event unless every one proves itself with HMAC. This gives the
  framework side of "prove itself or grant nothing" a home.
- **Session identity & auth primitives** *(2.3 PR C + 2.4)*: the substrate for
  *third-party* auth toolkits — Stator provides session claims, middleware
  session-lifecycle ops (`rotateSession`/`clearSession`), an establish-once
  per-request session, a thin cookie surface over `hono/cookie`, and (2.4, on env)
  signed cookies; the app/library owns the user store, hashing, providers,
  verification, email, and UI. Middleware is **machine-unaware** (upstream of
  machines); identity lives in claims/tokens, not session machines. *We do not
  build an auth system* (the Pilcrow/Auth.js lesson). Validated by upgrading the
  `with-auth` starter. Design in
  [`.chisel/specs/active/session-identity-and-auth-primitives.md`](.chisel/specs/active/session-identity-and-auth-primitives.md).
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
- **Long-lived inbound sources — clock + subscription** *(evidence-gated;
  userland pattern is complete today, so NOT committed)*: external inputs that
  drive machines over the process lifetime — a recurring poll, a push
  subscription (Firestore `onSnapshot`, an upstream stream). They decompose into
  two mechanisms, and today **both live cleanly in userland**: create the app,
  then call your own `clock(app, …)` / `watch(app, …)` helpers dispatching via
  the bound `dispatchToApp` (reachable and store-current in dev *and* prod). No
  lifecycle hook is required — `createApp` returns after `bootAppMachines()`, so
  ordering alone guarantees the source can't start before the graph is up, and a
  `server.ts` helper survives dev rebuilds (it isn't in the Vite-reloaded graph).
  Decomposition: **poll = a recurring clock → an effect → events** (the clock
  carries no I/O; the query stays in the effect, results re-enter — needs no new
  inbound primitive, *except* a recurring clock isn't expressible via a
  self-looping `after`, which won't re-arm — `config.to !== stateKey`,
  `engine/actor.ts`); **push = a subscription source** (owns a connection, emits
  data-bearing events, the genuine inbound dual of an effect). If either ever
  becomes first-class, the push form is per-key under the family track (source
  bound to instance materialize→passivate, reusing the entry-effect abort
  signal). *Why it waits*: the userland pattern is the evidence vehicle and it
  works — pre-building a declarative `clock`/`source` seam now is exactly the
  bind-family over-commitment we don't repeat. *Promotion trigger*: shutdown-
  cleanup pain in a real app — the framework's graceful-shutdown installs its own
  SIGTERM/SIGINT handler that `process.exit(0)`s after closing the server
  (`server/banner.ts`), additively, so a push subscription's async unsubscribe
  can race the exit (harmless for a `setInterval` clock). If that bites, the
  minimal fix is a cleanup-registration seam (`app.onStop(fn)` riding the
  existing shutdown), not a full source primitive. Evidence so far: the Mayday
  spike (one poll clock + per-robot `onSnapshot`), both proven working via the
  userland path.

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
- **Own the dev/build pipeline — the Vite exit** *(decided; spike-gated
  endpoint)*: the dev toolchain has a two-layer split (`tsx` outer + embedded Vite
  inner) whose module-graph fence causes the dual-instance trap, the missing
  `.env` story, and the restart-without-reload gap. The decision is to **exit
  Vite** behind a toolchain-adapter seam (`compileAndServe`/`bundleIslands`/
  `emitProd`, core stays Vite-agnostic), via Option D (server runs native like
  prod — fence dead, raw-TS kept, dev==prod) then E (esbuild bundles islands too,
  Vite dep dropped). The `stator` CLI + `stator check` are Phase 0 of the seam.
  Two locks: the seam at pipeline-work start, dropping Vite at its tail — the swap
  is one impl, so the endpoint never blocks the start. *Spike-gated*: esbuild
  `splitting` island bundles must measure acceptable vs Vite. **Reordered to last
  (now 2.6):** its two symptom pains — `.env` and the reload gap — have targeted
  fixes independent of the re-architecture, so they ship first as **2.4** (env +
  signed cookies) and **2.5** (build-id reload), de-risking the schedule and not
  letting the Vite spike block user-visible features. Design + the release
  sequencing in
  [`.chisel/specs/active/toolchain-adapter-seam-and-the-vite-exit.md`](.chisel/specs/active/toolchain-adapter-seam-and-the-vite-exit.md).
  *Motivation*: Vite is the odd bought-in exception to Stator's own-the-pipeline
  identity, optimizing for the client-heavy/HMR world the architecture avoids;
  platform maturity (Node native TS + watch) and the no-HMR server-canonical shape
  shrink the owned surface that once argued for keeping it.

## Surface hygiene

**Why this category**: not features — debts against the small-and-legible
surface the vision promises, recorded here so they're paid deliberately
instead of discovered by a user.

- **Major-cutover pairing** *(semver policy, not a task)*: when a change
  *could* be shaped as breaking but a non-breaking shaping exists, ship the
  non-breaking shaping now and record the deferred cutover here — so the next
  major that lands for other reasons carries the cleanup. *Minor today, ride a
  major later.* This keeps every intervening release non-breaking by
  construction and makes each major pay for itself instead of spending a whole
  version bump on one removal. Live instances: the `reads`-family rename below
  (waiting for its major); and the **`/__events` declared-event allowlist** —
  the engine rejects phantom prototype-collision events now (own-property
  handler lookup; see Runtime correctness), and the boundary is shaped to
  preserve today's silent-drop for legitimately-unhandled events while
  hard-rejecting only phantom collisions and server-only-flagged events (rides
  the server-only-events / introspection-manifest track for its accepted-event
  substrate). The *blanket* reject-unknown-with-400 — the shaping that would
  force a major — is the deferred cutover: parked here to ride the next major,
  not shipped as its own break. *Motivation*: a major that removes one thing
  wastes the break; batching deferred cutovers is how the "flat machines with
  extension points" shape keeps its promise that richness arrives without a
  churn tax. Newest instance: the **flat `createApp`/`createDevApp` config keys**
  (`store`/`appStore`/`sessionTtlSeconds`/`ssePingMs`/`inspector`, shipped 2.1.0)
  — nesting them under `persistence`/`sessions`/`realtime`/`dev` (the config-file
  shape, [`config-api-and-the-extensibility-boundary`](.chisel/specs/active/config-api-and-the-extensibility-boundary.md))
  ships non-breaking in 2.2: the flat keys stay typed-and-`@deprecated`, resolved
  by `server/config-compat.ts` with a warning. Removing them is the parked cutover.
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
- **Reactive-model regrounding — remove `bind:`/`@set`** *(SHIPPED as 2.0,
  2026-08-09 — gate adjudicated against the registration paper-cut log: no
  draft primitive, the pattern is the answer)*: `read()` becomes the single display primitive (server →
  wire patch, client-local → the subscribe-and-write `bind:` generates today),
  `on:` + typed events the sole write path, `ref:` survives; two-way `@set` —
  the one place a machine's state changes without a declared transition,
  bypassing guards and types — is deleted. The replacement is a *pattern*, not
  a new primitive: the input element holds the draft under platform
  constraints (`maxlength`/`pattern`/`beforeinput`), the commit boundary sends
  one typed event read via `ref:`/`FormData` — the shape `weather` and the
  checkout page already use. Prerequisites are additive 1.x minors, in order:
  typed `use().send`, client-lowered `read()` for display, then a form-heavy
  proving example built ONLY on that minimal surface plus a `bind:`
  deprecation diagnostic. Only the removal itself is breaking. Any draft
  ergonomics — a shipped reusable machine, a wiring helper, or just a docs
  recipe — are promoted solely from the proving app's paper-cut log (the
  `bind:` lesson: no convenience primitive ships ahead of evidence again).
  *Decision gate*: the proving app livable + its log adjudicated — until then
  this is a direction, not a decision. IF it ships, it is the major the `reads` naming
  note above has been waiting for — bundle them. Design in
  [`.chisel/specs/active/`](.chisel/specs/active/isomorphic-reactive-model-read-for-display-on-for-events.md).
  *Motivation*: `bind:`/`@set` is the one surface that breaks "read the
  machine, know every way its state changes" — and the measured footprint
  (one two-way site in the whole repo; the densest island example uses none)
  says the sugar never earned its place.
- **Seam consolidation — one implementation per cross-tier contract** *(2.0
  prep; ships as a 1.x minor)*: the `registration` starter surfaced three
  framework bugs in one day and all three were SEAM DISAGREEMENTS — the same
  contract implemented in two-plus places that drifted: the island `.d.ts`
  emitter vs the hydrate contract, the page-runtime bundle vs the island
  bundle on `clientId`, and static attr rendering vs the patch path on
  boolean semantics (`checked={false}` rendered checked). The attr-value
  contract alone has FOUR implementations (`template/html.ts`, recompute's
  `attrWireValue`, the client-emit writer codegen, `wire/apply`). The house
  already has the answer — `wire/` as the single shared module both sides
  typecheck against (WIRE.md), `region-apply`'s marker constants — so apply
  that discipline, don't invent a contract framework: (1) one shared
  `attrValue(v): string | null` in `wire/` consumed by all four sites; (2)
  marker-format constants shared (client-slot `s<N>` / `data-b` literals are
  raw strings across `lower.ts`, `client-emit.ts`, `bindSlot`); (3) a
  dual-bundle audit of `client/` module state (`clientId` was one instance;
  the `use.ts` collectors stack is the next candidate); (4) seam TESTS: a
  property test pinning static-render ≡ patch-apply for attribute values,
  and a dts ≡ virtual-code island-props consistency test (the LSP calls
  `componentPropsType` directly and may still disagree in-editor).
  *Timing matters*: the 2.0 removal step rewires exactly these files
  (client-emit writers, lower.ts collection) — removing against one shared
  implementation instead of four drifting ones shrinks that break's risk.
  *Motivation*: three seam bugs found by one example
  ([paper-cut log](.chisel/docs/registration-paper-cuts.md), entry 9's
  pattern note) — the framework should walk its own seams in tests instead
  of letting starters find them.
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
- **Log-level control + a quieter prod default** *(dogfooding papercut)*: the
  server logs aggressively — `info` plus a line per connection event — which is
  right for debugging but far too noisy for production. Two parts: (1) a **log
  level** as config *data* (`logging.level`, fits "config owns how it runs"; with a
  `LOG_LEVEL` env override once env support lands), quieter in prod by default
  (warn+error) and verbose in dev; (2) **level hygiene** — demote per-connection /
  per-event chatter from `info` to `debug` so `info` is production-usable, keeping
  `info` for genuinely lifecycle-worthy events. Already pino under the hood
  (`server/logger.ts`), so this is threading a level through + reclassifying call
  sites, not new infra. *Motivation*: found dogfooding the examples — a production
  app drowns in per-connection `info` lines. Pairs with the env work (`LOG_LEVEL`),
  and `logging.level` is an additive config bag (non-breaking on the 2.2 shape).

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
