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

A machine an island imports only to dispatch to collapses to an identity stub (`{ name }`) in the browser bundle — the event types travel, the machine's body never does. (A machine the island passes to `use()` is the other case: it [runs in the browser](/concepts/server-client-boundary/#running-a-machine-or-addressing-one).)

`dispatch` resolves — it never throws — with a `DispatchResult` reporting three separate facts:

- **`ok`** — the POST reached the server and returned 200.
- **`committed`** — the event committed a transition. `ok && !committed` means a guard dropped it, and the UI should not pretend something happened.
- **`patchCount`** — patches applied to *this* page. A committed event may patch zero slots here if the machines it touched aren't bound on the current route.
- **`error`** — present only when `ok` is false: `{ phase: 'network' | 'timeout' | 'http', status? }`.

## What a page may send

`/__events` accepts an event only when the page it names **offers** it: some template or island that page can render sends that event type. The list is read from your source, not from what a visitor happens to see. A button inside an inactive `when` arm, a `defer` section or a row that isn't rendered yet still counts, so a slow click is never refused for arriving late.

What the rule excludes is what no UI sends. An effect's completion (`CHARGE_OK`), an `after:` timer's event, an event only another machine raises: none appears in a template, so a browser that posts one gets a **403**. That holds without any declaration from you.

Three things to know:

- **Write event types as literals.** The list is built from `{ type: 'ADD' }` in `machine.send(…)` and `dispatch(Machine, …)`. A type computed at runtime can't be listed, so a page that has one stays open, accepting every event its machines handle. `stator check` warns and names the line; branch to one send per type to close it.
- **It is per page.** An event the product page sends is refused when posted under the cart page's route. A test that posts to `/__events` has to name a page that offers the event.
- **It is not authorization.** The list is by event type and the same for every visitor: an admin-only button puts its event on the page's list for everyone. Whether *this* visitor may commit it is still the machine guard's decision.

`events: { gate: 'warn' }` in `stator.config.ts` logs what would be refused and lets it through, for rolling the rule onto an existing app; `'off'` disables it.

## Failure and retry semantics

Every event POST carries an `eventId`. Network and timeout failures retry with backoff under the same id, and the server's replay cache makes a duplicate that did arrive safe to re-send — so a flaky connection can't apply an event twice. Non-2xx responses are terminal immediately: the server saw the event and answered.

When a failure is final, a `stator:dispatch-error` CustomEvent fires on `window`, so one listener can own the "something didn't go through" UI for the whole page. Template `on:` handlers post through the same transport, so this contract holds for them too.
