---
title: 'Engine effects: async I/O from machine transitions'
status: draft
created: 2026-07-03
updated: 2026-07-03
area: runtime
---

## What and Why

The engine is fully synchronous: `do` actions, `when` guards, and selectors are
all sync functions, and the render path is sync by contract. The only
async-capable surface in the framework today is the API-route handler
(`routing.ts` — `handler: (...) => Promise<ApiRouteResult>`, with an async
`dispatch` helper). That means a machine transition triggered through
`/__events` **cannot perform I/O** — no DB write, no payment call, no external
API — anywhere in its path. The workaround is to route such interactions
through an API route that does the I/O and then dispatches a result event,
which bifurcates the event model: some buttons POST to `/__events`, others to
bespoke API routes, and authors must know which is which.

The Allbirds proving demo forces this immediately (checkout = a real charge
call mid-flow), so it must be resolved before the demo and before Phase 5
hardening.

**Decision (2026-07-03, review session):** add **minimal engine effects** — a
transition may declare an `effect`, an async function that runs after the
transition commits and whose result is a follow-up event dispatched through
the normal event path. No `invoke`, no `spawn`, no child actors, no retry
machinery. The engine core stays synchronous; effects are the one seam where
async enters, and everything about them reduces to "an event arrives later."

Because the engine is isomorphic, the same shape works on client actors: an
effect on a client machine is just an async function whose completion sends an
event to the local actor (e.g. a `fetch`). Server actors additionally need
lock and persistence wiring (below).

## Success Criteria

- A transition can declare
  `effect: async (ctx, event, meta: { effectId: string }) => CompletionEvent | null`
  where the returned event is **typed against the machine's declared events**
  (returning an undeclared event type is a compile error) and `effectId` is a
  unique per-invocation id for idempotency keys / log correlation.
- The checkout shape works end-to-end: `SUBMIT → 'submitting'` (sync commit,
  patches in the POST response) → effect runs → `CHARGE_OK | CHARGE_FAILED`
  dispatched → `'confirmed' | 'reviewing'`, with the completion visible via
  SSE on live routes and on next request otherwise.
- The session lock is **never held during effect I/O**: the lock releases
  after the triggering transition persists; the completion event re-acquires
  it through the normal event path.
- Out-of-order completions are safe by construction: completion events are
  ordinary events, so guards/state checks handle staleness (a `CHARGE_OK`
  arriving in a state with no handler for it is dropped, per existing engine
  semantics).
- An effect that throws is logged and dropped (the runtime backstop) — the
  type contract makes effects infallible by construction, so authors return
  their failure event explicitly (see resolved Open Questions).
- A client-machine effect runs locally in the browser with the same authoring
  shape, verified in happy-dom.
- Effects mark the machine's **capability set** appropriately: an effect
  closing over server-only resources pins the machine server-side (existing
  `computeCapabilities` heuristic extends to cover `effect`).
- Test suite covers: completion after response, failure path, out-of-order /
  stale completion, lock non-holding (concurrent event during effect I/O), and
  client-side effect.

## Constraints

- **At-most-once, non-durable.** If the process dies between commit and
  effect completion, the effect is lost and the machine stays in its
  intermediate state ('submitting'). This is documented 1.0 behavior; durable
  effects (outbox-style, survive restart) ride the 1.x inbox work
  ([[app-to-session-subscriptions-via-inbox]]) — the effect declaration is
  designed so durability can be added without changing the authoring surface.
- **No engine-core async.** `send` stays synchronous and void-returning.
  Effects are scheduled post-commit by the host (session runtime on the
  server, `StatorElement`/`use()` on the client), not awaited by the actor.
- **Sync render contract unchanged.** Effects never run during render;
  selectors and `do` stay sync. This spec adds no async to the render path.
- **Intermediate states are mandatory.** The pattern is always
  transition-to-pending-then-complete; there is no "await inside the
  transition" form. This keeps every state the UI can observe a declared
  state.

## Approach

Authoring shape (checkout example):

```ts
states: {
  reviewing: {
    on: {
      SUBMIT: {
        to: 'submitting',
        effect: async (ctx, ev) => {
          try {
            const res = await charge(ctx.cartTotal, ev.token)
            return { type: 'CHARGE_OK', chargeId: res.id }
          } catch (e) {
            return { type: 'CHARGE_FAILED', reason: message(e) }
          }
        },
      },
    },
  },
  submitting: {
    on: {
      CHARGE_OK:     { to: 'confirmed', do: (ctx, ev) => { ctx.chargeId = ev.chargeId } },
      CHARGE_FAILED: { to: 'reviewing', do: (ctx, ev) => { ctx.error = ev.reason } },
    },
  },
},
```

Mechanics, server side:

1. `/__events` acquires the session lock, loads the graph, processes `SUBMIT`.
   The transition commits (`submitting`), `persistTouched` runs, patches are
   computed, **the lock releases and the response returns** — same as today.
2. The engine surfaces pending effects on the transition result (it does not
   run them — the engine has no I/O). The **session runtime** collects them
   and schedules each after the lock releases, with a snapshot of `(ctx, ev)`
   from commit time (`structuredClone`, same discipline as actions).
3. On completion, the runtime dispatches the returned event through the
   **existing event path**: acquire session lock, load graph (fresh hydrate —
   the actor from step 1 is gone; this is the transient-actor model working
   for us), process event, persist, recompute → `fanOut`. Live routes see the
   completion patch over SSE; non-live pages see the new state on next
   request. This reuses the fanOut-from-non-POST-entry-points work (in the
   0.9 scope) rather than inventing a delivery channel.
4. `effect` runs with **no capability object** — snapshots-only (resolved Open
   Question 2). It is a pure async function of `(ctx, ev, meta)`; it must not
   assume the actor still exists. Live-state decisions belong in the
   completion event's own guards/`do`, which run under a real dispatch
   context.

Client side: `use()`/`StatorElement` schedules the effect on a microtask after
the transition notification and `send`s the returned event to the local actor.
No locks, no persistence — the same authoring shape degrades to the trivial
implementation.

Engine changes are small and additive: `TransitionConfig` gains `effect?`;
the transition result carries `pendingEffects`; `computeCapabilities` learns
that `effect` presence alone does **not** pin a machine (client effects are
legal — pinning still comes from the existing server-capability signals).

## Alternatives Considered

- **Edges only, forever** (all I/O in API routes, machines stay pure):
  cheapest, but permanently bifurcates the event model and makes the most
  common real-world flow (submit → call service → show result) the awkward
  case in a framework whose pitch is "business logic lives in machines."
  Rejected in the 2026-07-03 decision round.
- **XState-style `invoke`/actors**: brings hierarchy, lifecycles, and
  cancellation semantics the engine deliberately dropped; contradicts the
  lean-engine scope decision. The effect-as-event reduction gets 90% of the
  value with none of the interpreter complexity.
- **Await-inside-action** (`do: async ...`): would hold the session lock
  across I/O, block the POST response on external services, and break the
  clone-and-commit action model. Rejected.
- **POST waits for fast effects** (respond with completion patches when the
  effect finishes under some timeout): tempting UX sugar, but it makes
  response timing data-dependent and creates two observable behaviors for one
  declared flow. Rejected for 1.0; revisit as sugar later if the demo shows
  the SSE/next-request gap hurts on non-live pages.

## Open Questions

All four resolved 2026-07-03:

- ~~**Failure default**~~ — **(b) infallible by construction.** The type is
  `effect: (ctx, ev, meta) => Promise<CompletionEvent | null>` — authors catch
  and always return an event (or null for fire-and-forget); a throw is the
  runtime backstop: logged and dropped, never crashes the host. The type
  system is the forcing function for thinking about the failure path.
- ~~**Effect context surface**~~ — **snapshots-only.** `(ctx, ev)` are
  commit-time `structuredClone`s (same discipline as actions). No capability
  object: anything the completion needs from live state is read by the
  completion event's own `do`/guards, which run under a real dispatch context.
- ~~**Idempotency ids**~~ — **yes, stamped now.** The host generates a unique
  id per effect invocation and passes it as the third argument:
  `effect: (ctx, ev, meta: { effectId: string }) => …`. Authors thread it to
  external calls as an idempotency key; 1.x durability (retries ⇒
  at-least-once) then composes without changing authored effects. Also useful
  today for log correlation.
- ~~**App-machine effects**~~ — **symmetric API, staged implementation.**
  `effect:` is legal on both lifecycles in 1.0 — app flows are emit-triggered
  and have no HTTP edge, so session-only would leave app machines with no
  async story and re-bifurcate the event model along the lifecycle axis.
  Implementation lands in two steps: session effects first, then (after
  Phase 5's app-machine persistence + fanOut-from-non-POST) the app-effect
  scheduling path in MachineStore. App completions are simpler than session
  ones: the actor is in-process and sends are atomic, so no lock is involved.

## Implementation Notes

**Session plane shipped 2026-07-03** (stage 1 of 2). As designed, plus:

- Engine: `CreateActorOptions.onEffect` is the host-scheduler injection point
  (mirrors `resolveHelpers`). When omitted, the actor runs the effect locally
  on a microtask and sends the completion to itself — which IS the client
  plane and the unit-test behavior, no client wiring needed.
- Server: `SessionRuntime` queues invocations (`drainPendingEffects`);
  `server/effects.ts` schedules after the entry point persists — I/O runs
  lock-free (proven by test: a 150ms effect doesn't delay a concurrent
  event), completion re-enters via lock → fresh hydrate → process → persist →
  `fanOut` (which was already callable from any context).
- App machines: `bootAppMachines` wires an explicit warn-and-drop `onEffect`
  until the Phase 5 stage lands — dropped loudly rather than half-run without
  fan-out/persistence.
- **TS inference caveat:** `defineMachine`'s generic inference defers
  context-sensitive arrows, so an effect's returned event literals widen and
  fail typecheck unless the author annotates the return —
  `effect: async (ctx, ev, meta): Promise<Events | null> => …`. The failure
  is loud (never silently unchecked) and the annotation restores the full
  contract (undeclared completion types are compile errors — verified).
  Documented on the `Effect` type.

**Remaining (stage 2, after Phase 5):** the app-plane scheduler in
MachineStore (completion → in-process send + recordTouch + fanOut + persist).
