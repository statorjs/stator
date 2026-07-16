---
title: 'Entry effects + `after`: implementation plan'
status: draft
created: 2026-07-15
updated: 2026-07-15
area: runtime
---

Execution plan for the design in
[entry-effects-state-entry-async](./entry-effects-state-entry-async.md). Two
phases: **Phase 1 — entry effects** (self-contained, high value) and **Phase 2 —
`after`** (the declarative loading timeout, more infra). `exit` / `AbortSignal`
cancellation is explicitly out of both (future).

The load-bearing facts this plan builds on:
- Session effects already flow: actor `onEffect` → `runtime.pendingEffects` →
  `scheduleSessionEffects` drains + runs **off-lock**, completion re-enters under
  a fresh lock (`server/effects.ts:67-120`).
- `/__events` and API routes already call `scheduleSessionEffects` after
  persist. **GET does not** — it's read-only (`handleGet`, `server/http.ts`).
- Persistence keys on a commit-count change (`session-runtime.ts:208`); a
  fresh machine that only *entered* its initial state commits nothing.
- Transition effects fire in `actor.send`'s `config.effect` block
  (`engine/actor.ts:193-207`); `start()` fires nothing (`actor.ts:119-122`).

---

## Phase 1 — Entry effects

### 1. Engine types (`engine/types.ts`)

- Add `entry?` to `StateNode` (currently only `on`, `types.ts:133`). It's the
  `Effect` shape (`types.ts:80`) **minus `ev`**:
  ```ts
  export type EntryEffect<C, EAll extends EventObject = EventObject> =
    (ctx: C, meta: EffectMeta) => Promise<EAll | null>

  export interface StateNode<C, E, S, R> {
    on?: OnMap<C, E, S, R>
    entry?: EntryEffect<C, E>   // EAll = the machine's event union, threaded like TransitionConfig.effect
  }
  ```
- Thread the machine event union into `StateNode` the same way `TransitionConfig`
  threads `EAll`, so annotated returns (`: Promise<Events | null>`) are checked
  and an undeclared completion event is a compile error (design spec, "Return
  typing").

### 2. Engine actor (`engine/actor.ts`)

- Capture hydration state at creation: `const hydrated = opts.snapshot !== undefined`.
- Extract a `fireEntryEffect(stateKey)` helper — a copy of the transition
  `config.effect` block (`newEffectId`, `structuredClone(context)`, build the
  `EffectInvocation` with `run = () => entry(ctxSnapshot, { effectId })`, then
  `opts.onEffect(invocation)` or the local-microtask fallback) — minus the event
  snapshot.
- **Fire on entry, two sites:**
  - `start()` — after `notify()`, `if (!hydrated) fireEntryEffect(value[value.length-1])`.
    Fresh start fires the initial state's entry; a hydrated actor does not
    (design: hydration ≠ entry).
  - `send()` transition path — capture `prevLeaf` before `value = [config.to]`;
    after, `if (config.to && config.to !== prevLeaf) fireEntryEffect(config.to)`.
    Value-changing transitions only (no self-transition, no action-only).
- **Do not** bump `commits` on an entry fire — an entry is not a committed
  transition (would corrupt `committed:` on the wire and fan-out). Persistence is
  handled by the runtime instead (below).

### 3. Session runtime (`server/session-runtime.ts`)

- `loadOne` already passes `snapshot` (present ⇒ hydrated), so the actor fires
  the initial entry only on a genuinely fresh load — no change needed there.
- Add the persist signal: the machines whose entry fired on a fresh `start()`
  are exactly those with an invocation in `pendingEffects` after `loadGraph`
  (transition-fired entries are already `touched` via their commit). Expose
  `entryFiredMachines(): Set<string>` = `new Set(pendingEffects.map(e => e.machineName))`,
  and persist that set in addition to `touched` at every entry point. (Derive it
  *before* `scheduleSessionEffects` drains the queue.)

### 4. Entry points

- **`/__events` + API routes** (`http.ts`, `api-route.ts`): they already
  `persistTouched(touched)` + `scheduleSessionEffects`. Change `persistTouched`
  to cover `touched ∪ runtime.entryFiredMachines()` so a fresh machine loaded
  by the route (not the dispatched one) that fired its initial entry gets
  persisted. Scheduling already happens.
- **GET** (`handleGet`, `http.ts`) — the real new work. After `renderRoute`, if
  `runtime.entryFiredMachines()` is non-empty:
  - `persistTouched(entryFired)` and `scheduleSessionEffects(runtime, store, sessionId)`
    (fire-and-forget, after `c.html`, before `dispose` — mirror the `/__events`
    tail). The effect I/O runs post-response, off-lock; the completion re-enters
    via the existing session-effect path and reaches the page over SSE (if live)
    or on next request.
  - The common GET (no entry effect fired) is unchanged — still lock-free,
    no persist, no schedule.

### 5. Concurrency decision (the one open call)

Two concurrent first-GETs each fresh-create the machine and each fire the entry
effect before either persists (design spec, Open Questions). Options:
- **(default, v1)** accept the rare double-fire; lean on the effect's `effectId`
  as an idempotency key, matching at-most-once's best-effort stance. Zero lock
  cost on reads.
- **(hardening)** when `entryFired` is non-empty, do the persist under
  `withSessionLock(sessionId)` and re-check (hydrate; skip if the snapshot now
  shows the state already entered). Serializes first-GETs at the cost of a
  conditional lock on the *rare* entry-firing GET only.

Recommend shipping the default and revisiting if the double-fire bites.

### 6. Tests (Phase 1)

- Engine: a machine with `initial: 'loading'` + `entry` fires exactly one
  invocation on a fresh `createActor().start()`, and **zero** when started from a
  snapshot (`{ snapshot }`). A value-changing transition into a state fires that
  state's entry; a self-transition / action-only does not.
- Return typing (`.test-d`): an undeclared completion event / missing field is a
  compile error; an unannotated return fails to typecheck.
- Session/HTTP: a GET to a route reading a fresh session machine with a `loading`
  entry effect (a) renders the `loading` branch, (b) persists the machine, (c)
  schedules the effect; a **second** GET hydrates and does **not** re-fire; the
  effect's completion drives `loading → ready` and reaches a live SSE connection.
- The reactive-load pattern end-to-end (machine `loading → ready | error`,
  streamed) with no client trigger — the design's headline success criterion.

---

## Phase 2 — `after` (state timeouts)

### 1. Engine types

- Add `after?` to `StateNode` with an **extensible trigger shape** (design spec:
  not a bare-ms key). Proposed:
  ```ts
  after?: Array<{ delay: number | ((ctx: C) => number); send: EAll }>
  ```
  `delay` a number or a `(ctx) => ms` today; the shape leaves room for
  durable/cron descriptors later without a breaking change. Keep it a *list* so a
  state can arm several.

### 2. Host timer registry (new — the real Phase 2 infra)

Session runtimes are transient (per request), so a session-machine timer can't
live on the runtime. Add a process-wide, **in-memory, non-durable** timer
registry keyed by `(sessionId, machineName, stateKey, armGeneration)`:
- **Arm on entry** — when a machine enters a state with `after` (the same
  entry-detection Phase 1 adds), register `setTimeout`(s); `.unref()` them.
- **Cancel on exit** — when the state's value changes (or the session is cleared
  / rotated), clear the pending timers for that `(session, machine, state)`.
- **Fire on elapse** — dispatch `send` through the same lock+hydrate+process path
  as an effect completion (`runSessionEffect`-shaped): `withSessionLock`, fresh
  runtime, `processEvent`, persist, `fanOut`. A guard-drop is fine if the state
  moved on (stale timer that lost the cancel race).
- **App machines** reuse the registry but key on the long-lived instance; simpler
  (no hydrate — dispatch straight to the in-process actor via `dispatchToApp`).

Durability (surviving a restart) is explicitly out — matches "host-scheduled
timers first, durable schedules later" (roadmap). A restart drops armed timers;
document it alongside the at-most-once effect note.

### 3. Wiring

- Arm/cancel hooks live where entry/exit are detected (the actor surfaces
  entered/left state; the host arms/cancels). Keep the engine pure — it *declares*
  `after`; the **host** owns `setTimeout` (same split as effects: engine never
  does I/O or timers).

### 4. Tests (Phase 2)

- A machine that enters `loading` with `after: [{ delay: 30_000, send: TIMEOUT }]`
  arms a timer; leaving `loading` before it fires cancels it; staying fires
  `TIMEOUT` → `error`. (Use an injectable clock / small delays in tests.)
- The stranded-`loading` case: an entry effect that never completes is rescued by
  the `after` timeout → `error` (the design's motivation for `after`).

---

## Deferred (not in this plan)

- **`exit` + `AbortSignal` cancellation** — abort an entry effect's in-flight
  work on state leave (design spec). Needs `AbortSignal` in `EffectMeta` + exit
  detection wired to abort; its own effort.
- **Durable timers / schedules** — rides the 1.x inbox/outbox work.
- **Hierarchy** — depth-1 today; multi-level entry/exit ordering deferred.

## Sequencing

Phase 1 ships and is usable on its own (a `Promise.race` inside the entry effect
covers the common slow-fetch timeout; `after` makes it declarative and rescues
the lost-effect case). Phase 2 is the immediate fast-follow. Land Phase 1's
engine + session/GET changes + tests first; add the timer registry for Phase 2
once the entry/exit detection is proven.
