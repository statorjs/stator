---
title: Per-row item-value bindings in each
status: draft
created: 2026-07-20
updated: 2026-07-20
area: runtime
---

## What and Why

An each item field interpolated as `{item.field}` is a **static capture** — baked
into the row's HTML at render, never updated. So when the item's content changes,
the framework has only blunt tools:

- **Non-keyed** lists diff by reference. A `session` context is `structuredClone`d
  per transition, so the array selector returns fresh references after *every*
  event — the list re-renders its whole body even on an event that never touched
  it (see `examples/weather/FINDINGS.md` #5).
- **Keyed** lists never re-render a retained row (correct for DOM stability), so a
  `{item.field}` static capture inside a keyed row goes **stale**.

The workaround both force is the same, and it appears wherever a live list is
rendered: re-derive the field from the machine by re-finding the item by id.

```jsx
// todomvc, live-poll, desksmith cart, with-auth notices — all carry this:
{read(machine, (m) => m.collection.find((x) => x.id === item.id)?.field ?? fallback)}
```

It is verbose, O(n) per field per row, and confusing to teach. The fix lets an
item field be read **directly from the row**, using the same `read()` marker
already used for machine state.

**Why `read()` and not implicit `{item.field}` reactivity.** Stator's central
promise is that live data is *visible*: `read()` marks it, a plain `{expr}`
renders once, and there is no "why did this re-render?". Making `{item.field}`
implicitly live would break that — a bare interpolation would be live with no
marker, indistinguishable from a static one. So the item field is read the same
way everything else live is: `read(item, (i) => i.field)`. The source is the row
instead of a machine; the rule ("`read()` = live") is unchanged.

## Success Criteria

- `read(item, (i) => i.field)` in a row emits **one `text` patch** for that field
  on change; the row DOM (focus, islands, ids) is untouched. No re-render.
- Identity churn with unchanged content emits **nothing** (values compared, not
  references).
- Holds for **both** non-keyed and keyed lists (per-key, stable across moves).
- The `find`-by-id workaround collapses to `read(item, …)` (validated: todomvc,
  live-poll).
- A plain `{item.field}` still renders **once** — the reactivity doctrine is
  intact, not bent.
- **Non-breaking** (minor).

## Constraints

- **`read()` is the one live marker.** No implicit reactivity; a plain `{expr}`
  stays static.
- **Text and attribute positions** (attr landed as the follow-up cut on
  `feat/attr-position-item-reads`): an attr item read carries the same
  semantics as a machine attr read (false/null removes, true renders bare) and
  is single-source — no literal-text mixing, and not inside a `:list` spec.
- **Server render path only** — client-island shells keep the plain lowering.
- **Compiler-local** — a mechanical AST transform, no type info, no cross-file
  resolution.
- **Placement: an item read is owned by its row** (decided post-#24, after the
  todomvc arm crash). It's legal at the row's top level and inside a nested
  `each` that binds it (a nested each re-establishes row context on every arm
  render — live-poll's shape). It's a **compile-time error** in three positions,
  with a runtime `itemBind` backstop for hand-written templates:
  1. inside a `when`/`match`/`defer` — an arm re-renders via the branch
     binding's recompute, *without* row context (`renderBranchBody` has no row),
     so the binding would crash or orphan. Shipped bug: todomvc's label inside
     the view arm crashed recompute on EDIT_SAVE (#24).
  2. reading an *outer* each's item inside a nested each's row — the inner row
     would evaluate the selector against the wrong item.
  3. inside a `class:list`/`style:list` spec — the compound directive
     recomposes per machine, not per row (deferred surface).
  **Why forbid, not support:** supporting arm-interior item reads means
  branch↔row context restoration — cross-owner coupling at the scope/identity
  seam (the standing complexity watch-item), and the first hierarchical
  ownership machinery in the diff engine. The error preserves optionality:
  lifting it later is a non-breaking minor. This *narrows* (does not reverse)
  the shipped conditional-arm spec's "fix, don't forbid" call — see the scope
  note added there. **Revisit trigger:** if two more real templates end up
  carrying find-by-id machine reads inside arms for item-local data, that is
  the evidence bar for designing row-context restoration as deliberate 1.x
  work.

## Approach

Two layers; the runtime is the load-bearing one and it composes with the existing
binding model.

**1. Compiler** (`compiler/lower.ts`). Lower `read(<itemParam>, selector)` to
`itemBind(selector)`, where `<itemParam>` is the current each callback's item
param (matched by identifier via `eachItemParamsFor` + `isItemRead`). A machine
`read()` — first arg is not the item param — passes through unchanged. Nested
each nests via a save/restore of the current item param, so `read(inner, …)`
binds to the innermost row. That's the whole compiler change: **no auto-wrapping,
no free-variable analysis, no row guard** — because nothing is implicitly live,
there is no silent-staleness case to guard against (`raw(item.icon)` next to a
`read(item, …)` simply renders once, honestly).

**2. Runtime** (`template/each.ts`, `server/recompute.ts`, `server/render-context.ts`).
`itemBind(selector)` registers a per-row `ItemBinding { slotId, selector,
lastValue }` on the render state's `currentRowBindings` and emits a
`<span data-slot>`. These bindings are **owned by the ListBinding**, not
`state.bindings`/`byMachine`, and re-evaluated during the list's own recompute.

- Non-keyed: `ListBinding.rows?: ItemBinding[][]` (by position). A same-length
  list diffs each row's bindings → `text` patches; a length change falls back to
  a wholesale re-render.
- Keyed: `KeyedListBinding.rowsByKey?: Map<string, ItemBinding[]>` (by identity
  key, stable across moves). After the key-shape diff, retained keys re-evaluate
  their bindings → `text` patches.

**3. Types** (`template/read.ts`). `read()` gains an item overload
`read<TItem, TResult>(item: TItem, selector: (item: TItem) => TResult)`. It exists
only for typing — the compiler rewrites the call before runtime, so the runtime
`read()` stays machine-only (and still throws on a non-machine, which now means "a
compiler bug", since a real item read never reaches it).

## Alternatives Considered

- **A — value (structural) compare only.** Make the non-keyed each compare item
  *values* so churn stops re-rendering. Cheap, but no fine-grained update and
  nothing for keyed staleness. A subset of this design.
- **B — keyed content-refresh (re-render retained rows).** Fine-grained-ish, but
  re-rendering nukes client island state and reallocates ids. Breaking-ish.
  Rejected.
- **C-implicit — auto-wrap `{item.field}`.** Terser (no `read`), and it was built
  first. Rejected: it makes a bare `{expr}` live with no visible marker, breaking
  the "reactivity is always visible" doctrine, and it required a compiler *guard*
  (skip rows containing `raw()`/nested `each()`) to avoid silently leaving their
  non-binding content stale. Fragile and off-brand.
- **C-explicit (chosen) — `read(item, selector)`.** Preserves the doctrine
  exactly, and is *less* code: no auto-classify, no guard, no silent-staleness
  class of bug. The one cost is `read(item, i => i.x)` over a bare field access —
  still far less than the find-by-id workaround.

## Open Questions

Deferred surface — each is an additive minor, trackable as its own work:

- ~~**Attribute-position item reads**~~ **LANDED** (`feat/attr-position-item-reads`):
  `ItemBinding` discriminated by position (text slot vs attr + element id),
  `handleItemRead` in `html.ts` mirrors `handleRead`, both list diffs emit
  `attr` patches through `diffItemBindings`. Seam-tested: a keyed row's attr
  patch targets its key-scoped element id across a move
  (`tests/each-attr-item-bindings.test.ts`). Demos: todomvc `checked=`,
  live-poll's results-bar `style=` width (the ten-line find-by-id collapsed via
  a row-complete `pct` shaped in the selector).
- **Item reads inside `class:list`/`style:list` specs** — not supported (the
  compound directive recomposes per machine, not per row); compile error + a
  runtime guard (previously rendered `[object Object]` silently). Mixed
  machine+item sources in one compound attr is the branch↔row seam in
  miniature — support only with evidence.
- **`raw(item.…)` reactivity** — item-dependent HTML still renders once.
- **Unkeyed all-static churn.** A non-keyed list with *no* `read(item, …)` binding
  still re-renders on identity churn (reference compare in the wholesale path).
  Keyed lists and rows with any per-row binding are already churn-free; a
  whole-array value compare would close the remaining case (finding #5's original
  suggestion (a)).

## Implementation Notes

Runtime + keyed built first, then reworked from an implicit `{item.field}` form to
the explicit `read(item, …)` marker (which deleted the auto-classify and the row
guard). Runtime unchanged by the rework.

Tests: `tests/each-item-bindings.test.ts` and `tests/each-keyed-item-bindings.test.ts`
(runtime — retained-row patch, churn, move+content, insert, non-scalar deep
compare); `tests/compiler-item-bindings.test.ts` (the `read(item, …)` → itemBind
lowering, plain field stays static, machine read untouched, keyed, nested,
raw-coexist, client-gate). `identical-patches` proves compiled output equals
hand-written.

Demos: `examples/todomvc` (`read(todo, t => t.title)`, keyed) and
`examples/live-poll` (`read(option, o => o.count)`, non-keyed) — both typecheck
through the real compiler and lower to `itemBind`.

**Placement gate landed** (branch `fix/forbid-item-reads-in-arms`): compile-time
pre-pass in `lower.ts` (`checkItemReadPlacement`, modeled on the defer gate)
rejecting the three illegal positions with ownership-framed errors naming the
escape hatches; runtime backstops in `each.ts` (`itemBind`) and
`directives/list-attr.ts` (an item read in a `:list` spec previously rendered
`[object Object]` silently). todomvc restructured to the stock TodoMVC pattern:
the view renders unconditionally (CSS toggles via `li.editing`, rules already in
the stylesheets) so the label's `read(todo, …)` sits at the row's top level; the
edit form **stays** a `when()` arm — machine reads only, and the fresh arm
render is what makes `autofocus` fire. Tests: `tests/item-read-placement.test.ts`
(8 compiler + 3 runtime, including the #24 arm-flip regression). Docs: placement
rules in the keyed-lists guide, ownership model in reactivity-and-reads.

Pending graduation: squash the spike commits, PR. Supersedes the value-compare
suggestion in FINDINGS #5 (that file is transient; this spec is the durable
record).
