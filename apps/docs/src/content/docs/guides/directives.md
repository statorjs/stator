---
title: Directives
description: "Colon-namespaced directives: on:, class:list, style:list, bind:, ref:, and is:inline."
sidebar:
  order: 2
---

Directives are colon-namespaced attributes (`name:arg`) the compiler lowers to runtime calls. Each one owns its whole attribute.

## on: — events

The handler must be a single `machine.send(...)`:

```astro
<button on:click={() => cart.send({ type: 'ADD_ITEM', productId: id })}>Add</button>
```

## class:list — reactive classes

Strings, conditional records, or `read()` entries compose into one class attribute:

```astro
<button class:list={{ 'btn': true, 'in-cart': read(cart, c => c.contains(id)) }}>
```

## style:list — reactive styles

Same model for inline styles:

```astro
<div style:list={{ color: read(theme, t => t.fg) }}>
```

## bind: — DOM ↔ state

One-way (`bind:text`, `bind:html`, `bind:disabled`) and two-way (`bind:value`, `bind:checked`, client-only) bindings. Full treatment in [Forms and binding](/guides/forms-and-binding/):

```astro
<span bind:text={theme.label}></span>
<input bind:value={draft.name} />
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
