---
title: State machines
description: "How Stator machines work: context, events, transitions, selectors, and capabilities."
sidebar:
  order: 1
---

A machine is the unit of state in Stator. This page explains what's inside one and why the model is shaped the way it is. For building one step by step, see the [tutorial](/tutorial/02-your-first-machine/).

## Machines are the canonical state

Most frameworks treat "state machines" as a library you reach into from inside a component tree. Stator inverts that: the machine *is* the canonical state, and everything else — templates, the DOM, the wire — derives from it. There is no second copy of a fact to keep in sync. This inversion is what makes the rest of the framework's guarantees possible: if the machine is the only source of truth, the server can always compute exactly what a change affects.

## defineMachine anatomy

`defineMachine` takes a single config object and returns a definition. The definition is a value you import where you use it — its presence in a `.stator` frontmatter or `<script>` is what decides where it runs.

```ts
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  events: {} as CartEvents,
  context: { items: [] },
  initial: 'idle',
  states: { idle: { on: { /* … */ } } },
  selectors: { /* … */ },
})
```

The whole shape is declarative and statically analyzable — there's no imperative setup step, which is what lets the compiler reason about a machine and the engine serialize it.

### context

`context` is the machine's data — its initial value defines the shape. Each actor gets its own clone; transitions mutate a draft, and the engine clones-and-commits so you write plain mutations without sharing state between actors.

### states + initial

`states` is the state graph and `initial` names the entry state. In 1.0 the state path is **flat** (depth-1): a machine is in exactly one named state, and transitions move between them.

:::note[Extension point]
Nested and parallel statecharts (and history/invoke) are not in 1.0. The state model is deliberately built so they can layer in later without changing the surface — flat today, extensible tomorrow.
:::

## Typed events and transitions

You declare a machine's event surface as a discriminated union and hand it over as a phantom value:

```ts
type CartEvents =
  | { type: 'ADD_ITEM'; productId: string }
  | { type: 'CLEAR' }

// in the config:
events: {} as CartEvents,
```

The engine only reads its *type*; `{} as CartEvents` carries no runtime data. From there, every transition narrows per event:

```ts
on: {
  ADD_ITEM: [
    {
      when: (ctx, ev) => !ctx.items.some((i) => i.productId === ev.productId),
      do: (ctx, ev) => { ctx.items.push(/* … */) },
      emit: 'ITEM_ADDED',
    },
    { do: (ctx, ev) => { /* bump quantity */ }, emit: 'ITEM_QUANTITY_CHANGED' },
  ],
}
```

- **Actions (`do`)** mutate a draft of `context`. The engine owns the clone and the commit.
- **Guards (`when`)** make a transition a list of ordered candidates — the **first** whose `when` passes wins (a candidate with no `when` always matches, so it's the default tail).
- **Emits** fire *after* the action commits, so a payload selector sees the post-transition context. Emits are how one machine announces a fact for others to react to — see [Composition](/concepts/composition/).

## Selectors

`selectors` are pure derived views over `context`. They're the read surface: templates call `read(machine, sel)` and client components `bind:` against them. A selector that takes an argument returns a function (`contains: (ctx) => (id) => …`). Because selectors are pure functions of context, the same selector runs identically on the server and in a client island — one definition, both sides of the boundary.

## Capabilities

Some machines can only run on the server. A machine that **reads** another machine is **server-pinned**, because cross-machine reads resolve server-side; a machine with no such dependency is **portable** and can run in a client island. The classification is computed from the definition (`computeCapabilities` in `engine/define-machine.ts`) and carries the *reasons*, so when you place a server-pinned machine on the client, the [compile error](/concepts/server-client-boundary/#the-enforcing-compile-errors) can name exactly why.

:::note[1.x]
Secret access and cross-session emit are intended future inputs to capability classification; 1.0 keys off cross-machine reads. The mechanism is in place; the additional inputs are deferred.
:::

## Lifecycle is not placement

`lifecycle: 'app' | 'session'` answers *how long an instance lives* — one per process, or one per visitor. It does **not** decide where the machine runs; that's import location. A session machine is still a server machine. Keeping these two axes separate is deliberate: lifetime is a runtime property, placement is a use-site decision. See [The server/client boundary](/concepts/server-client-boundary/).
