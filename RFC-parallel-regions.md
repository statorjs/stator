# RFC: Parallel regions and keyed workflow families

- **Status:** draft
- **Author:** Tony Sullivan
- **Motivated by:** dogfooding an editable admin collection (Lodestar-on-Stator POC); the
  friction is logged as "Flat machine-wide states strain per-record async workflows"
- **Targets:** the 1.x "statechart richness" slot deferred at 1.0 (nested/parallel/history/invoke)

## Summary

Let a machine declare **parallel regions** — orthogonal state axes that are each always active — and let a region be **keyed**, giving one workflow instance per key (per record, per job, per connection). Event delivery consults every active region instead of a single flat state, so a completion event is dropped only when *no* region can handle it. The existing flat surface is unchanged: `states:` + `initial` becomes sugar for a single default region.

## Motivation

### The shape that breaks

A machine that owns a *collection* has two independent state axes:

1. a **machine-wide** axis — is my snapshot of the datastore fresh? (`loading` / `ready`)
2. a **per-record** axis — each record's write workflow (`committing` → settled / conflict)

1.0's flat states can express exactly one of these in the chart. The POC's `AlertsMachine`
(GitLab-backed editable collection: entry-effect seed, Commits-API save as a transition effect, optimistic concurrency) puts the freshness axis in the chart and is forced to push the per-record axis into context as `saves: Record<id, {phase, message}>` — plus duplicate every save/completion handler across `loading` *and* `ready`.

### Why the duplication is load-bearing, not stylistic

The effects contract says completions drop themselves: *"a completion event is an ordinary event; if the machine has moved to a state with no handler for it, it's ignored."* That rule is correct for a single-workflow machine — "moved on" means the completion is stale. In a collection machine the machine-wide axis moves for reasons unrelated to any record, so "moved on" is a false signal:

```
 ready    SAVE(A)              saves[A]=committing; effect A in flight
 ready    SAVE(B)              saves[B]=committing; effect B in flight
 ready    COMMIT_CONFLICT(B)   B's base was stale → to:'loading' (re-seed, takes seconds)
 loading  COMMIT_FAILED(A)     ✗ dropped — no handler in 'loading'
 loading  LOADED               → ready
 ready    …                    saves[A] shows "committing" forever
```

Effect A's completion fired on schedule; it landed in the window where the machine was re-seeding because of *B*. Transition effects are at-most-once (never re-invoked) and there is no event queue, so nothing replays it. Without handler duplication the record is stranded; with it, the chart lies twice.

### The philosophical cost

Stator's docs sell the state chart as the *audit surface*: "to audit your attack surface, read the chart: every state, every accepted event, every guard." The collection shape breaks that promise — the per-record workflow, which is where the interesting guards live, is invisible in the chart and reconstructable only by reading action bodies that mutate a context map. Admin tools, dashboards, and queues — the apps Stator names as its fit — are all collections-of-workflows.

## Guide-level explanation

A machine may declare `regions` instead of top-level `states`/`initial`. Each region is a state chart that is **always active**; the machine's state is the product of its regions' states.

```ts
export default defineMachine({
  name: 'AlertsMachine',
  lifecycle: 'app',
  events: {} as Events,
  context: { entries: [] as AlertEntry[], loadedAt: '', error: '' },
  regions: {
    freshness: {
      initial: 'loading',
      states: {
        loading: {
          entry: async (): Promise<Events | null> => load(),
          on: { LOADED: { to: 'ready', do: applyEntries }, LOAD_FAILED: { to: 'ready', do: noteError } },
        },
        ready: { on: { REFRESH: { to: 'loading' } } },
      },
    },
    save: {
      key: (ev) => ('id' in ev ? ev.id : null),   // one instance per record id
      initial: 'idle',
      states: {
        idle: { on: { SAVE: { to: 'committing', effect: saveEffect } } },
        committing: {
          on: {
            COMMIT_OK:       { to: 'idle', do: applyCommit },
            COMMIT_CONFLICT: { to: 'conflict', do: noteConflict, dispatch: 'REFRESH' },
            COMMIT_FAILED:   { to: 'failed', do: noteFailure },
          },
        },
        conflict: { on: { SAVE: { to: 'committing', effect: saveEffect } } },
        failed:   { on: { SAVE: { to: 'committing', effect: saveEffect } } },
      },
    },
  },
  selectors: {
    view: (_ctx, { state }) => state.freshness,                    // 'loading' | 'ready'
    saveStatus: (_ctx, { state }) => (id: string) => state.save(id), // 'idle' | 'committing' | …
    // …
  },
})
```

What this buys, point by point:

- **No stranded completions.** `COMMIT_FAILED(A)` is delivered to the `save` region's instance for key A, whose `committing` state always handles it — regardless of where `freshness` is. The drop-if-unhandled rule still exists, but it asks *every* active region first.
- **No handler duplication.** Each transition is declared once, in the region it belongs to.
- **The chart is the workflow again.** `conflict` and `failed` are states with their own
  accepted events (retry is `SAVE` from `conflict`), not string tags in a context map. Guards on those transitions are auditable by reading the chart.
- **State is selectable.** Selectors receive a `state` helper alongside `ctx`, ending the
  pattern of mirroring the current state into context (`ctx.loadedAt` standing in for "have I loaded") just so templates can `match` on it. `read(alerts, (a) => a.view)` keeps working; it is now backed by the real region state.
- **Cross-region reaction stays event-shaped.** The conflict transition uses `dispatch:` to send `REFRESH` into the machine's own event path (handled by `freshness`), rather than reaching into another region's state — regions stay decoupled the same way machines do.

A flat machine is unchanged and unaffected: `states:` + `initial` compiles to
`regions: { main: { initial, states } }`.

## Reference-level explanation

### Surface

- `defineMachine` accepts **either** `states` + `initial` **or** `regions` (mutually exclusive; both is a define-time error). `RegionDef = { initial, states, key? }`.
- `key?: (ev) => string | null` marks a **keyed family**. The selector is typed against the
  machine's event union; returning `null` means "this event is not addressed to this family."
- Selectors, guards, actions, and effects keep their signatures; the helpers object gains
  `state`: plain regions read as `state.<region>` (current state name), keyed families as
  `state.<region>(key)` (state name, or the region's `initial` for an unmaterialized key).

### Event delivery

An event is offered to every region, in declaration order:

1. A plain region handles it iff its current state declares the event (guards as today).
2. A keyed family first routes: `key(ev)` → `null` skips the family; a string selects (or
   materializes, in `initial`) that key's instance, which handles the event iff its current
   state declares it.
3. `committed` (the dispatch honesty signal) is true iff **at least one** region committed a
   transition. An event no region handled is dropped, as today — but the dev server logs which regions were consulted, so "dropped" is diagnosable.

The stale-completion rule survives intact and becomes *more* correct: a completion is ignored only when the workflow it belongs to has genuinely moved on, because delivery now consults the workflow's own region rather than an unrelated axis.

### Keyed instance lifecycle

- Instances materialize on first routed event (born in `initial`, entry effects run).
- An instance sitting in its `initial` state with no pending effect or timer is **virtual** — it is not stored. This makes `idle` free: a million records cost nothing until one saves.
- Disposal is therefore automatic: returning `to: 'idle'` (or any state marked `final: true`, which also cancels timers) collapses the instance back to virtual.
- Dev-mode guard: a configurable cap on materialized instances per family (default generous), exceeded → loud error naming the family, because an unbounded family is almost always a missing `to: 'idle'`.

### Context

One `context` per machine actor, shared by all regions — regions are orthogonal *control* state, not separate data owners. This keeps `read(machine, selector)`, cloning, and the wire model untouched. (Per-key context was considered and rejected for 1.x: `ctx` maps keyed by id already express it, and splitting context would fork the selector and persistence models.)

### Persistence and the wire

- Snapshot shape: `state` goes from a string to `{ [region]: string | { [key]: string } }`, with virtual keyed instances omitted. Old snapshots (bare string) load as `{ main: s }` — no migration step.
- Recompute/diff, slot addressing, SSE fan-out: unchanged. Regions affect which transitions
  commit, not how bindings diff.

### Effects and timers

Entry effects, `after` timers, abort-on-exit, and re-invoke-on-hydration all scope to a
**region-state** (keyed: region-state-per-key). `meta.effectId` gains the region/key so
idempotency correlation survives. The load/command role contract is unchanged.

### Compile-time

- `computeCapabilities` unchanged (regions don't affect placement).
- The `.stator` compiler needs nothing new: templates read selectors, and `state` is a selector input, not a template surface.

## Drawbacks

- Engine complexity: delivery loop, keyed routing, materialization bookkeeping, snapshot shape.
- The product-of-regions state space is bigger than a flat chart; the dev inspector needs a
  story for showing "freshness=loading, save(gpu.ping)=committing" legibly.
- Keyed families are a capped-but-real memory liability under adversarial event streams
  (mitigated by virtual-idle + the cap, but the cap is a new tunable).

## Alternatives considered

- **Status quo, documented** — bless the context-map + duplicated-handlers pattern in a recipe.
  Cheapest; leaves the audit-surface promise broken for collection machines and the stranding hazard one forgotten duplicate away.
- **Sticky completions** — never drop `COMMIT_*`-style events; queue them until handled. Fixes stranding but not expressiveness (workflows still live in context), and introduces an event   queue with its own ordering/replay semantics — a bigger primitive than regions, with less to show for it.
- **One machine per record** — the actor-model answer; the session/app lifecycle model can't express a dynamic machine-per-record population, and the docs already steer away from it (the per-slug machine anti-example in the defer guide). Keyed families are that idea, scoped inside one machine where lifecycle, persistence, and reads already work.
- **Full statecharts now** (nesting + history + invoke) — regions are the piece the dogfooding actually demanded; nesting/history can layer on later without disturbing this surface.

## Prior art

- Harel's statecharts: orthogonal (AND) components are the original answer to exactly this state-explosion; regions here are AND-states with an event-routing twist for keys.
- XState: `type: 'parallel'` regions and `spawn`ed actors bracket this proposal from both sides; keyed families sit deliberately between them (parallel regions' simplicity, spawn's dynamism).
- Erlang/OTP: one supervisor, many keyed children, mailbox semantics per child — the "collection of workflows" shape this RFC makes declarable in one machine.

## Unresolved questions

- Should a transition in one region be able to *guard on* another region's state (`when: (ctx, ev, { state }) => state.freshness === 'ready'`), or is `dispatch:` + event-shaped coupling the only sanctioned channel? (Draft says: allow reading via helpers,
  never writing.)
- `dispatch:` on a transition (self-dispatch used by the conflict → REFRESH example): new primitive, or sugar over an emit-to-self subscription?
- History states for regions (re-enter `conflict` after a restart?) — deferred with the rest of history semantics.
- Inspector/devtools presentation of keyed families at scale.

## Maintainer response

Reviewed as a community RFC — separating the *problem* from the *proposed
solution*, since the two need not be the same size.

**The use case is core.** Collections of keyed workflows — admin tools,
dashboards, queues — are the apps Stator names as its fit, and the flat model
genuinely breaks the "chart is the audit surface" promise for them. We want to
support this well.

**But the RFC bundles three distinct problems into one primitive:**

1. **Stranded completions** — a transition-effect completion for record A is
   dropped because the machine moved to `loading` for record B. A correctness
   hazard.
2. **Handler duplication** — save/completion handlers copied across `loading`
   and `ready`.
3. **Per-record workflow invisible in the chart** — the save workflow lives in a
   context map, not a chart. The audit-surface erosion.

Regions + keyed families solve all three at once; #1 and #2 don't need regions.

**#1 + #2 — machine-level handlers.** Today handlers are state-scoped (`on:` on
the state node), which is *why* completions strand: a completion is handled only
if the current state declares it. A machine-level `on:` — handlers that apply
regardless of the current state — fixes both: the completion is handled in any
state (no stranding) and declared once (no duplication). It is semantically
honest (an effect completion is orthogonal to user-facing state, so it should not
be gated on it), touches none of the wire/reads/recompute/persistence surfaces,
is backward-compatible, and fits the "flat machines with extension points" shape
1.0 shipped. It is *not* sticky-completions (no queue, no replay). This removes
the hazard with a small primitive, independent of the larger question — though it
entrenches #3 (the save phase stays in context).

**#3 — the real design question, and where "machine = unit of composition"
points.** Stator's tagline says state machines are the unit of composition; the
promise says the chart is the audit surface. The purest expression of both: a
per-record workflow should be a *machine* — not a region inside a machine, not a
context map. So the native question is not "how do we add parallel regions" but
**"how does a machine own a dynamic, keyed collection of child workflow
machines?"** — a per-key **family lifecycle** alongside session/app. The save
workflow is a normal flat machine, one instance per record key, supervised by the
collection-owner (freshness) machine. The audit surface is restored *natively*
(it is just a chart); completions route to each instance's own actor, so
stranding dissolves structurally; cross-axis coupling stays event-shaped (the
child dispatches `REFRESH`).

The RFC names this shape ("keyed families are one-machine-per-record, scoped
inside a machine") but implements it as intra-machine regions with **shared
context** — a deliberate choice to keep the wire/reads/persistence surfaces
untouched. That is a legitimate complexity trade. So the honest fork for #3 is:

- **Family / child machines** — truest to "machine = unit of composition"; the
  workflow is a normal chart; but it extends the reads model
  (`read(family(id), …)`) and per-key persistence.
- **Regions** — protects those surfaces (shared context, one snapshot), at the
  cost of a second composition mechanism inside the machine.

**A further direction we're exploring** (which pulls toward the family framing):
**reusable, generic machines**. If a per-record workflow is a machine, the
recurring shape — an async update through `idle → committing → ok/conflict/failed`
with retry — can be a *parameterized, reusable* machine that slots in as a child.
A collection then becomes a supervisor over a family of a generic `AsyncUpdate<T>`
child, one per record. That is TanStack-Query-style async lifecycle management,
but as a first-class, server-canonical, *auditable* state machine that composes
into the machine graph — something no server-canonical framework offers. Early,
but it's the reason we want to reopen #3 around composition rather than commit to
intra-machine regions first.

**Recommendation.**

1. Ship **machine-level `on:`** now — removes the correctness hazard (#1) and the
   duplication (#2) with a small, obviously-correct primitive.
2. Reopen **#3** as a deliberate, evidence-driven track: prototype child/family
   composition (and a reusable `AsyncUpdate` generic machine) against a *second*
   collection example, and decide family-machines vs regions from what that
   surface demands. Regions remain the fallback if the reads/persistence cost of
   families proves prohibitive.

The RFC diagnoses a real, core problem well. Decomposed, most of the *danger* is a
small primitive we should just ship, and the *expressiveness* question deserves
to be re-opened around "a workflow is a machine" — and possibly around reusable
machines — before committing to intra-machine regions.

---

## 2.0-cut review note (2026-08-09)

Constraint recorded while sweeping majors-risk before the 2.0 release:
`getSnapshot().value` has real consumers in the wild (`value.at(-1)`,
whole-array equality in app tests), so the shape change described under
"Persistence and the wire" — `value` widening from a flat path to a
per-region object — would be a BREAKING change for user code, i.e. it would
force a 3.0 on its own. Amendment for the next draft: **flat machines must
keep `value: string[]` byte-for-byte**, and regions should arrive as a NEW
snapshot field (e.g. `regions:`) alongside it, with `value` continuing to
carry the default region's path. That makes the whole feature additive and
shippable in a 2.x minor, which matches its "1.x richness slot" intent.
