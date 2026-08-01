# Findings — building the stockroom example

An editable inventory admin: a table of records, each with its own async save
(optimistic concurrency), plus a machine-wide "refresh". Built the natural, flat
way a user would — which is exactly what surfaces the framework gaps below. Per
CONTRIBUTING's "findings over patches"; each is worked around or accepted in the
example, and the note is for the framework.

**Status:** #1 has a design (region-markers spec); #2 and #3 feed the
parallel-regions / child-machine composition thread. Durable design records live
in `.chisel/specs/` and `ROADMAP.md`; this file is the evidence.

## 1. A reactive `each` of `<tr>` does not render — the wrapper span is foster-parented out of the table

`routes/index.stator` renders the rows as `each(rows, row => <tr>…</tr>)` inside a
real `<tbody>`. Every reactive region wraps its body in a
`<span style="display:contents">`, so the server emits (verbatim, confirmed):

```
<tbody><span data-slot="s1:bready:s0" data-list="true" style="display:contents"><tr>…
```

A `<span>` is not valid content in table context. The browser's "in table body"
insertion mode **foster-parents** it out of the table, so the reactive `<tr>` set
does not render where it should — the most natural admin/dashboard shape is
broken.

- **Not caught by tests today:** happy-dom (the framework's test env) does not
  implement the parser's table insertion modes, so the whole suite is blind to
  this — a repro must run in a real browser.
- **Design:** region boundaries become HTML comment markers (no box, legal in
  table context) and DOM patches materialize via `<template>`. See
  `.chisel/specs/active/region-markers-and-template-parsed-dom-patches.md`. This
  example is that spec's acceptance repro.
- **Until then:** the table renders correctly *server-side as a string* (the app
  typechecks and serves), but a browser mis-parses it. The example is
  intentionally pre-fix.

## 2. A per-record completion was stranded when the machine-wide axis moved — RESOLVED with machine-level `on:`

`InventoryMachine` has two independent axes — freshness (`loading`/`ready`) in the
chart, and a per-record save workflow. A flat machine can only chart one, so the
per-record completions (`SAVE_OK`/`SAVE_CONFLICT`/`SAVE_FAILED`) had nowhere
state-scoped to live except `ready`. When a `REFRESH` moved the machine to
`loading` while a save was in flight, that save's completion arrived in `loading`,
was dropped (handlers are state-scoped), and the row stranded in `saving` forever
— even though its effect fired on schedule.

- **Fix:** the completions now live in a machine-level `on:` block (handlers that
  apply in any state, consulted when the current state does not declare the
  event). The completion is handled whether the machine is `ready` or `loading` —
  no drop, and no need to duplicate the three handlers into `loading`. Shipped as
  a framework primitive (see the changeset); a state-scoped handler still wins
  where one exists, so nothing else changes.
- **Runnable repro / regression:** `tests/inventory.test.ts` — the happy-path save
  settles to `clean`; the same save with a `REFRESH` interleaved before the
  completion *also* settles to `clean` now (it stranded at `saving` before the
  primitive). Deterministic — completions are delivered by hand, no timing race.
- **What it does NOT fix:** the save phase still lives in `ctx.saves`, so the
  per-record *workflow* is still not a chart (see finding 3). Machine-level `on:`
  removes the drop and the duplication; making the workflow first-class is the
  child/family-machine composition direction (parallel-regions RFC + response).

## 3. The per-record workflow is invisible in the chart, and its state can't use the clean item read

Because the save workflow is pushed into a `ctx.saves: Record<id, phase>` map, two
costs show up in the template (`routes/index.stator`):

- The live "on hand" cell is a clean item read: `read(row, (r) => r.onHand)`.
- But the save **status** cell cannot be — the phase is not a field of `row`, it
  lives in the side map — so it is forced back to a machine read keyed by id:
  `read(inventory, (i) => i.saveOf(row.id).phase)`. The asymmetry in one row is
  the audit-surface erosion made concrete: the interesting per-record state
  (conflict, failed, retry) is not in the chart and not on the record — it is
  reconstructable only by reading a context map.

This is the motivating evidence for treating a per-record workflow as a
first-class **machine** (child/family composition) rather than a phase string in a
context map — the "machine is the unit of composition" direction.
