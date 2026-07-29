---
title: Dispatching events
description: "Typed, machine-mediated dispatch from templates, API routes, and client islands."
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

- **In a template handler** — `on:click={() => cart.send({ type: 'ADD_ITEM', productId: id })}` (the read instance's `send`). The handler is serialized at render time; the page runtime POSTs the event to `/__events` when it fires.
- **In an [API route](/guides/api-routes/)** — `dispatch(Machine, event)` from the handler's helpers, entirely server-side.
- **In a [client island](/guides/client-components/#committing-to-the-server)** — `dispatch(Machine, event)` from `@statorjs/stator/client` crosses the wire to the server machine. Details below.

## Cross-machine fan-out

A dispatch records every touched machine. Subscribers ([`subscribes`/`emits`](/concepts/composition/#subscribes--emits)) react, their machines are persisted, and on a live route the changes fan out to connected sessions.

## How patches come back

The dispatch triggers a [recompute](/concepts/reactivity-and-reads/#recompute-and-diff); the response is a [patch list](/concepts/rendering-and-patches/) targeting only the changed slots.

## Client dispatch

From a client island, dispatch to a server machine over the same `/__events` wire:

```ts
import { dispatch } from '@statorjs/stator/client'

const result = await dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
if (result.committed) {
  // the transition actually happened
}
```

A server machine imported in client code collapses to an identity stub (`{ name }`) in the browser bundle — the event types travel, the machine's body never does.

`dispatch` resolves — it never throws — with a `DispatchResult` reporting three separate facts:

- **`ok`** — the POST reached the server and returned 200.
- **`committed`** — the event committed a transition. `ok && !committed` means a guard dropped it, and the UI should not pretend something happened.
- **`patchCount`** — patches applied to *this* page. A committed event may patch zero slots here if the machines it touched aren't bound on the current route.
- **`error`** — present only when `ok` is false: `{ phase: 'network' | 'timeout' | 'http', status? }`.

## Failure and retry semantics

Every event POST carries an `eventId`. Network and timeout failures retry with backoff under the same id, and the server's replay cache makes a duplicate that did arrive safe to re-send — so a flaky connection can't apply an event twice. Non-2xx responses are terminal immediately: the server saw the event and answered.

When a failure is final, a `stator:dispatch-error` CustomEvent fires on `window`, so one listener can own the "something didn't go through" UI for the whole page. Template `on:` handlers post through the same transport, so this contract holds for them too.
