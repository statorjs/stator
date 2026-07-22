---
title: Keyed lists
description: "Give list items identity so reorders move DOM instead of rebuilding it."
sidebar:
  order: 11
---

By default, `each` re-renders its whole body when the source array changes.
That's fine for display lists. It's wrong the moment a row holds state the
server doesn't know about — a focused input, a CSS transition, an open
`<select>`. Give the list a `key` and rows keep their identity:

```
{each(
  read(cart, (c) => c.items),
  (item) => <li class="cart-row">{item.productId}</li>,
  { key: (item) => item.productId },
)}
```

With a key, a change to the array becomes per-item patches — `insert`,
`remove`, and `move` — computed by a server-side diff. A reorder *moves* the
existing DOM nodes; the focused input in an untouched row stays focused.

## The rules

- **Keys are strings** (finite numbers are coerced). Anything else is a
  render error.
- **Keys must be unique** within the list. A duplicate is a data bug and
  throws rather than misbehaving quietly.
- **Each item renders exactly one root element.** Patches address the list's
  element children by index, so a multi-root item would corrupt its
  siblings' positions. The server enforces this at render.

## How content inside a row updates

A retained row is **never re-rendered** by the keyed path — that's the whole
point. A field that changes over time flows through a `read()`, the same marker
of live data as everywhere else. The source is just the row instead of a machine:

```
{each(
  read(list, (l) => l.rows),
  (row) => (
    <li>
      {/* live — patched in place, wherever the row moves */}
      {read(row, (r) => r.label)}
    </li>
  ),
  { key: (row) => row.id },
)}
```

`read(row, …)` is a **per-row binding**: a content change patches just that
field and leaves the row's DOM — a focused input, an island, its element ids —
untouched. Identity churn (the fresh array a clone hands back on every
transition) forces nothing, because it compares *values*, not references.

A plain `{row.label}` still renders **once**, at insert — [`read()` is the unit
of reactivity](/concepts/reactivity-and-reads/), in a row as everywhere else. Use
it for a field that never changes after insert; use `read(row, …)` for one that
does.

### Attributes

`read(row, …)` works in **attribute** position too — `checked={…}`,
`class={…}`, `style={…}` — with the same semantics as a machine attr read
(`false`/`null` removes the attribute, `true` renders it bare):

```
<input type="checkbox" checked={read(row, (r) => r.done)} />
<div class="bar-fill" style={read(row, (r) => `width: ${r.pct}%`)}></div>
```

An attribute is a **single source**: it's the whole value from one read (item
or machine), never literal text mixed with a read. And an item read can't
appear *inside* a `class:list`/`style:list` spec — give the whole attribute
one item read instead, or use a machine read in the spec.

A useful idiom follows from this: **shape row-complete items in the
selector**. If a row's display needs a derived value (a percentage, a label),
compute it onto the item in the `each` source selector — then every live field
in the row is a plain item read. Fields that depend on state *outside* the
item (a cross-row editing flag, a selection) stay machine reads. The two
coexist in one row, each used for what it is.

### Where `read(row, …)` may appear

An item read is **owned by its row** — the row render supplies the item, and
the list's recompute is what re-diffs the binding. It's legal anywhere the row
itself renders it, and illegal where something else would: the compiler rejects
the illegal positions at build time.

- **At the row's top level** — legal, the normal case.
- **Inside a `when()`/`match()` arm** — error. An arm re-renders on its own
  schedule, without the row around it, so the binding would be orphaned. Inside
  an arm, read the field from the machine
  (`read(m, (s) => s.items.find(…))`), or restructure so the arm doesn't split
  the row — render both states and toggle with a class binding + CSS.
- **Inside an `each()` that's nested in an arm** — legal, as long as the read
  binds *that* each's item. The nested each re-establishes row context on every
  arm render.
- **Reading an *outer* each's item inside a nested each's row** — error. The
  inner row would evaluate the selector against the wrong item. Derive the
  field onto the inner item, or use a machine read.
- **Inside a `class:list`/`style:list` spec** — error for now. The compound
  directive recomposes per machine, not per row.

The same ownership rule is why a machine read can't appear inside a `defer()`
arm — see [Every read has an owner](/concepts/reactivity-and-reads/).

Inner slot ids are derived from the item's **key**, not its position
(`s0:kp1:s0`), which is what lets a patch address "the row for p1, wherever
it is now."

## Keying is also a performance choice

A session/app context is `structuredClone`d on every transition, so
`read(m, (m) => m.rows)` returns a fresh array after **every** event to that
machine — even one that never touched `rows`. Per-row bindings absorb that: a
list whose rows carry them compares *values* and stays quiet when nothing
changed, keyed or not. The whole body only re-renders when the array changes
**length**, or when a row has no per-field binding to patch (see above).

Keying earns its place on **shape and stability**, not churn. When the length
does change, an unkeyed list re-renders its whole body while a keyed one emits
just the `insert`/`remove`/`move` ops for what moved — O(n) versus O(1). And
keyed items keep **stable, key-scoped element ids**, so `on:` handlers, bound
attributes, and islands inside a row keep addressing the right node across
reorders. For a short display list the difference is negligible; for a long or
frequently-reordered one, reach for `key`.

## When to stay unkeyed

If rows are pure display — no inputs, no transitions, no client state, no
element-id'd nodes (`on:`, bound attrs, islands) — *and* the list is short or its
machine rarely changes, the unkeyed full-body re-render is simpler. Otherwise,
reach for `key`.
