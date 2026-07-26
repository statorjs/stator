---
title: 9. Checkout with async effects
description: "Call a payment API from a transition — the pending-state pattern that keeps machines pure, and the after-timer that bounds it."
sidebar:
  order: 9
---

Desksmith's checkout can walk shipping and payment but never takes money —
`SUBMIT_PAYMENT` just stamps an order number synchronously. Time to fix that,
and learn the one pattern Stator uses for *all* async work: **pending state
now, completion event later** — plus the timer that keeps a pending state
from becoming a trap.

## The problem effects solve

Actions are synchronous by contract: they compute the next state. A payment
call takes hundreds of milliseconds against someone else's server — it can't
live inside an action, and you wouldn't want the user's POST (or the session
lock) held open while it runs.

So a transition that needs I/O splits into three declared pieces: the state
you enter *immediately*, the async work, and the events that resolve it.

## From synchronous to pending

First, a demo processor in `lib/payments.ts` (deterministic by card suffix,
so every path below is walkable from the UI):

```ts
export async function chargeCard(
  last4: string,
  idempotencyKey: string,
): Promise<{ receipt: string }> {
  if (last4 === '9999') return new Promise(() => {}) // never answers
  await new Promise((resolve) => setTimeout(resolve, 600))
  if (last4 === '0000') throw new Error('card declined')
  return { receipt: `ORD-${idempotencyKey.slice(0, 6).toUpperCase()}` }
}
```

Then `SUBMIT_PAYMENT` stops jumping straight to `complete`. It enters a new
`placing` state and declares the charge as its effect:

```ts
SUBMIT_PAYMENT: {
  to: 'placing',
  when: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
  do: (ctx) => {
    ctx.error = ''
  },
  effect: async (ctx, _ev, meta): Promise<CheckoutEvents | null> => {
    try {
      const res = await chargeCard(ctx.paymentLast4, meta.effectId)
      return { type: 'CHARGE_OK', receipt: res.receipt }
    } catch {
      return { type: 'CHARGE_FAILED', reason: 'card declined' }
    }
  },
},
```

And `placing` declares how each future resolves it:

```ts
placing: {
  after: [{ delay: 8_000, send: { type: 'CHARGE_TIMEOUT' } }],
  on: {
    CHARGE_OK: {
      to: 'complete',
      do: (ctx, ev) => {
        ctx.orderNumber = ev.receipt
      },
      emit: 'ORDER_PLACED',
    },
    CHARGE_FAILED: {
      to: 'payment',
      do: (ctx, ev) => {
        ctx.error = ev.reason
      },
    },
    CHARGE_TIMEOUT: {
      to: 'payment',
      do: (ctx) => {
        ctx.error = 'the payment processor never answered — nothing was charged'
      },
    },
  },
},
```

Read the `payment → placing → complete` path out loud — it *is* the business
process. That legibility is why the pending state is mandatory rather than
optional ceremony: every state the user can observe is a state you declared.

## What happens on SUBMIT_PAYMENT, step by step

1. The POST arrives; the transition commits `placing` **synchronously**. The
   response carries patches for that — your page shows the placing step right
   away.
2. The effect runs *after* the response, with commit-time snapshots of `ctx`
   and `ev`. Nothing is blocked: the session lock is free, other events flow.
3. The returned event (`CHARGE_OK` or `CHARGE_FAILED`) dispatches like any
   other event. State persists; a [live route](/tutorial/08-going-live-sse/)
   sees it over SSE, a plain page shows it on the next request. Add the
   `// @stator live` pragma to `routes/checkout.stator` — an async flow whose
   resolution the user has to refresh for is not much of a flow.

Three details worth internalizing:

- **The `: Promise<CheckoutEvents | null>` annotation is required.**
  TypeScript defers inference for arrows inside `defineMachine`, so you
  annotate — and in exchange, returning an event type the machine doesn't
  declare is a compile error.
- **Effects never throw outward.** Catch inside, return your failure event.
  (A throw is logged and dropped — a backstop, not a plan.)
- **`meta.effectId`** is unique per logical invocation. Pass it to the
  payment API as an idempotency key — here the receipt even derives from it,
  so a retried charge yields the same order number.

## When the completion never comes

Try the `9999` card: the processor swallows the request forever. Without help
the machine would sit in `placing` until the end of time — a pending state is
a promise to the user, and promises need deadlines.

That's the `after` line at the top of `placing`: eight seconds without a
completion and the machine rescues *itself* back to `payment` with an honest
error. This is the shape `after` is for — bounding a wait on the outside
world, firing once, into a state you chose. Two properties come free:

- The rescue can't race the real completion into a double-resolution: if
  `CHARGE_OK` lands first, the machine has left `placing`, the timer is
  cancelled on exit, and a late `CHARGE_TIMEOUT` would find no handler and
  drop. State machines make "only one future wins" structural.
- The countdown survives restarts: timers re-arm on hydration with elapsed
  credit, so even a server that dies and returns mid-wait keeps the promise.
  Charges themselves are **command-role** transition effects — run at most
  once, never re-invoked — which is exactly what you want for money. The
  [effects guide](/guides/effects/) covers the load/command role split.

## Rendering the phases

The page `match`es on the machine's state — no spinner flags to forget, the
machine's states *are* the UI's states:

```
{match(read(checkout, c => c.state), {
  payment: () => /* card buttons + the error line, when set */,
  placing: () => <p>Placing your order…</p>,
  complete: () => <p>Thanks! Order number: {read(checkout, c => c.orderNumber)}</p>,
  /* shipping arm unchanged */
})}
```

## What you built · where to go

That completes Desksmith — and the tour: typed machines for catalog, cart,
and checkout; server rendering with slot patches; layouts via `<children>`;
a client-only theme toggle; Redis persistence; live cross-session updates;
and async I/O — bounded by a rescue timer — that never leaks into your state
logic.

- [Core Concepts](/concepts/state-machines/) — the "why it works this way"
  behind each piece.
- [Guides](/guides/templates/) — task-focused pages, including
  [effects](/guides/effects/) in more depth, [keyed lists](/guides/keyed-lists/),
  [app machines](/guides/app-machines/), and
  [shipping to production](/guides/production/).
- [API Reference](/reference/overview/) — every stable export.
