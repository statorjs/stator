---
title: 9. Checkout with async effects
description: "Build the checkout flow, then call a payment API from a transition — the pending-state pattern that keeps machines pure, and the after-timer that bounds it."
sidebar:
  order: 9
---

Desksmith renders, reacts, persists, and broadcasts — but it can't take an
order. This final chapter builds the checkout: a guarded multi-step flow,
**synchronous first**, then upgraded with the one pattern Stator uses for
*all* async work: **pending state now, completion event later** — plus the
timer that keeps a pending state from becoming a trap.

## The checkout machine, synchronous first

This is the tutorial's first machine with **more than one state**. Every
machine so far has lived in a single `idle` state; a checkout genuinely
moves — shipping details, then payment, then done — so its transitions name
a target with `to:`. Create `machines/checkout.ts`:

```ts
import { defineMachine } from '@statorjs/stator/server'

type CheckoutContext = {
  shippingName: string
  shippingAddress: string
  paymentLast4: string
  orderNumber: string | null
  error: string
}

type Field = 'shippingName' | 'shippingAddress' | 'paymentLast4'

type CheckoutEvents =
  | { type: 'SET_FIELD'; field: Field; value: string }
  | { type: 'SUBMIT_SHIPPING' }
  | { type: 'SUBMIT_PAYMENT' }
  | { type: 'BACK' }
  | { type: 'RESET' }

// Shared by both the shipping and payment SET_FIELD transitions.
const setField = (ctx: CheckoutContext, ev: { field: Field; value: string }) => {
  ctx[ev.field] = String(ev.value)
}

const shippingValid = (ctx: CheckoutContext) =>
  ctx.shippingName.trim().length > 0 && ctx.shippingAddress.trim().length > 0

export default defineMachine({
  name: 'CheckoutMachine',
  lifecycle: 'session',
  events: {} as CheckoutEvents,
  emits: ['ORDER_PLACED'],

  context: {
    shippingName: '',
    shippingAddress: '',
    paymentLast4: '',
    orderNumber: null,
    error: '',
  } as CheckoutContext,

  initial: 'shipping',
  states: {
    shipping: {
      on: {
        SET_FIELD: (ctx, ev) => {
          setField(ctx, ev)
        },
        SUBMIT_SHIPPING: { to: 'payment', when: shippingValid },
      },
    },
    payment: {
      on: {
        SET_FIELD: (ctx, ev) => {
          setField(ctx, ev)
        },
        BACK: { to: 'shipping' },
        SUBMIT_PAYMENT: {
          to: 'complete',
          when: (ctx) => /^\d{4}$/.test(ctx.paymentLast4),
          do: (ctx) => {
            ctx.orderNumber = 'ORD-DEMO'   // stamped synchronously — for now
          },
          emit: 'ORDER_PLACED',
        },
      },
    },
    complete: {
      on: {
        RESET: {
          to: 'shipping',
          do: (ctx) => {
            ctx.shippingName = ''
            ctx.shippingAddress = ''
            ctx.paymentLast4 = ''
            ctx.orderNumber = null
            ctx.error = ''
          },
        },
      },
    },
  },

  selectors: {
    shippingName: (ctx) => ctx.shippingName || '(not set)',
    shippingAddress: (ctx) => ctx.shippingAddress || '(not set)',
    paymentLast4: (ctx) => ctx.paymentLast4 || '(not set)',
    orderNumber: (ctx) => ctx.orderNumber ?? '',
    error: (ctx) => ctx.error,
  },
})
```

Two things are new here besides `to:`:

- **`emits: ['ORDER_PLACED']` + `emit: 'ORDER_PLACED'`** — the machine
  *announces a fact* when the order lands. Nothing listens yet; we'll wire
  the cart to it at the end of this chapter. Declared emits are how machines
  compose without importing each other's internals — see
  [Composition](/concepts/composition/).
- **`error` in context** — empty for now. The async upgrade below is what
  puts something in it.

## A page for the flow

Create `routes/checkout.stator`. The page `match`es on the machine's state —
no step counter, no flags: the machine's states *are* the page's states.

```astro
---
import CartMachine from '../machines/cart.ts'
import CheckoutMachine from '../machines/checkout.ts'
import CustomerLayout from '../templates/customer-layout.stator'

const [cart, checkout] = Stator.reads([CartMachine, CheckoutMachine])
---
<CustomerLayout cart={cart}>
  <section>
    <h1>Checkout</h1>
    <p>Current state: {read(checkout, c => c.state)}</p>

    {match(read(checkout, c => c.state), {
      shipping: () =>
        <div>
          <h2>1. Shipping</h2>
          <p>Name: {read(checkout, c => c.shippingName)}</p>
          <p>Address: {read(checkout, c => c.shippingAddress)}</p>
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' })}>Set name</button>
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'shippingAddress', value: '123 Demo St' })}>Set address</button>
          <button on:click={() => checkout.send({ type: 'SUBMIT_SHIPPING' })}>Continue to payment →</button>
        </div>,

      payment: () =>
        <div>
          <h2>2. Payment</h2>
          <p>Card last 4: {read(checkout, c => c.paymentLast4)}</p>
          {when(read(checkout, c => c.error), () => (
            <p class="error">{read(checkout, c => c.error)}</p>
          ))}
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '4242' })}>Set card</button>
          <button on:click={() => checkout.send({ type: 'BACK' })}>← Back</button>
          <button on:click={() => checkout.send({ type: 'SUBMIT_PAYMENT' })}>Place order</button>
        </div>,

      complete: () =>
        <div>
          <h2>3. Complete</h2>
          <p>Thanks! Order number: <strong>{read(checkout, c => c.orderNumber)}</strong></p>
          <button on:click={() => checkout.send({ type: 'RESET' })}>Start a new order</button>
        </div>,
    })}
  </section>
</CustomerLayout>
```

Two notes:

- **`c.state` is built in.** Every instance exposes the current state *name*
  alongside your selectors — that's what makes match-on-state a one-liner.
- **The buttons stand in for form fields** so the demo collects no personal
  data — the finished example does the same, and splits this markup into a
  `templates/checkout-page.stator` component. The machine wouldn't change
  with real inputs; live field binding is the
  [forms guide](/guides/forms-and-binding/).

**Checkpoint**: run the dev server and open `/checkout`. Walk the flow: set
name and address, continue, set the card, place the order. The state label
walks `shipping → payment → complete` and the order number reads `ORD-DEMO`.
Try continuing with an unset address — the guard blocks the transition and
nothing changes.

## The problem effects solve

`SUBMIT_PAYMENT` stamps an order number synchronously — no money moves.
A real payment call takes hundreds of milliseconds against someone else's
server. Actions — the `do` handlers you've been writing since
[chapter 2](/tutorial/02-your-first-machine/) — are **synchronous by
contract**: they compute the next state, nothing else. A charge can't live
inside one, and you wouldn't want the user's POST (or the session lock) held
open while it runs.

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

Add the three completion events to `CheckoutEvents`:

```ts
type CheckoutEvents =
  | { type: 'SET_FIELD'; field: Field; value: string }
  | { type: 'SUBMIT_SHIPPING' }
  | { type: 'SUBMIT_PAYMENT' }
  | { type: 'CHARGE_OK'; receipt: string }
  | { type: 'CHARGE_FAILED'; reason: string }
  | { type: 'CHARGE_TIMEOUT' }
  | { type: 'BACK' }
  | { type: 'RESET' }
```

Then `SUBMIT_PAYMENT` stops jumping straight to `complete`. It enters a new
`placing` state and declares the charge as its effect (`import { chargeCard }
from '../lib/payments.ts'` at the top of the machine file):

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

And a new `placing` state (between `payment` and `complete`) declares how
each future resolves it:

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

Notice what moved: the order-number stamp and the `emit: 'ORDER_PLACED'`
left `SUBMIT_PAYMENT` and now live on `CHARGE_OK` — **the announcement moves
to where the fact actually becomes true**. Read the
`payment → placing → complete` path out loud — it *is* the business process.
That legibility is why the pending state is mandatory rather than optional
ceremony: every state the user can observe is a state you declared.

## What happens on SUBMIT_PAYMENT, step by step

1. The POST arrives; the transition commits `placing` **synchronously**. The
   response carries patches for that — your page shows the placing step right
   away.
2. The effect runs *after* the response, with commit-time snapshots of `ctx`
   and `ev`. Nothing is blocked: the session lock is free, other events flow.
3. The returned event (`CHARGE_OK` or `CHARGE_FAILED`) dispatches like any
   other event. State persists; a [live route](/tutorial/08-going-live-sse/)
   sees it over SSE, a plain page shows it on the next request. Add the
   `// @stator live` pragma to the top of `routes/checkout.stator`'s
   frontmatter — an async flow whose resolution the user has to refresh for
   is not much of a flow.

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

## Rendering the phases

Two additions to `routes/checkout.stator`: a `placing` arm, and a
"declined card" button so the failure path is walkable:

```astro
placing: () =>
  <div>
    <h2>2½. Placing your order…</h2>
    <p>The charge runs as a transition effect; this pending state is what
    you see until its completion event lands.</p>
  </div>,
```

```astro
<button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '0000' })}>Set declined card</button>
<button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '9999' })}>Set silent card</button>
```

**Checkpoint**: place an order with `4242` — the page shows the placing step
for ~600ms, then the receipt, with a real `ORD-…` number. Now try `0000`:
back to the payment step with "card declined" in the error line you wired up
earlier.

## When the completion never comes

Try the silent card, `9999`: the processor swallows the request forever.
Without help the machine would sit in `placing` until the end of time — a
pending state is a promise to the user, and promises need deadlines.

That's the `after` line at the top of `placing`: eight seconds without a
completion and the machine rescues *itself* back to `payment` with an honest
error. This is the shape `after` is for — bounding a wait on the outside
world, firing once, into a state you chose. Two properties come free:

- The rescue can't race the real completion into a double-resolution: if
  `CHARGE_OK` lands first, the machine has left `placing`, the timer is
  cancelled on exit, and a late `CHARGE_TIMEOUT` would find no handler and
  drop. State machines make "only one future wins" structural.
- The countdown survives restarts: timers re-arm on restore with elapsed
  credit, so even a server that dies and returns mid-wait keeps the promise.
  Charges themselves are **command-role** transition effects — run at most
  once, never re-invoked — which is exactly what you want for money. The
  [effects guide](/guides/effects/) covers the load/command role split.

## Close the loop: the cart empties itself

The order is placed but the cart still shows its items. The checkout
machine shouldn't reach over and clear it — it announced `ORDER_PLACED`;
reacting is the cart's business. Add a subscription to `machines/cart.ts`:

```ts
import CheckoutMachine from './checkout.ts'

// inside defineMachine({ ... })
subscribes: [{ from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' }],
```

When the emit fires, the cart dispatches its own `CLEAR` — the one you built
in [chapter 2](/tutorial/02-your-first-machine/). Neither machine imports
the other's internals; the emit name is the whole contract.

**Checkpoint**: add items, place an order with `4242`, and watch the header
cart counter drop to zero the moment the receipt appears.

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
