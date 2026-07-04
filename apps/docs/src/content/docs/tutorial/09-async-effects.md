---
title: 9. Checkout with async effects
description: "Call a payment API from a transition — the pending-state pattern that keeps machines pure."
sidebar:
  order: 9
---

Desksmith can fill a cart but never take money. Time to fix that — and learn
the one pattern Stator uses for *all* async work: **pending state now,
completion event later**.

## The problem effects solve

Actions are synchronous by contract: they compute the next state. A payment
call takes hundreds of milliseconds against someone else's server — it can't
live inside an action, and you wouldn't want the user's POST (or the session
lock) held open while it runs.

So a transition that needs I/O splits into three declared pieces: the state
you enter *immediately*, the async work, and the events that resolve it.

## The checkout machine

Create `machines/checkout.ts`:

```ts
import { defineMachine } from '@statorjs/stator/server'
import { chargeCard } from '../lib/payments.ts'

type Events =
  | { type: 'SUBMIT'; token: string }
  | { type: 'CHARGE_OK'; receipt: string }
  | { type: 'CHARGE_FAILED'; reason: string }
  | { type: 'TRY_AGAIN' }

export default defineMachine({
  name: 'CheckoutMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { receipt: '', error: '' },
  initial: 'reviewing',
  states: {
    reviewing: {
      on: {
        SUBMIT: {
          to: 'submitting',
          effect: async (_ctx, ev, meta): Promise<Events | null> => {
            try {
              const res = await chargeCard(ev.token, meta.effectId)
              return { type: 'CHARGE_OK', receipt: res.receipt }
            } catch {
              return { type: 'CHARGE_FAILED', reason: 'card declined' }
            }
          },
        },
      },
    },
    submitting: {
      on: {
        CHARGE_OK: {
          to: 'confirmed',
          do: (ctx, ev) => {
            ctx.receipt = ev.receipt
          },
        },
        CHARGE_FAILED: {
          to: 'reviewing',
          do: (ctx, ev) => {
            ctx.error = ev.reason
          },
        },
      },
    },
    confirmed: {
      on: { TRY_AGAIN: { to: 'reviewing' } },
    },
  },
  selectors: {
    phase: (ctx) => (ctx.receipt ? 'confirmed' : ctx.error ? 'error' : 'ready'),
    receipt: (ctx) => ctx.receipt,
    error: (ctx) => ctx.error,
  },
})
```

Read the `reviewing → submitting → confirmed` path out loud — it *is* the
business process. That legibility is why the pending state is mandatory
rather than optional ceremony: every state the user can observe is a state
you declared.

## What happens on SUBMIT, step by step

1. The POST arrives; `SUBMIT` commits `submitting` **synchronously**. The
   response carries patches for that — your page shows "processing…" right
   away.
2. The effect runs *after* the response, with commit-time snapshots of `ctx`
   and `ev`. Nothing is blocked: the session lock is free, other events flow.
3. The returned event (`CHARGE_OK` or `CHARGE_FAILED`) dispatches like any
   other event. State persists; a [live route](/tutorial/08-going-live-sse/)
   sees it over SSE, a plain page shows it on the next request.

Three details worth internalizing:

- **The `: Promise<Events | null>` annotation is required.** TypeScript
  defers inference for arrows inside `defineMachine`, so you annotate — and
  in exchange, returning an event type the machine doesn't declare is a
  compile error.
- **Effects never throw outward.** Catch inside, return your failure event.
  (A throw is logged and dropped — a backstop, not a plan.)
- **`meta.effectId`** is unique per invocation. Pass it to the payment API as
  an idempotency key — when 1.x adds retries, your handler is already safe.

## Rendering the phases

`match` on the phase selector in your checkout page:

```
{match(read(checkout, (c) => c.phase), {
  ready: () => <button on:click={() => checkout.send({ type: 'SUBMIT', token: 'tok_demo' })}>
    Place order
  </button>,
  confirmed: () => <p class="receipt">Order placed — {read(checkout, (c) => c.receipt)}</p>,
  error: () => <p class="error">{read(checkout, (c) => c.error)} — try again?</p>,
})}
```

No spinner state machine in the client, no `isLoading` flag to forget: the
machine's states *are* the UI's states.

## What you built · where to go

That completes Desksmith — and the tour: typed machines for catalog, cart,
and checkout; server rendering with slot patches; layouts via `<children>`;
a client-only theme toggle; Redis persistence; live cross-session updates;
and async I/O that never leaks into your state logic.

- [Core Concepts](/concepts/state-machines/) — the "why it works this way"
  behind each piece.
- [Guides](/guides/templates/) — task-focused pages, including
  [effects](/guides/effects/) in more depth, [keyed lists](/guides/keyed-lists/),
  [app machines](/guides/app-machines/), and
  [shipping to production](/guides/production/).
- [API Reference](/reference/overview/) — every stable export.
