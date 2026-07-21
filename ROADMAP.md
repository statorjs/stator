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

- **Async route loaders** *(design note first — the hard one)*: pages have
  no home for `await db.query()` / `await fetch()` because frontmatter
  renders synchronously (a permanent contract, for good reasons — it's what
  makes diffing coherent). A pre-render loader preserves that contract, but
  live-page semantics (does fan-out re-run it? cache per connection?) need
  real design before code. *Motivation*: the only gap where a first-hour
  evaluator hits a wall instead of a workaround.
- **Snapshot versioning/migrations**: hydrating old persisted snapshots
  into changed machine shapes is undefined behavior — we flushed Redis at
  our own demo cutover to dodge it. Shape: `version` on the def +
  `migrate(old)`, log-loud-start-fresh fallback. *Motivation*: silent until
  production, then data loss; small to build.
- **State timeouts (`after`)**: machines can't express "after 30s in this
  state, fire TIMEOUT"; our own nightly reset is a bare `setInterval`
  outside every abstraction. Host-scheduled per-state timers first; durable
  schedules later (pairs with durable effects). *Motivation*: small,
  teaches well, unlocks a whole class of flows (expiring carts, debounced
  saves, turn timers — planning-poker will want it).
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
- **The compose/identity seam is the standing complexity risk** *(watch, not a
  task)*: slot scopes, key scopes, element ids — the addressing layer under the
  bindings. It generated the four bugs above, and a new binding *kind* re-tests
  it (item bindings hit a keyed render-time throw in #24, caught before merge).
  The diff-*kind* surface stays small on purpose (see
  [`.chisel/docs/recompute-model.md`](.chisel/docs/recompute-model.md)); the
  guardrail is on this seam — a new binding kind or position earns its place only
  after it regression-tests the seam and clears the same evidence bar as any
  primitive. *Motivation*: this is where a fine-grained model quietly acquires
  VDOM-shaped complexity if unwatched.

## Sequencing

1. `with-auth` + the authentication recipe (co-developed)
2. "Where data lives" recipe → **async loaders design note**
3. Webhooks + file-uploads recipes
5. Snapshot versioning/migrations (implement)
6. `planning-poker` → presence findings → state timeouts (implement)
7. **Time-travel debugger spike** → findings note → ship if it holds (dev-tooling
   track; can run in parallel — it depends on nothing new server-side)

Known 1.x infrastructure (unchanged, tracked in the gap analysis): Redis
fan-out backplane, durable effects, `waitFor` coordination, lazy machine
refs, `stator check` CLI.
