---
title: 'Per-record child machines: composing a collection of workflows'
status: draft
created: 2026-08-01
updated: 2026-08-01
area: runtime
---

## What and Why

The recurring hard shape is a **collection of per-record workflows** — an admin
table, a queue, a dashboard: N records, each with its own little state machine
(idle → committing → settled | conflict | failed, with retries), sitting under a
machine-wide axis (loading / ready). Building the `stockroom` example (an editable
inventory admin) the natural, flat way surfaced **three independent frictions that
all point at the same missing primitive: a per-record workflow should be its own
machine, and a machine should be able to own a keyed collection of them.**

This spec is the motivation record for that direction. The fuller design
exploration (intra-machine parallel regions vs. child/family machines, and the
"reusable generic machine" idea) lives in the parallel-regions RFC + maintainer
response; the decision between those shapes is still open. What is settled is the
*problem*, from three angles:

### Evidence 1 — correctness: completions strand (the effects angle)

A flat collection machine puts freshness (`loading`/`ready`) in its chart and
pushes the per-record save workflow into `context` (`ctx.saves: Record<id,
phase>`). A per-record save's completion (`SAVE_OK`/`CONFLICT`/`FAILED`) can only
be handled where it is declared — `ready` — so a `REFRESH` that moves the machine
to `loading` mid-save drops the completion and strands that row in `saving`
forever. **Resolved for the drop** by machine-level `on:` (shipped) — handlers
that apply in any state. But that fixes the *drop*, not the fact that the workflow
is a phase string in a side map rather than a chart. Runnable repro:
`examples/stockroom/tests/inventory.test.ts`.

### Evidence 2 — audit surface: the workflow is invisible in the chart

Stator sells "read the chart to audit every state, event, guard." The per-record
workflow — where the interesting states (conflict, failed) and their retries live
— is not in the chart; it is reconstructable only by reading a context map mutated
by action bodies. In one row this shows as an asymmetry: the live "on hand" cell is
a clean item read `read(row, r => r.onHand)`, but the save **status** cell can't be
(the phase isn't a field of `row`, it's in `ctx.saves`), so it's a machine read
keyed by id. The interesting per-record state is neither in the chart nor on the
record.

### Evidence 3 — composition / DX: item reads don't cross a component boundary

Decomposing the table into per-row child components —
`each(read(m, i => i.rows), (row) => <StockRow row={row} … />)` — was built and
measured. **Composition itself works**: a keyed `each` whose body is a component
renders one root element per item under the row's key scope, and its bindings
update reactively. **But item reads don't cross the boundary**: in `<StockRow>`,
`row` is a prop, not the each item param, so `read(row, …)` isn't an item read —
it lowers as a machine read and throws. The child's live cells fall back to
find-by-id machine reads (`read(m, i => i.rows.find(r => r.id === id)?.field)`) —
O(n) per cell, O(n²) per table. Static fields (`sku`, `name`) pass cleanly as
props; only the live fields pay the tax.

That find-by-id is the **symptom of the row not having its own machine**: the child
reaches back into the parent and re-locates itself by id on every cell precisely
because the row is a slice of `ctx.rows`, not an addressable unit. With a
per-record child machine, `<StockRow>` would read *its own* state
(`read(rowMachine, m => m.onHand)`) — clean AND composable, no find-by-id, no O(n²).
Item-value bindings are the inline-only stopgap that works until the list is
decomposed into components; see the "inline-only" note in
[`per-row-item-value-bindings-in-each.md`](per-row-item-value-bindings-in-each.md).

**Second independent instance — `live-poll` poll-page (found 2026-08-02, examples
style-guide cleanup).** Bringing the examples to a component style guide, `poll-page`
hit exactly this wall: its live results rows use item reads (`read(option, o =>
o.count)`, the bar's `read(option, o => o.pct)`), so the row can't be a
`<ResultsRow>` component — it stays inline, and that inline row is the bulk of the
file. A second, *independent* example of this friction (stockroom's table was the
first) — which is this spec's own promotion trigger. **A useful nuance it adds:**
poll-page's rows are *read-only live displays*, not per-record *workflows* (no
save/conflict/retry). So the demand splits into two shapes — **read-only addressable
rows** (poll-page, most tables/dashboards) vs. **per-record workflows** (stockroom's
saves). The first doesn't need a machine per row at all; it needs only *item reads
that cross a component boundary* (pass the item, read it reactively in the child).
That points at a **lighter primitive** — cross-boundary item reads — that may cover a
large share of the cases the child-machine design targets with the heavier hammer;
worth weighing when the regions-vs-families build is scoped (it may be the cheap
first slice). (Decomposing poll-page further also prop-drills `polls`/`voter`/`pollId`
into both extracted panels — a second witness for
[`ambient-by-def-machine-reads-with-a-typed-requirement-channel.md`](ambient-by-def-machine-reads-with-a-typed-requirement-channel.md).)

### Evidence 4 — authoring DX: reusable machines are how you shrink a large `defineMachine`

Separately, a machine-authoring-DX pass (riffed 2026-08-01) asked "what higher-level
abstraction — e.g. JSX for state machines — would cut `defineMachine` boilerplate?"
and landed back here. The bulk of a large machine (188 lines for stockroom) is not
domain logic; it is **recurring workflow shapes written inline** — an async op is
always idle→committing→ok/conflict/error, a load is always loading→ready+completion.
A *syntax* layer (structural JSX) makes all of it terser-but-still-inline (a modest
win, mostly covered by extracting inline callbacks to named functions). The real
leverage is **raising the abstraction**: a small library of **reusable generic
machines** (`AsyncUpdate`, `Load`, `Poll`) composed as children, so the host
collapses to its own domain state + the composition, and the recurring clusters move
out into named, reusable units. That reusable primitive is the same one this spec
needs — the authoring-DX thread resolves *into* this one. (Left open there: "magic
strings" — typed name accessors like `M.states.ready` / `M.events.SAVE` derived from
the def, a separate small ergonomic item that doesn't need child machines.)

## Success Criteria

A machine can own a keyed, dynamic collection of per-record child machines such
that: (a) a completion routes to its record's own actor and cannot strand; (b) the
per-record workflow is a real chart (auditable); (c) a per-row component reads its
own record's machine directly, so a list decomposes into `<Row>` components
without find-by-id. Non-breaking for the flat/inline case.

## Decision — families (2026-08-01)

**The collection-of-workflows shape is a families problem; regions are parked** as a
distinct future primitive for *orthogonal aspects of a single entity* (static, shared
context) — not a rival here. Reframe that drove it: A (regions) and B (families) don't
solve the same shape. Families = *a dynamic collection of like entities*, each with
its own lifecycle; regions = *orthogonal aspects of one entity*. A per-record
collection is N runtime-keyed disposable entities — modelling it as "0..N dynamic
parallel regions" is the awkward corner of statecharts. Decisive axes: **Evidence 3**
(a per-row component reads its *own* machine — only families give the row an address;
regions leave it a slice of the parent → find-by-id persists), **per-child isomorphic
placement** (effectful child→server, interaction child→client per the two-family
taxonomy; regions force one plane), and **keeping the engine core untouched** (the
ownership spike needed zero engine changes; regions would rewrite the actor event
loop — the one layer we want proven-and-simple).

Grounding (why the "families relocate complexity to a harder layer" critique fails):
families reuse layers already built for multiplicity. The `Store` is already a
per-session `(machineName → snapshot)` map with **per-session TTL** ("the session is
the TTL unit; machines within a session are not independent") — a keyed family is more
named entries under the same session, not a new persistence model. Session actors are
**per-request-transient**, hydrated from the host's own enumerated keys (`ctx.rows`),
so "N child actors" is a per-request working set, not standing memory. Cross-machine
reactions (host↔child) ride the existing `subscribes` cascade (`subscribersBySource`,
`MAX_CASCADE_DEPTH`). The genuinely-new surface is a **naming convention + dead-key GC
+ the compiler binding** — not a new persistence or concurrency layer.

### Single child vs. keyed family — one idea, cardinality as a modifier

Considered whether "a host owns ONE named child" and "a host owns a KEYED FAMILY" are
the same concept or distinct. **Verdict: one underlying idea (a host owning child
machines) with cardinality as a modifier — one runtime substrate, one keyword,
`keyed()` as the discriminator.** What's shared is the whole substrate
(hydrate/persist/route/dispose); what differs is only *cardinality-known-at-authoring
vs. runtime*, which cascades into access shape, lifecycle, template pairing, and
lowering. Precedent splits these into TWO keywords (XState `invoke` vs `spawn`; Elixir
`Supervisor` vs `DynamicSupervisor`) because lifecycle differs — but Stator can express
that same distinction through the *value shape* instead of two declaration sites:

```ts
defineMachine({
  children: {
    checkout: CheckoutMachine,                          // un-keyed → host.checkout : InstanceOf<…>             (property, always present, host-bound life)
    save: keyed(AsyncUpdate(commit), (r: Row) => r.id), // keyed    → host.save(id) : InstanceOf<…> | undefined (accessor, dynamic, GC'd; pairs with `each`)
  },
})
```

The `keyed()` wrapper flips the type surface and lifecycle exactly where they differ —
property vs. keyed-accessor-returning-maybe, host-bound vs. dynamically-GC'd — and
nowhere else. This **supersedes the earlier `family:`-only sketch**: `children:` reads
correctly for one *or* many; `family` implied a multiplicity wrong for the single case
(which is likely the *more common* entry point — a form with one async save — so it
gets the clean non-optional property access, not a family-of-size-1 maybe-accessor).
Keyword itself (`children` vs `use`) is a non-blocking bikeshed. Lowering: one runtime
mechanism for both; a fixed single child *could* be compile-time-inlined later as an
optimization, not a separate concept.

### Build gate

Design settled; **the build stays evidence-gated** (repo promotion discipline).
Trigger: a second independent collection example, or a real user hitting Evidence 3 (a
per-row component forced into find-by-id). Until then this is ready-to-build, not a
build order — when triggered, a staged build spins out (save-workflow-as-child first,
host keeps `ctx.rows`, deferring per-key persistence; then row-as-child as per-key
context lands).

## Approach

The two candidate shapes weighed (**decided: families, see Decision above**):
- **Intra-machine parallel regions with a keyed family** — keeps one actor,
  shared context, one snapshot; adds a delivery loop + keyed routing.
- **Child / family machines** — each record is a real machine (its own chart);
  truest to "machine = unit of composition" and the only shape that fixes
  Evidence 3 (the child reads its own machine); extends the reads model
  (`read(family(id), …)`) and per-key persistence.

The family/child-machine framing is the decision, seeded by a reusable generic
`AsyncUpdate<T>` machine. **All three de-risking gates are now GREEN** (typing,
single-actor runtime, family ownership — see below); what stays gated is the *build*,
not the design.

### Granularity — how much moves into the child

The regions-vs-families question has a second axis that sharpens it: **how much of
the record moves into the child.** Two granularities of the same move:

- **Save-workflow-as-child** (minimal) — the host keeps `ctx.rows`; only the async
  save workflow becomes a child (a keyed `AsyncUpdate` family). Host↔child
  coupling: a subscription applies the child's success back to the row. Kills
  find-by-id partly.
- **Whole-row-as-child** (fuller) — the record *is* a machine (`RowMachine` owns
  `onHand`/`draft`/`version` + its workflow); `ctx.rows` disappears, the family
  *is* the collection. No host↔child subscription (the child owns its data). Fully
  kills find-by-id (Evidence 3) — the child reads its own machine.

Crucially these are **the same primitive** (a host owning a keyed family of child
machines), not stacked features — the only difference is whether the child is a
reusable generic `AsyncUpdate` or a hand-written domain `RowMachine`, and a concrete
`RowMachine` is *typing-lighter* (no generic inference — the harder case is already
green). Row-as-child exercises *more* of the runtime surface, though: data
ownership moving into the children leans on **per-key context** and **family
reads/iteration** (`each` over a family, `read(family(id), …)`), two still-open
items. Natural sequence: build ownership on the minimal slice first (host keeps
`ctx.rows`), then let data migrate into the children as per-key context lands —
which also de-risks it (the concrete `RowMachine` rides rails the green generic
gate already laid).

### Generic-machine typing — GATE GREEN (spike, `spike/generic-async-update-machine`)

The load-bearing risk under this whole track — *can a reusable generic machine
carry full end-to-end inference?* — is answered **yes, with no new primitive**. A
reusable machine is a **factory that closes over an injected `op` and returns
`defineMachine(...)`**, with the payload/result types woven through
events/context/selectors:

```ts
function defineAsyncUpdate<TPayload, TResult>(name, op: (p: TPayload) => Promise<TResult>) {
  return defineMachine({ /* SUBMIT{payload:TPayload} | OK{result:TResult} | … */ })
}
const save = defineAsyncUpdate('save', (p: {id;qty}) => Promise<{version}>)  // T's inferred from op
```

Proved (`tests/spike-async-update.test-d.ts`, tsc-clean): `TPayload`/`TResult`
infer from the injected op; `InstanceOf<typeof save>.result` is `{version}|null`
(the op's return flows to a template read); `.state` is the workflow's state union
(typo errors); `.send()` checks the parameterized payload and rejects unknown
events. The existing `defineMachine` inference carries type parameters through
cleanly — the hardest engineering risk in the track needed nothing new.

### Authoring reusable machines — it's `defineMachine`, not a new `define`

The typing gate settled the *authoring* API too: a reusable machine is **a generic
function that returns `defineMachine(...)`**, with what-varies lifted to type params
+ args. No second `define`. Three reasons: it's what's proven (full inference, no new
primitive); a generic function is the natural TS expression of "generic over
payload/result" (an options-object DSL to declare `<P,R>` fights inference); and a
reusable machine stays a *real, inspectable* machine — a family of `AsyncUpdate`s is
N ordinary defs, nothing new for the inspector/manifest/`stator check` to special-case.

Authoring spectrum, one mount API:
- **Concrete reusable** (`const RowMachine = defineMachine(...)`, reused across
  tables) — works today.
- **Parameterized reusable** (generic fn → `defineMachine`, op injected) — the
  `AsyncUpdate` form, works today.
- The **mount API takes a def either way** — the only genuinely new surface, on the
  *consumer/host* side, not authoring.

Injection and identity are orthogonal, not one fluent chain: **op injected at
definition time** (factory arg, as proven), **key supplied at mount time** (the
identity/collection dimension). So `.keyed().inject()` resolves to `keyed(keyFn,
factory(op))` — two flat concerns. This forces a signature refinement the ownership
spike should honor: **the factory should not require a fixed `name`** (the spike had
`defineAsyncUpdate('save-qty', op)`); a keyed family's identity is `mountName + key`,
so `family: { save: … }` owns the name and the factory's `name` becomes an optional
label/default. **Op-first, name-optional.**

Ship the recurring shapes first-party (`AsyncUpdate`, `OptimisticSave` — stockroom's
conflict variant, `Load`, `Poll`) so authoring-your-own stays an escape hatch, not
the common path. Two light conventions make the build-your-own / npm path
frictionless (neither a new API): a `MachineFactory<P,R>` **type export** (preserves
inference across a package boundary) and a **provenance tag** (`meta: { kind:
'AsyncUpdate' }`) so tooling groups a family and recognizes the pattern (the hook
into the [introspection substrate](../../docs/introspection-manifest-and-checks.md)).
A community helper is then just a package exporting generic functions that return
`MachineDef` — no plugin protocol, no registration.

**Two families of reusable machine — a split that's already structural.** The stdlib
divides along Stator's own action/effect line. **Effectful** machines trigger
externalities via an injected `op` — `AsyncUpdate`, `OptimisticSave`, `Load`, `Poll`.
**Pure interaction** machines are component behavior with no I/O —
`Toggle`/`Disclosure`, `Tabs`, `Accordion`, `Menu`, `Combobox`, `Listbox`, `Dialog`,
`Stepper`. The split is not cosmetic: a machine *is* effectful iff it declares effects
(`effect`/`entry`), which the engine already tracks — a pure interaction machine pins
nothing (`serverPinned:false`, client-plane natural), an effectful machine's server
`op` pins it server-side (Open Question 3). So the categories map onto
interaction-vs-workflow *and* client-vs-server at once. They parameterize differently
too — effectful over an injected **op** (`keyed(keyFn, factory(op))`), interaction over
**config** (`Tabs({ orientation, loop })`, no op) — which is why "a generic fn
returning `defineMachine`" is the right common substrate under both. The interaction
shelf is a **distinct thread**: it's the WAI-ARIA APG catalog (each pattern a
keyboard-driven state machine) rendered server-canonical + isomorphic —
a11y-by-construction, the Zag.js/React-Aria space from Stator's angle — and it couples
1:1 to a `.stator` component rather than mounting into a domain host. Crucially the
categories **layer**: a pure interaction shell can own effectful children (a `Stepper`
whose steps are `AsyncUpdate`s, `Tabs` that `Load` per tab) — this very composition
track. The `kind` provenance tag should carry the category, so tooling groups by it
and a check can flag an "interaction" machine that smuggles in a server effect.

## Open Questions

The generic-inference gate is retired, and the **ownership mechanic is now GREEN**
(spike, `spike-family-ownership-runtime.test.ts`): `createFamily` over `createActor`
spawns one child actor per key on first touch, routes an event to the right child,
reads a child's state back (`stateOf`/`snapshotOf` — the `read(family(id), …)`
analog), and disposes/respawns — each child an independent actor, all under one
op-first/name-optional label, keyed via `keyed(keyFn, def)`. No new engine surface,
same as the reusable-machine spikes. What remains is the **server-plane wiring** and
the **compiler surface** (and it is still where "regions vs. families" is decided):

1. **Ownership / family lifecycle** — *mechanic proven* (keyed spawn/route/dispose).
   Remaining: routing child effects through a server session's off-lock effect queue
   (children ran effects LOCALLY in the spike), and **per-key persistence** across
   restarts (each child's snapshot keyed under the host's session).
2. **Addressing / naming** — *largely resolved*: identity is the family key, not
   `def.name` (op-first/name-optional confirmed at runtime; `key → instance` proven).
   Remaining: stable key identity across restart/hydration (the persistence tie-in).
3. **Placement tracing** — the injected `op` determines server-only placement, but
   `computeCapabilities` scans only `reads`, so it would currently miss that a
   server-I/O op pins the child. Bounded gap (the second fixed constraint), untouched.
4. **Reads extension** — the read-BACK mechanic is proven at the actor level; what
   remains is the **template/compiler** lowering of the decided accessors —
   `read(host.child, …)` (un-keyed property) and `read(host.save(id), …)` (keyed) —
   reading a child through its host in a `.stator` template, not just via the actor API.

Also carried from the RFC: per-key context vs. shared; keyed virtualization; a
reusable-machine standard library; event routing (explicit vs. auto by key);
inspector presentation of a family at scale.

## Implementation Notes

Direction record + three green gates. Evidence: `examples/stockroom` (the inventory
admin) and its machine test; `tests/spike-async-update.test-d.ts` (typing gate);
`tests/spike-async-update-runtime.test.ts` (single-actor runtime gate);
`tests/spike-family-ownership-runtime.test.ts` (family ownership gate — keyed
spawn/route/read/dispose). Related: machine-level `on:` (shipped, Evidence 1's drop
fix), per-row item-value bindings (Evidence 3's inline stopgap), the parallel-regions
RFC (design exploration). Next: the "regions vs. families" decision + implementation
spec, now that all three de-risking gates are green — or the server-plane wiring
(per-key persistence + effect-queue routing) if we build ownership before deciding
granularity. The compiler surface (`family:` on `defineMachine`, `read(family(id),
…)` lowering) is the remaining unproven layer.
