---
title: Dispatching events
description: "Typed, machine-mediated dispatch from the server and (via 3b) the client."
sidebar:
  order: 8
---

Dispatch is how state changes. You address a machine by its imported definition and send a typed event — no magic strings.

## Typed, no magic strings

```ts
dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

The event is checked against the machine's declared union (`EventOf<typeof CartMachine>`). A wrong `type` or a missing field is a compile error.

## Where dispatch happens

- **In a template handler** — `on:click={() => cart.send({ type: 'ADD_ITEM', productId: id })}` (the read instance's `send`).
- **In an [API route](/guides/api-routes/)** — `dispatch(Machine, event)` from the handler's helpers.

Both run server-side today.

## Cross-machine fan-out

A dispatch records every touched machine. Subscribers ([`subscribes`/`emits`](/concepts/composition/#subscribes--emits)) react, their machines are persisted, and on a live route the changes fan out to connected sessions.

## How patches come back

The dispatch triggers a [recompute](/concepts/reactivity-and-reads/#recompute-and-diff); the response is a [patch list](/concepts/rendering-and-patches/) targeting only the changed slots.

## Client dispatch

From a client island, dispatch to a server machine over `/__events`:

```js
dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

:::caution[Phase 3b]
Client-to-server dispatch is partly behind the in-progress client plane (it needs the import-stubbing that strips a server machine's body from the browser bundle while keeping its name and event types). Islands using only portable client machines work today.
:::
