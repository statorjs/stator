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

A completion event is a *declared* event like any other — which also means
it is dispatchable from the browser via `/__events`, exactly like a template
event. Don't treat "this only arrives from my effect" as a trust boundary: a
completion must not carry authority the machine wouldn't accept from a
client. The [authentication recipe](/recipes/authentication/)'s rule applies
unchanged — an event proves itself or grants nothing.

`meta.effectId` is a unique id per LOGICAL invocation — a re-invoked entry
effect keeps its id — so thread it to external calls as an idempotency key
and use it to correlate logs.

## Load and command roles

The two effect positions carry different lifetime contracts, by category:

- **Entry effects are the load role** — how a state gets its data. If a
  process dies while one is in flight, the next restore of that state
  re-invokes it (same `effectId`), so the machine recovers instead of waiting
  forever for a completion that died with another process. Leaving the state
  aborts `meta.signal` — pass it to `fetch` and the wasted request stops at
  the source. Write entry effects as re-runnable reads; don't put
  non-idempotent external writes in them.
- **Transition effects are the command role** — what a user action causes.
  At-most-once, never re-invoked, never aborted. External writes (charge a
  card, send an email) belong here.

## Who owns the clock

`after` timers re-arm on restore with elapsed credit (the deadline is when
the state was entered plus the delay), so a restart no longer silently kills a
countdown. They remain non-durable — a machine nobody touches again after a
restart never re-arms — which makes them right for process housekeeping and
wrong as the engine of periodic refresh. For "keep this data fresh while
someone is looking at it", put the clock on the client: a visibility-aware
interval dispatching a refresh event is demand-aware by construction (hidden
tab, no ticks), and the machine keeps the policy — a staleness guard decides
whether any tick actually causes work. Server-side machine activity does not
refresh the session's TTL; only real user requests do.

## What effects are not

Non-durable in 1.0: if the process dies mid-effect, a transition effect is
lost (the machine stays in its pending state — design those states so a human
or a webhook can resolve them), and an entry effect recovers by re-invoke on
the next restore. Durable, retried effects are 1.x work.

Effects work identically on [client islands](/guides/client-components/)
(the effect runs in the browser, the completion feeds the local actor) and on
[app machines](/guides/app-machines/).

## Converging completions

Effects are at-most-once but not exactly-once relative to each other — two
overlapping restock effects may both complete. Design completion handlers to
**converge**: set the level rather than add to it, use `Math.max`, treat the
completion as "the world is now X" rather than "apply delta Y". Converging
handlers make racing effects harmless without any locking.
