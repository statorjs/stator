---
title: "Fetching data: defer vs a machine"
description: "Two doors for async data. `defer` is the ephemeral, one-shot, per-view door; a machine is the stateful, reactive, shared door. This is how to tell which one you need."
sidebar:
  order: 2
---

Stator gives you two ways to get async data onto a page, and picking the wrong
one is the most common source of early confusion. The good news: the dividing
line is a single question, and it's a permanent one.

## The one rule

> **If the value must change after first render, it's a machine. If it's fetched
> once for this view and then it's done, it's a `defer`.**

Everything else follows from that. `defer` is the *ephemeral, one-shot,
per-request* door — no name, no state chart, no persistence, gone after the
response. A machine is the *stateful, reactive, shared* door — a named entity the
runtime persists and live-updates over SSE.

Frontmatter stays synchronous (that's what keeps live diffing coherent), so
`await` never belongs there. `defer` is where a per-request fetch lives:

```jsx
---
const { id } = Stator.request.params
---
<main>
  {defer(() => db.getProduct(id), {
    ready: (product) => <ProductView product={product} />,
    error: () => <NotFound />,
  })}
</main>
```

The thunk runs *outside* the synchronous render, in parallel with every other
`defer` on the page; the framework awaits them (bounded by the slowest, not the
sum) and renders complete HTML. Already-resolved or synchronous data fills with
no added latency and no placeholder.

## The three-question test

When you're unsure, ask three things about the value:

1. **Liveness** — does it change while the view is open, and do you care?
2. **Identity / sharing** — is it a *thing* the app addresses, mutates, or shares
   across views or sessions?
3. **Persistence** — would keeping the snapshot help anyone (a faster next load,
   shared across users)?

Three **no**s → `defer`. Any **yes** → a machine.

## Reach for `defer` when…

**A content or detail page keyed by a route param.**

```jsx
{defer(() => cms.getArticle(params.slug), {
  ready: (a) => <Article title={a.title} body={a.body} />,
  error: () => <NotFound />,
})}
```

The article doesn't change while you read it; if it did, you'd refresh. Modelling
it as a machine would mean one persisted, named entity *per slug* — which the
lifecycle model can't even express — to hold immutable copy.

**Search or a query result set for this request.**

```jsx
{defer(() => catalog.search(query.q, query.page), {
  ready: (hits) => <Results hits={hits} />,
})}
```

Results are for *this* query. You don't live-update them, you re-search.

**Read-only third-party enrichment.**

```jsx
{defer(() => shipping.estimate(zip, weight), { ready: (e) => <Estimate {...e} /> })}
```

A shipping quote, an FX rate at page load, weather for a shown location. Read-only,
view-scoped, nothing to own or keep.

**An immutable artifact — like an order receipt.**

```jsx
{defer(() => orders.get(params.orderId), { ready: (o) => <Receipt order={o} /> })}
```

Fixed the moment it exists. Note the pairing: the *cart* is a machine (it
mutates); the *receipt* is a `defer` (it never will).

## It's a machine when…

Cart, live catalog or inventory, presence, notifications, chat — anything
collaborative, anything that mutates, anything another actor changes out of band.
A machine models the loading delay as a *state* and delivers both the load and
every later update through one binding:

```jsx
---
const [catalog] = Stator.reads([Catalog])
export const live = true            // SSE — required for live updates
---
{match(read(catalog, s => s.status), {
  loading: () => <GridSkeleton />,  // the delay, as a state
  ready:   () => <Grid products={read(catalog, s => s.products)} />,  // live
  error:   () => <RetryNotice />,
})}
```

The initial fetch runs in the machine's entry effect; when it resolves, SSE swaps
the skeleton for the grid, and every subsequent change patches the same slot. For
a value that must live-update, this is strictly better than `defer` — it paints
instantly and streams, where `defer` would block first paint and still not update.

## They compose as siblings, not by nesting

A page often needs both: a **static** product description (`defer`) next to a
**live** inventory badge (a machine). Write the live read as a *sibling* of the
`defer` slot — never inside its arm:

```jsx
<div class="card">
  {/* live: patches as the catalog updates */}
  <span class="qty">{read(catalog, s => s.inventory[id])}</span>

  {/* static one-shot: this product's heavy CMS detail, fetched for this view */}
  {defer(() => cms.getProductDetail(id), {
    ready: (d) => <><h3>{d.name}</h3><p>{d.description}</p></>,
  })}
</div>
```

## The error you'll hit if you cross the streams

A machine read — `read()`, or a machine-bound `each` / `when` / `match` — placed
**inside** a `defer` arm is a compile error:

```
a machine read cannot appear inside a defer() arm — defer is one-shot and
static, so the value would never update. For a live value, use a machine and
place the read in a sibling slot outside the defer.
```

This is deliberate, and it's caught at build time (and as you type, in the
editor). A `defer` slot is never re-diffed — that's what keeps its I/O off the
session lock — so a live binding inside one could never update. The error points
you at the fix: move the read to a sibling slot, or, if it's genuinely reactive,
model it as a machine.

Note this is only about *machine* reads. Iterating the resolved value itself —
`orders.map(...)`, or `each`/`when` over a plain array `defer` returned — is fine;
that data is static too.

## A tricky case: a cart backed by an external system

What about a per-user cart whose source of truth is a third-party commerce API,
which you fetch on load *and* which changes out of band (a promo applies, a
reservation expires)? The out-of-band updates are the tell — it's a **session
machine**, not a `defer`. The external API is just where the machine's `entry`
effect fetches from; a state timeout (`after`) reconciles on a cadence:

```ts
states: {
  loading: {
    entry: async () => ({ type: 'LOADED', cart: await commerce.getCart() }),
    on: { LOADED: { to: 'ready', do: (c, e) => { c.items = e.cart.items } } },
  },
  ready: {
    after: [{ delay: 15_000, send: { type: 'SYNC' } }],   // pick up out-of-band changes
    on: { SYNC: { to: 'syncing' } },
  },
  syncing: { entry: async () => ({ type: 'LOADED', cart: await commerce.getCart() }), on: { /* … */ } },
}
```

`defer` would be right for this cart only if it were a one-shot immutable snapshot
— which is exactly what an order receipt is, and a cart is not.
