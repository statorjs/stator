---
title: Custom isomorphic state-machine engine
status: shipped
created: 2026-06-17
updated: 2026-06-25
area: runtime
---

## What and Why

The POC wraps XState v5 behind `defineMachine`. That was the right call to prove
the runtime model (see [[poc-runtime-model]]) — XState handled state graphs,
transitions, guards, actions, and emit while we figured out whether
machines-as-canonical-state could survive a real request lifecycle. It can. Now
XState is the thing blocking three things 1.0 needs, and replacing it is the
linchpin the rest of the 1.0 work compounds on.

**Why replace it:**

1. **Type-safe events.** Action/guard event args are `any` today
   (`define-machine.ts:75-76,156`) — a POC limitation the README already flags.
   This blocks [[typed-events-and-machine-mediated-dispatch]] and makes every
   `send`/`dispatch` unchecked.
2. **Isomorphism + bundle size.** [[client-scripts-directives-and-isomorphic-machines]]
   needs the same machine def to run in the browser. The client-model spike
   confirmed a stator machine runs client-side via `createActor`, but the bundle
   was ~112 KB — almost entirely XState. Per-component client bundles can't carry
   that. A purpose-built core targets ~3–6 KB.
3. **The capability/portability model.** The compiler's "can this machine run on
   the client?" check needs the engine to expose *which capabilities a machine
   touches* (Store, secrets, cross-session emit) as a typed, inspectable property.
   XState has no such notion; we'd be bolting it on.

**Why now:** the POC surface is empirically the only surface in use. A survey of
every machine in every app (cart, checkout, products, admin, polls, voter) found
**zero** usage of nested states, parallel states, history, `invoke`, `spawn`, or
delayed transitions. The most stateful machine, `CheckoutMachine`, is a flat
3-state graph. `DefineMachineConfig` doesn't even *expose* statechart richness —
only a flat `states` map with `on` handlers. So building our own engine means
building the facade we already present, not reimplementing XState.

## Success Criteria

- `defineMachine` keeps its current config shape; existing machines compile and
  pass the existing vitest suite unchanged (modulo the new typed-events surface,
  which is additive).
- Action and guard `event` is a typed discriminated union, not `any`. A `send`
  of an undeclared event type is a compile error.
- The same machine definition runs server-side (with dispatch context, `reads`
  proxies, Store hydration) and client-side (local actor, no wire) from one
  source — verified by porting the client-model spike off XState.
- The engine core adds ≤ ~6 KB min+gzip to a client bundle (vs. XState's ~30–40 KB).
- The engine exposes a machine's capability set (server-only vs. portable) as a
  statically-derivable property the compiler consumes.
- Snapshot serialization round-trips through the Store (session machines) and
  through a client hydration seed (client machines) without XState's persisted
  snapshot format.
- The XState dependency is removed from `packages/stator`.

## Constraints

- **Lean surface, with extension points.** Build exactly the POC-equivalent
  feature set (below). Design the internal state representation so hierarchy /
  parallel / history can be layered later without a rewrite — but do not build
  them for 1.0. The decision is **lean + extension points**.
- **Mutation-style actions preserved.** Actions stay `(ctx, ev, helpers) => void`
  over a per-call `structuredClone` (the current ergonomic). The engine owns the
  clone + commit; user code mutates a draft.
- **Sync only.** Selectors, actions, and guards are synchronous and pure of I/O —
  the existing constraint. No `invoke`/async in the machine graph; async lives in
  routes/API handlers. This is a deliberate non-goal, not a gap.
- **The dispatch-context seam is preserved.** Server actions resolve `reads:`
  proxies and record `touched` via the active `DispatchContext`
  (`dispatch-context.ts`). The engine must run identically with a dispatch context
  (server) and without one (client) — a reads-free machine never dereferences the
  context, which is why the spike's client actor worked.
- **Same recompute contract.** `recompute` reads through a proxy that calls
  `getSnapshot()` per access. The engine's actor must expose that snapshot surface
  so `recompute`, `read()`, and `bind:` are unchanged.
- **No new wire format.** Snapshots feed the existing Store and the client
  hydration seed; the `/__events` and patch wire formats are untouched.

## Feature set — lean (1.0) vs. full (deferred)

**In scope (lean):** typed context; typed event union; flat `states` map; `on`
transitions with `target` / `guard` / `actions` / `emit`; top-level `actions`,
`guards`, `selectors`; declarative `emits` with payload selectors;
`reads`/`subscribes` integration; snapshot serialize/deserialize; the actor
surface (`start`, `send`, `getSnapshot`, `subscribe`, `stop`,
`getPersistedSnapshot`-equivalent).

**Deferred (build extension points, not the features):** nested/hierarchical
states; parallel states; history states; `invoke`/actor children; `spawn`;
`final` + `onDone`.

**Candidate to pull into lean:** delayed transitions (`after`/timers). Unused
today but common in real UI (auto-dismiss, timeouts). Flagged as the one likely
near-term gap; decide during implementation. Open question below.

## Approach

**Shape:** a small actor over an explicit transition function. `defineMachine`
returns a `MachineDef` (as today) carrying `name`, `lifecycle`, `reads`,
`subscribes`, `emits`, `selectors`, and a `transition(state, event, ctx)` derived
from the `states` map — replacing `xstateMachine`. `createActor(def)` produces an
actor with the surface `recompute` and the client runtime already use.

**Typed events:** `defineMachine` gains an event-union type parameter (exact
syntax an open question — type param vs. schema). The flat transition map makes
narrowing tractable: `event.type` discriminates, and each handler sees the
narrowed event. This is where lean pays off — nested/parallel typing is where
XState's own types get gnarly.

**Capabilities:** the engine tags a machine with the server-only capabilities it
transitively touches (Store-backed persistence via `lifecycle: 'session'`/`'app'`
+ Store, secrets, cross-session `emit`, `reads:` on a server-pinned machine).
"Portable" = touches none. Exposed on the def for the compiler's client-placement
check ([[client-scripts-directives-and-isomorphic-machines]]).

**Serialization:** the engine owns a compact snapshot (`{ state, context }`),
replacing XState's `getPersistedSnapshot`/`snapshot` opts in `session-runtime.ts`
(`loadOne`/`persistTouched`). Same format seeds a client actor on custom-element
upgrade — the designed-in hydration handoff.

**Migration:** keep `defineMachine`'s surface byte-for-byte where possible; swap
the internals; run the existing suite as the regression gate; port the demos and
the client-model spike. The README's "POC limitations" entry for type-safe events
gets lifted here.

## Alternatives Considered

- **Keep XState v5, add typing via its generics.** Possible but awkward against
  the wrapped `assign`/`structuredClone` action shape, doesn't solve bundle size
  or the capability model, and leaves a 30–40 KB dependency on the client. The
  typing alone doesn't justify staying.
- **Full statecharts (XState-equivalent, custom).** Rejected for 1.0: ~4× the
  build effort, ~4× the bundle, hardest typing — all for capability nothing
  currently uses or can even express through `defineMachine`. Extension points
  hedge the future need.
- **Lean, no extension points.** Smallest/fastest, but risks a rewrite if 1.x
  needs hierarchy. The extension-point design tax is small insurance.
- **A third-party tiny FSM lib (robot, etc.).** None give us the dispatch-context
  seam, the capability model, or our exact `defineMachine` surface; we'd wrap it
  the way we wrap XState and inherit the same mismatch.

## Open Questions

- **Delayed transitions in 1.0?** `after`/timers are the one lean gap likely to
  bite. Decide whether to include a minimal timer mechanism (and how it behaves
  across the server/client boundary and across hydration) or defer with the rest.
- **Event-declaration syntax.** ~~A TS type parameter (`defineMachine<Events>(...)`)~~
  **Decided (2026-06-19): `events: {} as Events` phantom property.** A bare
  explicit type arg (`defineMachine<Events>({...})`) is impossible in TS — once any
  type param has a default (required, since `events` is optional), supplying one
  explicit arg makes every trailing param fall to its default instead of inferring
  (verified by scratch: context/reads/selectors all collapsed). The only working
  alternatives are a curried `defineMachine<Events>()({...})` (odd empty `()`) or a
  `type<Events>()` helper (do-nothing property) — both just relocate the wart. Kept
  `{} as Events`: instantly legible, no cleverness, naturally optional.
- **Extension-point shape.** What internal representation keeps hierarchy/parallel
  addable later — a flat state list now, or a degenerate tree (depth 1) that can
  grow? Decide before coding the core, not after.
- **Selector typing.** Selectors are `(ctx) => unknown` today; the engine should
  carry their return types so `read()`/`bind:` are typed end-to-end. Scope vs.
  the events work.
- **Cross-machine emit typing.** Should the typed event surface flow through
  `emits`/`subscribes` so a subscription's dispatched event is checked against the
  target's union? Ties to [[cross-machine-effects-source-predicate-transform]].

## Implementation Notes

This is the 1.0 linchpin — [[typed-events-and-machine-mediated-dispatch]] and the
client/server portability check in
[[client-scripts-directives-and-isomorphic-machines]] both depend on it.

### Engine core landed — 2026-06-18 (`packages/stator/src/engine/`)

Built the engine core as a purely additive module (nothing imports it yet, so the
existing build/suite stayed green throughout). **Decision: authoring API is
Option A — inline functions on transitions** (per-transition event narrowing,
co-located logic), chosen over named-string registries; XState-compat is
explicitly abandoned.

- `types.ts` — fresh, non-XState surface. State value is a **path array**
  (`['idle']`) — depth-1 today, the hierarchy extension point. `OnMap` narrows
  the event per key via `Extract<E, {type:K}>`, so an inline `do`/`when` sees
  exactly its transition's event.
- `define-machine.ts` — `defineMachine` builds the def, normalizes `emits`, and
  computes `capabilities`. Initial capability heuristic: **server-pinned iff it
  `reads` another machine** (reads-free → portable, matching the spike's
  client-side counter). Secrets / cross-session emit are TODO inputs to the same
  function, noted not ignored.
- **Typed reads (no `any` at the callsite).** `MachineDef` carries its `name`
  literal and concrete selector-map as type params; `defineMachine` infers
  `reads` as a `const` tuple and threads a derived `ReadsMap<TReads>` (keyed by
  each read machine's `name`, valued by its `InstanceOf` with selector return
  types preserved) into the transition signatures. So inside an action,
  `helpers.reads.ProductsMachine.byId(id)` is fully typed and an undeclared read
  is a compile error. The bare `MachineDef<any,…>` only survives as a single
  named `AnyMachineDef` "top type" for the heterogeneous `reads` array —
  unavoidable because `MachineDef` is invariant in its context (context appears
  in contravariant action-parameter positions), so `unknown` can't serve as the
  element type. Callsite safety is recovered by inference, not by the array
  annotation. Proven by a typecheck-gated test incl. a `@ts-expect-error` on an
  undeclared read.
- `actor.ts` — `createActor(def, { snapshot?, resolveHelpers? })`. Draft-mutation
  is **native** (clone → mutate → commit), not an `assign` wrapper. Emit fires
  after the action commits (payload sees post-mutation context). `resolveHelpers`
  is host-injected, so the engine imports no server module — this is what keeps it
  isomorphic. Actor surface is the 7 methods the glue needs: `start`, `stop`,
  `send`, `getSnapshot`, `getPersistedSnapshot`, `subscribe`, `on`.

Verified: 7 engine unit tests (inline-action narrowing, guards + transitions,
emit with post-mutation payload, clone isolation across actors, snapshot
hydration round-trip, injected reads resolver, capability tagging) — all green;
full existing suite still 27/27; `tsc --noEmit` clean.

### Migration complete — 2026-06-19

The glue and all machines now run on the engine; XState is gone from the
framework.

- **Glue swapped:** `machine-store` / `session-runtime` create actors via
  `createActor(def, { snapshot, resolveHelpers })`; `instance-proxy` consumes the
  engine `Actor` and exposes the leaf state name as a string for template compat.
  Reads resolution moved out of `defineMachine` into a host-side
  `serverReadsResolver` (server/reads-helpers.ts) that reads the dispatch
  context — keeping the engine host-agnostic. `server/define-machine.ts` is now a
  thin re-export of the engine.
- **Transition arrays** added to the engine (first guard that passes wins) —
  surfaced by the cart's `ADD_ITEM`/`DECREMENT` during migration; flat-state, in
  the lean set.
- **All machines ported to Option A inline:** cart, checkout, products, admin
  (example) and polls, voter (poll) — with typed event unions. Shared actions
  (cart add/decrement branches) inlined rather than extracted, the accepted
  Option-A cost.
- **Emit payload event is typed `any`** in `EmitDeclaration` — an emit can fire
  from multiple transitions, so its originating event isn't statically one union
  member (tracked as the cross-machine emit-typing open question).
- `xstate` removed from `packages/stator/package.json`; `@statorjs/stator/machine`
  repointed to `src/engine/`.

Verified: framework `tsc` clean + 28/28 tests; example and poll apps `tsc` clean;
example app booted on the engine and an `ADD_ITEM` (resolving
`reads.ProductsMachine.byId`) produced correct patches with no errors —
cross-machine reads, guarded transition arrays, emits, and the
render→recompute→patch pipeline all exercised end-to-end. Committed on
`feat/1.0-engine` (engine core, framework migration, app port as separate
commits).