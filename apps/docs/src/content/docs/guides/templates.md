---
title: Writing templates
description: "The JSX-flavored body: text, reads, and the when/each/match control-flow callbacks."
sidebar:
  order: 1
---

A template body is JSX-flavored markup. This page covers the body itself; [directives](/guides/directives/) (`on:`, `ref:`, `class:list`) have their own page.

## Static text vs reactive state

Plain `{expr}` renders once and is auto-escaped. `read(machine, selector)` creates a live [binding](/concepts/reactivity-and-reads/):

```astro
<h3>{product.name}</h3>                  <!-- static -->
<p>Total: {read(cart, c => c.total)}</p> <!-- updates when the cart changes -->
```

`read()` is only valid in **text** or as a **whole** attribute value. Mixing literal text with a `read()` in one attribute is a compile error — wrap the whole value in the selector instead.

Attribute bindings understand **boolean semantics**: a selector returning `false`/`null`/`undefined` renders the attribute *absent* (and a change patches it away with `removeAttribute`); `true` renders it present-and-empty. That's how presence-toggled attributes work end to end:

```astro
<button disabled={read(cart, (c) => c.count === 0)}>Begin checkout</button>
```

One platform caveat that is also the design: `checked`, `value`, and `selected` as *attributes* set defaults only — a form control the user has touched ignores them. That is precisely what pre-fill wants (state provides the start, the visitor owns the draft), and commits flow back as typed events. See [Forms and inputs](/guides/forms-and-binding/).

## Conditionals: when and match

Both are callbacks, not components, so a branch's body isn't evaluated unless it's chosen.

```astro
{when(read(cart, c => c.isEmpty), () =>
  <p>Your cart is empty.</p>
)}

{match(read(order, o => o.status), {
  pending: () => <span>Pending</span>,
  shipped: () => <span>Shipped</span>,
})}
```

Use `when` for one condition, `match` to pick one of several by value.

## Loops: each

```astro
<ul>
  {each(read(cart, c => c.items), (item, i) =>
    <li>{item.quantity} × ${item.unitPrice.toFixed(2)}</li>
  )}
</ul>
```

:::note
By default a changed list re-renders its body. Pass a `key` —
`each(items, fn, { key: (i) => i.id })` — and changes become per-item
insert/remove/move patches instead, so rows keep focus and transitions across
reorders. See [Keyed lists](/guides/keyed-lists/).
:::

## Async data: defer

Frontmatter renders synchronously — an `await db.query()` has no home there. `defer()` is where request-scoped async data goes: pass a thunk and arms, and the framework runs the thunk in parallel with every other `defer` on the page, then renders the matching arm inline in the complete HTML response:

```astro
{defer(() => db.getProduct(id), {
  ready: (product) => <ProductView product={product} />,
  error: () => <NotFound />,
})}
```

A `defer` region is **one-shot**: it renders once per page load and never re-diffs, and the thunk is never re-run by later events on the page. Data that must change after first render belongs in a machine instead — [Defer vs. machine](/recipes/defer-vs-machine/) is the decision guide. The `error` arm is optional; without it, a rejection bubbles to route-level error handling.

## Trusted HTML with raw()

`raw()` emits a string verbatim, bypassing escaping. Pass only markup you constructed or trust:

```astro
import { raw } from '@statorjs/stator/template'
<div>{raw(sanitizedHtml)}</div>
```

## Structured data with `<JsonLd>`

For a schema.org block, use the typed component rather than a hand-written `<script>`:

```astro
import { JsonLd } from '@statorjs/stator/components'
<JsonLd json={{ "@type": "Product", name: "Pocket Notebook" }} />
```

## Composing components

A capitalized tag invokes a component; lowercase is HTML. Pass machines and data as props:

```astro
<ProductList products={products} cart={cart} />
```

Layouts and named children (`<children>`) are covered in [Routing](/guides/routing/#layouts-via-composition).
