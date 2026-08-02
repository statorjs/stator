---
title: Where data lives
description: "Machine context is live state the UI renders against. Datasets belong in real storage, and the line between them is a performance decision, not a style one."
sidebar:
  order: 5
---

Every framework eventually gets the question: *where's my database?* Stator's
answer is a line you draw once and never blur — **machine context holds the
state your UI re-renders against, and everything else lives in real storage.**
Get the line right and your app stays fast for free. Get it wrong — a catalog
in context, upload bytes in a snapshot — and you build a performance cliff by
hand.

## The one rule: context is for what re-renders

A machine's context is *reactive working state* — the current selection, a form
draft, a workflow's phase, a small derived view. It is not your data layer.
Reference data (user accounts, a product catalog, historical rows) is read from
storage where it's needed and never copied wholesale into a machine.

The rule isn't stylistic. It falls out of how the engine keeps state coherent.

## Why: context is cloned per transition and serialized per touch

Two mechanics decide the cost of everything you put in context:

- **Every committed transition clones the whole context.** The engine hands your
  action a fresh `structuredClone` of context to mutate, then commits it — so an
  action pays to copy *all* of context, even the parts it never touches. Effects
  get their own commit-time clone on top of that.
- **Every touched machine is serialized to the store.** After a commit, the
  machine's full snapshot (state value + context) is serialized and written to
  the persistence adapter — per touched machine, per request.

:::caution[The self-inflicted cliff]
Put a 10,000-row catalog in context and *every unrelated event* — a toggle, a
form keystroke — pays to `structuredClone` and re-serialize all 10,000 rows.
Nothing rendered against them, but they ride along on every transition. This is
the single most common Stator performance mistake, and it's invisible until the
dataset grows.
:::

The fix is never "optimize the clone." It's "that data was never working
state — move it to storage."

## Reading data: synchronously, where it's needed

Frontmatter, guards, and selectors are **synchronous by contract** (that's what
keeps live diffing coherent — `await` has no home in a frontmatter block). So
reach for storage with a synchronous API. `node:sqlite` (Node 24+) is a good
default — its blocking API is exactly what synchronous code can call directly.

```ts
// lib/catalog.ts
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('app.db')

export const getProduct = (id: string) =>
  db.prepare('SELECT * FROM products WHERE id = ?').get(id)
export const searchProducts = (q: string) =>
  db.prepare('SELECT * FROM products WHERE name LIKE ? LIMIT 50').all(`%${q}%`)
```

Read it in a guard, a selector, or straight in a page's frontmatter — all
synchronous:

```ts
// a guard reads reference data to decide a transition
ADD_TO_CART: {
  when: (_ctx, ev) => getProduct(ev.id) !== undefined,   // no such product → guard drop
  do: (ctx, ev) => { ctx.lineItems.push({ id: ev.id, qty: 1 }) },
},
```

Context here holds the *cart* (small, reactive, re-renders) — the product
catalog stays in SQLite and is read on demand.

## Reading async data: `defer` or a loading machine

When the data is genuinely async — a third-party API, a slow query — it can't go
in frontmatter. Two escape hatches, by whether the result needs to be *reactive*:

- **Static-per-request** → [`defer()`](/recipes/defer-vs-machine/). The framework
  resolves the async region outside the synchronous render and streams it in as
  finished HTML. Perfect for "load this once, render it, done."
- **Reactive** → a machine with a `loading → ready | error` **entry effect**. The
  entry effect is the load role — it fetches on state entry, and the result lands
  in context as live state the page reads with `read()`.

```ts
// the reactive shape: an entry effect loads, the result becomes live state
states: {
  loading: {
    entry: async (): Promise<Events> => ({ type: 'LOADED', rows: await fetchRows() }),
    on: { LOADED: { to: 'ready', do: (ctx, ev) => { ctx.rows = ev.rows } } },
  },
  ready: {},
},
```

Even here, be deliberate: `ctx.rows` is now working state the UI renders, so it
*should* live in context — but scope it to what the view needs (a page of
results), not the whole table.

## Writing data: effects write

Reads come from storage synchronously. Writes go **out** through an effect — the
one place a machine is allowed to touch the outside world. A transition effect is
the command role (at-most-once), which is exactly where an external write
belongs:

```ts
// a transition effect performs the durable write, then reports the outcome
SAVE: {
  do: (ctx) => { ctx.phase = 'saving' },
  effect: async (ctx): Promise<Events> => {
    const res = await commitRow(ctx.id, ctx.draft, ctx.version)   // DB UPDATE with version check
    return res.ok
      ? { type: 'SAVED', version: res.version }
      : { type: 'CONFLICT', latest: res.value }
  },
},
```

Read-in-load, write-in-command: the `entry` effect fetches, the transition
`effect` persists. That pairing keeps machines pure of I/O except at two clearly
marked seams.

## The checklist

**Belongs in context** (reactive, bounded, re-renders):

- the current selection, tab, or route-local view state
- a form draft in flight
- a workflow's phase (`idle` / `saving` / `failed`) and its small result
- a *page* of results a view is currently showing

**Belongs in storage** (reference data, unbounded, or heavy):

- user accounts, catalogs, any table you'd call "your data"
- historical or audit records nothing is currently rendering
- file bytes (see [File uploads](/recipes/file-uploads/))

:::tip[The one-line heuristic]
When something big must be referenced from a machine, keep the **id** in context
and the **data** in storage. `ctx.selectedProductId` is working state.
`ctx.selectedProduct` (the whole row) is a dataset leaking into a snapshot.
:::

## In production you'd add

- **A real persistence adapter.** The in-memory store is for development. Point
  the framework at Redis (or your adapter) so snapshots survive restarts —
  another reason to keep them small.
- **Indexes on your reference tables.** A guard or selector that reads storage
  runs on the request path. An unindexed `LIKE` scan on every keystroke is its
  own cliff.
- **Snapshot migrations** if a machine's context shape changes between deploys —
  old persisted snapshots hydrating into a new shape is undefined without a
  `migrate` step.
