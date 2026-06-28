---
title: Composition
description: "Machines compose via reads and subscribes/emits; components compose via children."
sidebar:
  order: 6
---

Stator composes at two levels: **machines** compose into a state graph, and **components** compose into a UI tree. They're separate mechanisms with separate jobs.

## Two wiring axes

Machines relate to each other in exactly two ways — one synchronous, one reactive.

### reads:

`reads:` is a synchronous pull. A machine declares the machines it depends on, and inside its transitions it can read their current state:

```ts
reads: [ProductsMachine],
// inside a transition:
do: (ctx, ev, { reads }) => {
  const product = reads.ProductsMachine.byId(ev.productId)
  if (product) ctx.items.push({ productId: ev.productId, unitPrice: product.price, quantity: 1 })
},
```

`reads.ProductsMachine` is typed from the declared tuple, with the read machine's selectors preserved. Reads resolve server-side — which is why a machine that reads another is [server-pinned](/concepts/state-machines/#capabilities).

### subscribes / emits

`emits` lets a machine announce a fact; `subscribes` lets another machine react to it. The emitting machine names domain facts and attaches a payload selector:

```ts
emits: { ITEM_ADDED: { payload: cartSnapshot } },
```

```ts
subscribes: [
  { from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' },
],
```

Where `reads` is "I need your state right now," `subscribes`/`emits` is "tell me when this happened." The payload selector runs after the emitting transition commits, so subscribers see post-transition state.

## app vs session machines

A machine's [lifecycle](/concepts/state-machines/#lifecycle-is-not-placement) shapes how it composes:

- **session→app** delivery works (an admin/app machine can subscribe to a session machine's emits; the runtime injects the originating `sourceSessionId`).
- **app→app** is wired at app boot.

:::caution[1.x]
**app→session** delivery — a process-lifetime machine pushing to a specific session — needs the durable inbox and is deferred to [1.x](/introduction/why-stator/#the-10--1x-boundary). On a single replica, app-state *display* updates still reach connected sessions via [SSE fan-out](/guides/realtime-sse/), because that recomputes reads rather than delivering a targeted event.
:::

## Component invocation

In a template, a **capitalized** tag invokes a Stator component; a lowercase tag is a plain HTML element:

```astro
<CartPage cart={cart} products={products} />   <!-- component -->
<section class="cart"> … </section>            <!-- HTML element -->
```

Components receive machines and data as props via `Stator.props<...>()`, and the children render eagerly at the call site.

## Named children

A component declares slots for content with `<children>`, and callers target them with `child="..."`:

```astro
<!-- in BaseLayout.stator -->
<header><children name="header" /></header>
<main><children /></main>
```

```astro
<!-- a caller -->
<BaseLayout>
  <nav child="header"> … </nav>   <!-- fills the "header" slot -->
  <p>Goes to the default slot.</p>
</BaseLayout>
```

Note this is `<children>` + `child="..."`, **not** the Web Components `<slot>` element — it's a compile-time composition feature, resolved in a single eager render pass, with no shadow DOM involved. The compiler validates that a `child="x"` marker matches a declared `<children name="x" />`.

## .stator route pages

A route page is the same composition model with a frontmatter that uses `Stator.reads([...])` instead of `Stator.props`. It pulls the machines it needs and composes layout and page components in its body — see [Routing](/guides/routing/). The page *is* a component; "route" just means "discovered under `routes/` and given request access."
