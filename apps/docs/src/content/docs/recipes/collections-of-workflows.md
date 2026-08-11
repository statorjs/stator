---
title: Collections of workflows
description: "One machine, many records, each with its own async workflow — the context-map pattern, and why completions belong in machine-level on:."
sidebar:
  order: 6
---

Admin tools, dashboards, and queues share a shape: one machine owns a
*collection*, and the machine has two independent state axes. A machine-wide
axis — is my snapshot of the datastore fresh? — and a per-record axis — this
row's save is in flight, that one hit a conflict. Stator's flat states can
put exactly one of those in the chart. This recipe is the pattern for the
other one.

## The shape

Put the machine-wide axis in `states:`. Put the per-record axis in a context
map keyed by record id, moved only by declared events:

```ts
type SavePhase = { phase: 'committing' } | { phase: 'conflict'; message: string }

export default defineMachine({
  name: 'AlertsMachine',
  lifecycle: 'app',
  events: {} as AlertEvents,
  context: { entries: [] as AlertEntry[], saves: {} as Record<string, SavePhase> },
  initial: 'loading',
  states: {
    loading: {
      entry: () => load(),
      on: { LOADED: { to: 'ready', do: applyEntries } },
    },
    ready: {
      on: {
        SAVE: {
          when: (ctx, ev) => !ctx.saves[ev.id], // one workflow per record
          do: (ctx, ev) => {
            ctx.saves[ev.id] = { phase: 'committing' }
          },
          effect: (ctx, ev, meta) => commitSave(ctx, ev, meta.effectId),
        },
        RELOAD: { to: 'loading' },
      },
    },
  },
  // Completions land HERE — see below.
  on: {
    COMMIT_OK: (ctx, ev) => {
      delete ctx.saves[ev.id]
      applySaved(ctx, ev)
    },
    COMMIT_CONFLICT: (ctx, ev) => {
      ctx.saves[ev.id] = { phase: 'conflict', message: ev.message }
    },
  },
  selectors: {
    entries: (ctx) => ctx.entries,
    saveOf: (ctx) => (id: string) => ctx.saves[id] ?? null,
  },
})
```

## Why completions go in machine-level on:

A completion event is an ordinary event, and the engine's rule is that an
unhandled event drops. For a single-workflow machine that rule is correct —
if the machine moved on, the completion is stale. For a collection it is a
trap: the machine-wide axis moves for reasons unrelated to any record.

```
ready    SAVE(A)              saves[A] committing, effect A in flight
ready    SAVE(B)              saves[B] committing, effect B in flight
ready    COMMIT_CONFLICT(B)   B's base was stale → RELOAD → 'loading'
loading  COMMIT_FAILED(A)     dropped?! A's effect fired on schedule
```

If `COMMIT_FAILED` is declared only under `ready`, record A is stranded in
"committing" forever — transition effects run at most once and nothing
replays the event. Declaring completions in the machine-level `on:` map
(built for exactly this case) makes them deliverable in ANY state a
state doesn't override: the freshness axis can churn freely and no record's
workflow gets lost.

## Guards read the map

Per-record rules are ordinary guards over the map — `when: (ctx, ev) =>
!ctx.saves[ev.id]` above is "one in-flight save per record". The same map
backs display: a keyed list row reads its record's phase and renders the
badge, spinner, or conflict banner:

```astro
{each(read(alerts, (a) => a.entries), (entry) => (
  <AlertRow entry={entry} save={read(alerts, (a) => a.saveOf(entry.id))} />
), { key: (entry) => entry.id })}
```

## The honest limit

The chart shows the freshness axis. The per-record workflow — the more
interesting one — lives in a map and is legible only by reading the actions
that move it, which costs you some of "audit the machine by reading the
chart". That is a known tension with a designed future (per-record statechart
shapes are on the books), and hitting it painfully in a real
app is exactly the evidence that design is waiting for. Until then: keep the
map's phases a closed union, move it only in declared events, and put every
completion in machine-level `on:`.

The worked example is the [`stockroom` example](https://github.com/statorjs/stator/tree/main/examples/stockroom) — a live inventory table built on exactly this pattern: freshness axis in the chart, per-row saves in a context map, completions in machine-level `on:`, and optimistic-concurrency conflicts surfaced per row.
