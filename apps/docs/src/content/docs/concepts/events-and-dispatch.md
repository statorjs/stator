---
title: Events and dispatch
description: "The write half of the loop: how a click becomes a typed event, what commit means, and what the wire guarantees."
sidebar:
  order: 4
---

[Reads](/concepts/reactivity-and-reads/) are half the loop: they declare what the page shows. This page is the other half — how anything *changes*. In Stator there is exactly one answer: **send a typed event to a machine**. No setters, no mutations from the template, no REST endpoints for state. The event is the API.

## The event is the API

A machine declares its event union up front, and every sender — a template handler, a client island, an API route — sends into that union:

```ts
events: {} as
  | { type: 'ADD_ITEM'; productId: string }
  | { type: 'CLEAR' }
```

Dispatch is **machine-mediated**: you address a machine by its imported definition, and the event type-checks against that machine's declared union at the call site. There is no URL to construct, no string channel to keep in sync, no payload shape to remember — a wrong `type` or a missing field is a compile error, on both sides of the wire.

If you're coming from a SPA + API architecture, this replaces two layers at once: the client-side action/mutation layer *and* the endpoint it calls. There is one vocabulary — the machine's events — and it is owned by the machine, not by the transport.

## From click to commit

The whole path, for a template handler like `on:click={() => cart.send({ type: 'ADD_ITEM', productId: product.id })}`:

1. **At render**, the handler is serialized into `data-event-*` attributes on the element. It is not browser code — the payload closes over render-scope values (this row's `product.id`), and the browser never runs your frontmatter.
2. **On click**, the page runtime reads those attributes and POSTs the event descriptor to `/__events`, carrying the session cookie and the current route.
3. **On the server**, the session's machines are [restored from the store](/concepts/sessions-and-state/), the transition runs — guard first, then the action against a draft — and commits.
4. **Recompute** diffs the route's registered bindings and the response returns a [patch list](/concepts/rendering-and-patches/) for exactly the slots whose values changed.
5. **The runtime applies the patches.** There is no client-side re-render step — the DOM positions were already known.

An interaction costs one round trip carrying a small JSON body each way. While the POST is in flight, the dispatching element carries [`data-stator-pending`](/reference/client/#runtime-signals) — a CSS hook the runtime owns, so "loading" state is never a flag in your machine.

## Commit is a fact, not a hope

The server is where guards live, so the server's answer — not the click — is what happened. A dispatch reports three separate facts:

- **ok** — the POST reached the server.
- **committed** — the event actually committed a transition. A guard dropping an event is a *normal outcome*, not an error: `ok && !committed` means the machine declined, and the UI shouldn't pretend otherwise.
- **patchCount** — what changed on *this* page. A committed event can legitimately patch zero slots here (the machines it touched aren't bound on this route) — the state still changed, and live routes elsewhere still see it.

This is also why there is no optimistic-update layer: a button that announces success before `committed` is guessing at a guard's decision. The [latency question](/introduction/why-stator/#the-latency-question) covers what Stator does instead — and when the honest answer is "this state belongs in a [client island](/guides/client-components/)".

## What the wire guarantees

Every event POST carries a unique `eventId`. Network and timeout failures retry with backoff **under the same id**, and the server's replay cache answers a duplicate with the original response instead of re-applying it — so a flaky connection can retry safely without double-committing (keyed-list patches are not idempotent; the replay cache is what makes retries sound). A non-2xx response is terminal immediately: the server saw the event and answered. A 10-second deadline turns a dead connection into an explicit failure instead of a hang, and every final failure fires a `stator:dispatch-error` window event one listener can own.

Concurrent events to the same session are **serialized** — a per-session lock means transitions never interleave, which is why actions can be plain mutations with no CAS or version checks.

## Three faces, one primitive

- **Template handlers** — `instance.send(event)` on a read instance, serialized at render (above). The default for pages.
- **Client islands** — `dispatch(Machine, event)` from `@statorjs/stator/client`. The imported server machine collapses to a `{ name }` stub in the bundle; the event types travel, the machine's body never does. Returns the `ok`/`committed`/`patchCount` result explicitly.
- **Server code** — `dispatch(Machine, event)` in an [API route](/guides/api-routes/), and [`dispatchToApp`](/guides/app-machines/) for server-originated events (webhooks, cron) with no session attached.

Same addressing, same typing, same commit semantics — the sender's location is the only difference. The [dispatching guide](/guides/dispatching-events/) covers each in detail.

## Where typing lives

One deliberate boundary: **keystrokes are not events.** Putting the network in the typing loop would be absurd, so a draft belongs to the input element itself — uncontrolled, guarded by platform constraints (see [Forms and inputs](/guides/forms-and-inputs/)). What crosses to a server machine is the *committed fact*: a typed event sent on change or submit, or a native form POST handled by an [API route](/guides/api-routes/) that dispatches. A template handler's payload is fixed at render time — it can carry this row's product id, never "whatever the input says now" — which is the compiler enforcing the same boundary.

## Where to go next

- [Dispatching events](/guides/dispatching-events/) — each dispatch surface, with the failure contract.
- [Forms and inputs](/guides/forms-and-inputs/) — the draft, validation, commit timing.
- [Rendering and patches](/concepts/rendering-and-patches/) — what happens to the response.
