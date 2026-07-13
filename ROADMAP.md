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

## Sequencing

1. `with-auth` + the authentication recipe (co-developed)
2. "Where data lives" recipe → **async loaders design note**
3. Webhooks + file-uploads recipes
4. Snapshot versioning/migrations (implement)
5. `planning-poker` → presence findings → state timeouts (implement)

Known 1.x infrastructure (unchanged, tracked in the gap analysis): Redis
fan-out backplane, durable effects, `waitFor` coordination, lazy machine
refs, `stator check` CLI.
