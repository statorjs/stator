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

The maintainer response leans toward the family/child-machine framing, possibly
seeded by a reusable generic `AsyncUpdate<T>` machine. Decision deferred to a
second collection example + a design pass; two constraints are fixed: full generic
inference end-to-end, and placement portability preserved via injection-traced
capabilities.

## Open Questions

Carried from the RFC: regions vs. families; per-key context vs. shared; keyed
lifecycle/virtualization; a reusable-machine standard library; event routing
(explicit vs. auto by key); inspector presentation of a keyed family at scale.

## Implementation Notes

Not started — motivation/direction record. Evidence: `examples/stockroom` (the
inventory admin) and its machine test. Related: machine-level `on:` (shipped,
Evidence 1's drop fix), per-row item-value bindings (Evidence 3's inline stopgap),
the parallel-regions RFC (design exploration).
