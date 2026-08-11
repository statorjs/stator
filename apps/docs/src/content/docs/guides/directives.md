---
title: Directives
description: "Colon-namespaced directives: on:, class:list, style:list, ref:, and is:inline."
sidebar:
  order: 2
---

Directives are colon-namespaced attributes (`name:arg`) the compiler lowers to runtime calls. Each one owns its whole attribute. Display is not a directive — `read()` is an expression, in text or attribute position, on server and client machines alike. Input capture is not a directive either: the control owns its draft, and a typed commit event crosses the boundary at `change`/`submit` — see [Forms and inputs](/guides/forms-and-inputs/).

## on: — events

The handler must be a single `machine.send(...)`:

```astro
<button on:click={() => cart.send({ type: 'ADD_ITEM', productId: id })}>Add</button>
```

## class:list

Strings, conditional records, or `read()` entries compose into one class attribute:

```astro
<button class:list={{ 'btn': true, 'in-cart': read(cart, c => c.contains(id)) }}>
```

## style:list — reactive styles

Same model for inline styles:

```astro
<div style:list={{ color: read(theme, t => t.fg) }}>
```

## ref: — element handles

`ref:name` marks an element; it surfaces as `this.refs.name` in a [client component](/guides/client-components/). Takes no value:

```astro
<canvas ref:chart></canvas>
```

## Literal scripts: is:inline / src

An inline `<script>` is a [client component](/concepts/the-stator-file/#the-script-region). To emit a literal script instead, mark it:

```astro
<script is:inline>document.documentElement.dataset.theme = 'dark'</script>
<script src="/static/analytics.js"></script>
```

:::caution
A bare inline `<script>` with no exported `StatorElement` is a **compile error**, not a silently-dropped tag. Use `is:inline` or `src` for literal scripts.
:::
