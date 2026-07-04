---
title: Async effects
description: "Do I/O from a transition — payments, APIs, databases — without holding anything up."
sidebar:
  order: 12
---

Actions and guards are synchronous: they compute the next state, nothing
else. When a transition needs I/O — charge a card, call an API, write to a
database — declare an **effect**:

```ts
states: {
  reviewing: {
    on: {
      SUBMIT: {
        to: 'submitting',
        effect: async (ctx, ev, meta): Promise<Events | null> => {
          try {
            const res = await charge(ctx.total, ev.token, meta.effectId)
            return { type: 'CHARGE_OK', chargeId: res.id }
          } catch {
            return { type: 'CHARGE_FAILED', reason: 'declined' }
          }
        },
      },
    },
  },
  submitting: {
    on: {
      CHARGE_OK: { to: 'confirmed', do: (ctx, ev) => { ctx.chargeId = ev.chargeId } },
      CHARGE_FAILED: { to: 'reviewing', do: (ctx, ev) => { ctx.error = ev.reason } },
    },
  },
},
```

The shape is always **pending state now, completion event later**. `SUBMIT`
commits `submitting` synchronously — the user sees "processing" in the POST
response. The effect runs after commit, and whatever event it returns is
dispatched like any other: `CHARGE_OK` lands in `submitting` and moves on.

## The rules that keep this safe

- **The response never waits.** Effects run after the POST has returned; the
  session lock is never held during I/O, so other events on the same session
  proceed normally.
- **Effects are infallible by construction.** The return type is
  `Promise<Events | null>` — catch inside and return your failure event
  (`null` means fire-and-forget). A throw is logged and dropped, never a
  crash.
- **Snapshots, not live state.** `ctx` and `ev` are commit-time clones. If a
  completion needs current state, put that logic in the completion event's
  own guards and actions — they run against live state.
- **Stale completions drop themselves.** A completion event is an ordinary
  event; if the machine has moved to a state with no handler for it, it's
  ignored. No cancellation machinery needed.
- **Annotate the return type.** TypeScript's inference defers arrows inside
  `defineMachine`, so write `: Promise<Events | null>` explicitly — without
  it you get a (loud) compile error, with it an undeclared completion event
  type is a compile error too.

## Where completions show up

The completion re-enters through the normal event path: state persists, and
[live routes](/guides/realtime-sse/) see the change over SSE immediately.
Non-live pages show it on their next request — which is why the pending state
exists: it's what the user sees until then.

`meta.effectId` is a unique id per invocation — thread it to external calls
as an idempotency key and use it to correlate logs.

## What effects are not

At-most-once and non-durable in 1.0: if the process dies mid-effect, the
machine stays in its pending state and the effect is lost. Design pending
states so a human (or a webhook) can resolve them. Durable, retried effects
are 1.x work.

Effects work identically on [client islands](/guides/client-components/)
(the effect runs in the browser, the completion feeds the local actor) and on
[app machines](/guides/app-machines/).
