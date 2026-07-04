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
point. Content that changes over time must flow through its own binding:

```
{each(
  read(list, (l) => l.rows),
  (row) => (
    <li>
      {/* updates in place, wherever the row moves */}
      {read(list, (l) => l.rows.find((r) => r.id === row.id)?.label ?? '')}
    </li>
  ),
  { key: (row) => row.id },
)}
```

A plain interpolation like `{row.label}` renders once, at insert. This is the
same doctrine as everywhere else in Stator — [read selectors are the unit of
reactivity](/concepts/reactivity-and-reads/) — applied to rows.

Inner slot ids are derived from the item's **key**, not its position
(`s0:kp1:s0`), which is what lets a patch address "the row for p1, wherever
it is now."

## When to stay unkeyed

If rows are pure display (no inputs, no transitions, no client state), the
unkeyed full-body re-render is simpler and produces one patch instead of a
diff. Reach for `key` when identity matters, not by default.
