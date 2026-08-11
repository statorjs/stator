---
title: Receiving webhooks
description: "A webhook is a signed, session-less, at-least-once POST. Verify it, dispatch it to an app machine, and let a guard make duplicate delivery a no-op."
sidebar:
  order: 7
---

A webhook — Stripe telling you a payment cleared, GitHub telling you a branch
pushed — is a server-to-server `POST`. It arrives with **no browser and no
session cookie**, and providers deliver *at least once*, so the same event can
land twice. Two jobs follow from that: prove the request is real, then process
it exactly once.

## Where a webhook lands: an app machine

[Session machines are addressed by the browser's cookie](/recipes/authentication/) —
they *are* the sender's identity. A webhook has no session, so it has no session
machine to route into. Its home is an **app-lifecycle machine**: shared across
all sessions, long-lived, the place cross-cutting state (billing, inventory,
audit) lives. `dispatchToApp` is that machine's entry point for exactly this —
webhooks and cron.

It isn't on the route helpers (those reach session machines only). You dispatch
against the app instance you created:

```ts
// routes/webhooks/stripe.ts
import { app } from '../../app.ts'                 // the instance you export from createApp
import { verifySignature } from '../../lib/webhook.ts'
import { BillingMachine } from '../../machines/billing.ts'

export const POST = defineApiRoute({
  handler: async (request) => {
    const body = await request.text()              // raw body — needed to verify the signature
    const sig = request.headers.get('stripe-signature')
    if (!verifySignature(body, sig, process.env.WEBHOOK_SECRET!)) {
      return new Response('bad signature', { status: 400 })
    }

    const event = JSON.parse(body)
    const { committed } = await app.dispatchToApp(BillingMachine, {
      type: 'PAYMENT_EVENT',
      deliveryId: event.id,                        // the provider's unique event id
      kind: event.type,
      data: event.data,
    })

    // 200 whether we processed it or a guard dropped a duplicate — either way,
    // don't make the provider retry.
    return new Response(committed ? 'processed' : 'duplicate', { status: 200 })
  },
})
```

## Prove it's real: verify the signature

The framework's cookie and CSRF defenses guard *browser* requests. A cookieless
server-to-server caller sails past them — so the trust has to come from the
payload itself. Every provider signs the body with a shared secret. Verify it
before you dispatch, in constant time.

```ts
// lib/webhook.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySignature(body: string, header: string | null, secret: string) {
  if (!header) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header)
  return a.length === b.length && timingSafeEqual(a, b)
}
```

This is the [same "prove itself or grant nothing" rule](/recipes/authentication/)
the auth recipe bans forgeable events with — a webhook proves itself with a
signature, or it gets nothing.

## Process exactly once: a guard makes duplicates a no-op

At-least-once delivery means duplicates are normal, not exceptional. Stator has
**no built-in dedupe** for app dispatch — and it doesn't need one, because
idempotency is a guard. Keep the delivery ids you've processed and drop anything
you've seen:

```ts
// machines/billing.ts
PAYMENT_EVENT: {
  when: (ctx, ev) => !ctx.processed.includes(ev.deliveryId),   // seen it? drop it.
  do: (ctx, ev) => {
    ctx.processed.push(ev.deliveryId)
    applyPayment(ctx, ev)
  },
},
```

A duplicate hits the guard, fails it, and *does not transition* — so
`dispatchToApp` returns `{ committed: false }`. That's the signal the route reads
to tell "processed" from "already handled".

:::note[`committed` is your idempotency signal]
`{ committed: true }` means the event moved the machine. `false` means a guard
dropped it — here, a duplicate. Same 200 either way, because the provider's job
is done in both cases.
:::

## Answer fast, work in effects

Providers time out and retry a slow endpoint. Do the *decision* synchronously
(verify, dedupe, record) and push slow work — charging, emailing, calling
another API — into a transition **effect**, which runs after the response is on
its way. The route acknowledges in milliseconds and the real work happens
off the request path.

## In production you'd add

- **Per-provider signature schemes.** Stripe signs a timestamped payload with a
  replay window, GitHub uses `X-Hub-Signature-256`, others differ. Verify to the
  provider's spec, and reject stale timestamps to close replay.
- **A bounded, durable processed-id store.** `ctx.processed` as an ever-growing
  array is the exact [context cliff](/recipes/where-data-lives/) this framework
  warns about — it's cloned and re-serialized on every event. Cap it to a recent
  window, or key a table in real storage and dedupe with a guard that reads it.
- **A dead-letter path** for events whose processing effect fails, so a bad
  payload doesn't silently vanish.
