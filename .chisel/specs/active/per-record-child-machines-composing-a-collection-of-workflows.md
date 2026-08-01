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

## Approach

Open — the two candidate shapes are in the parallel-regions RFC:
- **Intra-machine parallel regions with a keyed family** — keeps one actor,
  shared context, one snapshot; adds a delivery loop + keyed routing.
- **Child / family machines** — each record is a real machine (its own chart);
  truest to "machine = unit of composition" and the only shape that fixes
  Evidence 3 (the child reads its own machine); extends the reads model
  (`read(family(id), …)`) and per-key persistence.

The maintainer response leans toward the family/child-machine framing, seeded by a
reusable generic `AsyncUpdate<T>` machine. Of the two fixed constraints, **the
generic-inference one is now retired — GREEN** (see below). The decision between
regions and families still wants a second collection example + a design pass.

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
   remains is the **template/compiler** lowering of `read(family(id), …)` (reading a
   child through its host in a `.stator` template, not just via the actor API).

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
