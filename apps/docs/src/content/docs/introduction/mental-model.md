---
title: The mental model
description: "The big idea: canonical state lives in machines, events change it, templates read it, and import location decides where code runs."
sidebar:
  order: 5
---

Everything in Stator follows from four ideas. Hold these and the rest of the framework reads as consequences rather than rules to memorize.

1. State lives in machines.
2. Events are the only way state changes.
3. Templates read state; they never own it.
4. Where code runs is decided by where you import it.

## State lives in machines

A **machine** is the canonical source of truth for a slice of state. It owns a `context` (the data), a set of `states`, and the transitions between them. Nothing else holds an authoritative copy — not the template, not the DOM, not a client store.

Machines have a **lifecycle** that says how long an instance lives:

- `lifecycle: 'session'` — one instance per browser session (a cart, a form, a wizard). Persisted between requests via the [store](/concepts/sessions-and-state/).
- `lifecycle: 'app'` — one instance for the whole server process (a product catalog, feature flags). Shared by every session.

```ts
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  context: { items: [] },
  // states, transitions, selectors…
})
```

### App-machine persistence caveat

:::caution[1.x]
App-lifecycle machines live in process memory and are **not** persisted across restarts in 1.0, and there is no durable server→session delivery yet. Both are part of the deferred [inbox](/introduction/why-stator/#the-10--1x-boundary) work.
:::

## Events are the only way state changes

You never mutate a machine from the outside. You **send it a typed event**, and a transition decides what happens:

```ts
on: {
  ADD_ITEM: { do: (ctx, ev) => { ctx.items.push(/* … */) } },
}
```

Dispatch is **machine-mediated**: you address a machine by its imported definition and send an event from its declared union, so the event is type-checked at the call site. There are no magic strings. See [Dispatching events](/guides/dispatching-events/).

## Templates read; they never own state

A template declares, on each node, which piece of machine state that node shows:

```astro
<h1>Total: {read(cart, c => c.total)}</h1>
```

`read(machine, selector)` registers a **binding**. A bare `{expr}` is a one-shot interpolation that never updates; only `read(...)` produces a live slot. Nothing is auto-tracked — the dependency is exactly what you wrote — which is why the server can update precisely the bound node and nothing else. See [Reactivity and reads](/concepts/reactivity-and-reads/).

## The boundary is import location

A machine definition is **location-agnostic** — the same definition can run on the server in one place and in the browser in another. What decides where it runs is a single, visible thing: **where you import it.**

- Imported in a `.stator` file's **frontmatter** → runs on the **server**.
- Imported in a `.stator` file's **`<script>`** → runs in the **browser** (a [client island](/guides/client-components/)).

There is no `"use client"`, no file coloring, no viral transitivity. The import site *is* the declaration. See [The server/client boundary](/concepts/server-client-boundary/).

### One reactivity model both sides

The server's `read(machine, selector)` and a client island's `bind:` directive are two faces of the same primitive: *declare on a node what state it shows.* You learn one model and apply it on both sides of the boundary.

### Portability is checked, not inferred

Some machines use server-only capabilities (a store, secrets, cross-session emit). Putting such a machine in a client `<script>` is a **compile error** that names the offending capability — placement is your decision, legality is the compiler's.

## A request's lifecycle

When an event arrives, the server runs a short, stateless cycle:

1. **Hydrate** — load only the machines this route reads, from the store.
2. **Apply** — run the event through the relevant machine's transition.
3. **Recompute** — re-evaluate the bindings registered during render and diff them against their last values.
4. **Patch** — send back the minimal target/op patch list for the bindings that changed.
5. **Persist & dispose** — write touched session machines back to the store and tear down the per-request actors.

Actors are created per request and thrown away; canonical state lives in the store between requests. This is what keeps the runtime cheap and the scaling story clean. See [Sessions and state](/concepts/sessions-and-state/).

## Cross-machine composition

Machines compose two ways:

- **`reads:`** — synchronous access to another machine's state (the cart reads the product catalog to price an item).
- **`subscribes:` / `emits`** — one machine reacts to a fact another machine emitted (an admin view denormalizes from the cart's `ITEM_ADDED`).

```ts
reads: [ProductsMachine],
subscribes: [{ from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' }],
```

On a single replica this also powers live cross-session updates over [SSE](/guides/realtime-sse/). Multi-replica fan-out is [1.x](/introduction/why-stator/#the-10--1x-boundary). See [Composition](/concepts/composition/).

## Where to go next

- [Core Concepts](/concepts/state-machines/) — each idea above, in depth.
- [Tutorial](/tutorial/01-setup/) — put the whole model to work building a real app.
