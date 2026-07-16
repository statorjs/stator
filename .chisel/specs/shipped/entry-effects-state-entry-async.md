---
title: 'Entry effects: async I/O on state entry'
status: shipped
created: 2026-07-15
updated: 2026-07-16
area: runtime
---

## What and Why

Effects fire only on **transitions** today — `config.effect` runs after a
matched transition commits (`engine/actor.ts:193`). A machine's `start()` fires
nothing (`actor.ts:119-122`: it flips `started` and `notify()`s). So a machine
sitting in a state kicks no work just by *being* there — there is no "on entering
this state, do async I/O" trigger.

That blocks two things:

- **The reactive-load pattern** — a machine in `loading` that fetches and moves
  to `ready | error`. This is the machine-based (reactive/stateful/shared) door
  of the async-data story: [async-data-defer-boundary](../active/async-data-defer-boundary.md) routes one-shot,
  view-scoped async through `defer`, and routes *reactive* async through "a
  machine with `loading → ready | error` states, kicked by an entry effect."
  This spec is that entry effect — without it, the machine door has no trigger.
- **State timeouts (`after`)** — "after 30s in this state, fire `TIMEOUT`" is a
  host-scheduled timer armed *on state entry*. It reuses the same entry-scheduling
  machinery this spec establishes (see "Relationship").

So: add **`entry`**, a state-level async effect the host schedules when the state
is entered.

## The surface

`entry` lives on a **state node** (which today holds only `on`,
`engine/types.ts:133`). It mirrors the transition `Effect` shape
(`types.ts:80`) minus the event argument — a state entry has no triggering
event:

```ts
states: {
  loading: {
    // (ctx, meta) => Promise<Events | null> — no `ev`; there's no event here.
    entry: async (ctx, meta): Promise<Events | null> => {
      const items = await db.list()            // real async I/O
      return { type: 'LOADED', items }         // completion re-enters as an event
    },
    on: { LOADED: { to: 'ready', do: (ctx, ev) => { ctx.items = ev.items } } },
  },
  ready: { /* … */ },
}
```

```
{match(read(feed, (f) => f.status), {
  loading: () => <Skeleton />,
  ready:   () => <List />,
  error:   () => <Retry />,
})}
```

It **reuses the entire existing effect pipeline** — this is deliberately not a
new execution model. An `entry` produces the same `EffectInvocation`
(`types.ts:88`) a transition effect does: host-scheduled off the session lock
after the entry, run against a commit-time `structuredClone` of context, its
returned event dispatched through the normal path (reaching live pages over
SSE), at-most-once and non-durable in v1. **Only the trigger differs** —
state entry instead of a matched transition.

**Return typing** is the same contract transition effects already use, so this
is a solved problem rather than a new inference one. `entry` is the `Effect`
shape (`types.ts:80`) minus `ev`, with the machine's event union `EAll` threaded
through `StateNode` exactly as `TransitionConfig.effect` threads it. You
**annotate** the return (`: Promise<Events | null>`) and TS checks the returned
event against the declared union (`events: {} as Events`): an undeclared type or
a missing/mistyped field is a compile error. The annotation is *required*, not
optional — full inference from inside `defineMachine`'s generics is intractable
(the nested context-sensitive arrow widens its literals), so an unannotated
return **fails to typecheck loudly**, never passes silently. The engine's
`Effect` doc comment already spells this out for the transition case; the sample
above is type-checked, not just illustrative.

## Fire semantics (the crux)

An entry effect fires when a state is **entered**:

- a **fresh actor start** at the initial state, and
- a **transition whose `to` changes the state value**.

It does **not** fire on:

- **hydration** into a state the machine is already in — a returning session
  whose machine is persisted mid-`loading` must not re-fetch, and
- a **self-transition / action-only transition** that leaves `value` unchanged.

The discriminator is clean and needs **no snapshot-format change**: `createActor`
already receives `opts.snapshot`, so its presence distinguishes a *fresh create*
(fire the initial state's entry) from a *hydration* (never fire entry — the
machine already lived, and its current state's entry already fired when it was
entered). Transitions fire the entered state's entry on a `value` change.

### The one hard requirement: firing must persist

At-most-once-*per-entry* has to hold across the **stateless request model**, and
that's the real design point. Persistence today keys on a commit-count change
(`session-runtime.ts:208`): a machine that only *entered* its initial state and
fired an entry effect committed no transition, so it is **not "touched," and is
not persisted**. Left that way, the next request re-creates it fresh (no
snapshot) and **re-fires the entry effect** — a double-fetch on every request.

So: **firing an entry effect must mark the machine for persistence** (record a
touch / bump the commit count), so the next request *hydrates* (snapshot present
→ entry not re-fired) instead of re-creating. This is the one new coupling entry
effects introduce: entering-and-scheduling is itself a persist trigger, even
with no context mutation.

### Stale completions

Inherited from the effect model, unchanged: if the machine leaves `loading`
(e.g. a user cancels) before the entry effect resolves, the completion event
re-enters the normal path and is **guard-dropped / unhandled** because the state
moved on. In-flight work is **not** aborted — effect cancellation (`AbortSignal`
on state exit) is a separate, later primitive (gap analysis #7), and the primary
motivation for the `exit` hook (see the lifecycle family). A crash between
firing and completion loses the effect and strands the machine in `loading` —
the same at-most-once limitation transition effects have; durability rides the
1.x inbox. The escape from a hung or stranded `loading` is a **state timeout**
(`after: <delay> → error`) — which is why `after` is a *needed* companion to
entry effects, not an optional one (see the lifecycle family below).

## The GET-path implication

This is the one place the runtime genuinely changes. GET renders are read-only
today: `handleGet` creates a transient runtime, renders, disposes — **no lock,
no persist, no effect scheduling**. An entry effect on a machine a GET *creates
fresh* means the GET path must now, for that machine:

1. schedule the entry effect (off-lock, after the response — same as `/__events`
   schedules session effects), and
2. persist the machine's snapshot (per the "firing must persist" rule).

Contained, but real — the read path gains a conditional write + schedule. It
composes with `defer`'s v1 (which also made the initial render's async
framework-orchestrated); the two share the "GET can now kick off-lock work"
change.

## Relationship to `defer` and the state-lifecycle family

- **`defer`** ([async-data-defer-boundary](../active/async-data-defer-boundary.md)) is the *view-scoped, one-shot* door
  and kicks its own thunk; it does **not** depend on entry effects. Entry effects
  are the *reactive/stateful/shared* door — a machine that loads once, caches in
  its (persisted) state, and streams updates live over SSE. The two are the two
  halves of the async-data story; this spec completes the machine half.
- **`entry` is the first of a state-node lifecycle-hook family**, and **`after`
  is a needed companion, not a speculative one.** The loading pattern wants a
  **timeout**: an entry effect can hang, and — because effects are at-most-once —
  a lost one *strands the machine in `loading`* with no event to escape on (see
  Stale completions). A `Promise.race` inside the effect covers a *slow* fetch,
  but not an effect that never returns; only a state-level timeout
  (`after: <delay> → error`) recovers the stranded/lost case. So `after` shares
  the entry-scheduling this spec establishes and is a **co-development / immediate
  fast-follow**, not a someday-item.
- **`exit`** (run when a state is *left*) isn't needed today, but plan for it
  specifically as the home for **`AbortSignal`-based cancellation**: aborting an
  entry effect's still-in-flight work when the state is left (effect
  cancellation, gap analysis #7) is its primary anticipated use case — more than
  generic cleanup. Reserve it in the family rather than foreclose it. Two
  constraints on the family whenever built:
  - Keep the hooks **distinct**. `exit` is *leave*-triggered; `after` is
    *duration*-triggered — different triggers, not one overloaded key. "Cleanup
    on leave" is `exit`, not an `after` variant.
  - Do **not** bake `after`'s trigger into a bare-ms key (`{ 30_000: EVENT }`).
    Shape it as a *described* value so it can grow — dynamic delays
    (`(ctx) => ms`), durable/cron schedules later — without a breaking change.
    The ms-only form is the trap to avoid.

  Together the family covers loading timeouts, expiring carts, debounced saves,
  turn timers, and cleanup — planning-poker will want several.

## Alternatives Considered

- **Explicit persisted "entered" marker** (a snapshot field recording which
  state's entry has been dispatched) instead of the snapshot-presence rule.
  More robust for edge cases (and would let a future "resume a lost load" opt in
  to re-firing), but it changes the `Snapshot` shape (`types.ts:159`) — which
  drags in the snapshot-migration story (gap analysis #4) for existing persisted
  data. The snapshot-presence rule needs no format change and is enough for v1;
  revisit the marker if durability/resume wants it.
- **Client on-mount dispatch** — the page dispatches a `LOAD` event when it
  mounts. Rejected as the primitive: it needs JS (no-JS gets nothing), adds a
  round-trip after first paint, and pushes the trigger to the client, whereas an
  entry effect kicks server-side at render. (It remains available as an app-level
  pattern.)
- **Sync entry *actions*** (a `do`-style mutation on state entry, no I/O). A
  real but separate, smaller feature; not needed for the load trigger. Out of
  scope — add later if a use case appears.
- **Reusing transition `effect` on the entering transition.** Doesn't cover the
  *initial* state (entered at start, not via a transition), and forces every
  transition into a state to repeat the effect. `entry` is per-state and fires
  regardless of how the state was reached.

## Open Questions

- **Concurrent first-GET double-fire.** Two simultaneous first visits (two tabs)
  each fresh-create the session machine and each fire the entry effect before
  either persists. Options: acquire the session lock on the entry-fire+persist
  path (serializes, but costs the "GETs are lock-free" invariant), or accept the
  rare double-fire and lean on the effect's `effectId` idempotency key. Leaning
  accept-for-v1 + document, matching at-most-once's best-effort stance.
- **Signature/naming.** `entry: (ctx, meta) => Promise<Event | null>` — confirm
  `entry` reads right (no clash: Stator has no sync entry *actions* today, so
  there's nothing to confuse it with) and that dropping `ev` from the `Effect`
  shape is clean vs. a dedicated `EntryEffect` type.
- **Multiple entries / ordering** if hierarchy lands later (entering a parent +
  child). Depth-1 today (`Snapshot.value`), so single entry per entered leaf;
  reserve the ordering question for nesting.
- **Does an `error`-state entry effect (retry backoff) belong here or in `after`?**
  A retrying loader wants a delay before re-entry — which is `after` territory.
  Keep `entry` for the immediate kick; delayed retry composes with `after`.

## Success Criteria

- A machine declares `entry` on a state; entering that state (fresh start or a
  transition) schedules the effect off the session lock, and its completion event
  dispatches through the normal path and reaches live pages.
- Entering a `loading` state on a **fresh** session fires the fetch exactly once;
  a subsequent request that **hydrates** the machine mid-`loading` does **not**
  re-fire it.
- The machine persists when its entry effect fires (no double-fire across
  requests), even with no context mutation.
- A GET that creates a fresh machine with an entry effect schedules it
  (post-response, off-lock) and persists — without holding a lock across I/O.
- The reactive-load pattern from [async-data-defer-boundary](../active/async-data-defer-boundary.md) (machine
  `loading → ready | error`, streamed over SSE) works end to end with no
  client-side trigger.
