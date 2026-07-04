---
title: Writing templates
description: "The JSX-flavored body: text, reads, and the when/each/match control-flow callbacks."
sidebar:
  order: 1
---

A template body is JSX-flavored markup. This page covers the body itself; [directives](/guides/directives/) (`on:`, `bind:`, `class:list`) have their own page.

## Static text vs reactive state

Plain `{expr}` renders once and is auto-escaped. `read(machine, selector)` creates a live [binding](/concepts/reactivity-and-reads/):

```astro
<h3>{product.name}</h3>                  <!-- static -->
<p>Total: {read(cart, c => c.total)}</p> <!-- updates when the cart changes -->
```

`read()` is only valid in **text** or as a **whole** attribute value. Mixing literal text with a `read()` in one attribute is a compile error — wrap the whole value in the selector instead.

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

Layouts and named slots (`<children>`) are covered in [Routing](/guides/routing/#layouts-via-composition).
