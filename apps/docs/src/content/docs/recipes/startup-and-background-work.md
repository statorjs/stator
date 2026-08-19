---
title: Startup work & background sources
description: "A boot.ts hook runs once when the server starts — the home for a long-lived source that polls or subscribes to an external system and feeds the app-machine graph."
sidebar:
  order: 11
---

Some state doesn't come from a request. A fleet's telemetry, an upstream price feed, a queue you drain — these are driven by the *server's* clock, not a user's click, and they should run whether or not anyone is looking. That's what `boot.ts` is for.

A root-level `boot.ts` is auto-discovered (like `middleware.ts`) and runs **once when the server starts listening**. Its job is to install a long-lived *source* — a poll, a subscription — that dispatches events into the app-machine graph.

## The pattern: source in, events out

```ts
// boot.ts
import { defineBoot } from '@statorjs/stator/server'
import FleetMachine from './machines/fleet.ts'

export default defineBoot(async ({ dispatchToApp }) => {
  // query config once at boot
  const cfg = await fetchFleetConfig()
  await dispatchToApp(FleetMachine, { type: 'CONFIGURED', cfg })

  // then a long-lived poll feeding the graph
  const timer = setInterval(async () => {
    await dispatchToApp(FleetMachine, { type: 'TICK', data: await poll() })
  }, 30_000)

  // teardown — composed into graceful shutdown
  return () => clearInterval(timer)
})
```

`boot.ts` runs once per process. A dev restart re-runs it; an in-process rebuild does not; tests that only call `app.fetch` never trigger it (it fires from `listen`). Return a teardown and the framework runs it on `SIGTERM`/`SIGINT`, before closing the server — so a subscription's `unsubscribe` or a timer's `clearInterval` isn't left racing the exit.

## Boot is a *source*, not a controller

The `BootContext` is deliberately narrow — `dispatchToApp` and a read-only `config`. There's no `listen`/`fetch`, no raw Hono app, no store. That's the point: boot **supplies events; the machine supplies meaning.** Every policy decision — when to act, whether to act, how to react — belongs in the chart, not this closure.

Concretely: don't debounce the poll in `boot.ts`. Emit a plain `TICK` on the timer and let the machine's **guard** decide:

```ts
// machines/fleet.ts — the guard owns the cadence policy
TICK: {
  when: (ctx) => ctx.status === 'active',   // ignore ticks while idle
  // ...
}
```

Now the behavior is readable in the single file and unit-testable with no server, no timers:

```ts
const fleet = createActor(FleetMachine).start()
fleet.send({ type: 'TICK' })
expect(fleet.getSnapshot().value).toEqual(['idle'])  // guard-dropped while idle
```

Env is ambient — read `process.env.MY_KEY` directly (`.env` is loaded before boot runs). Pass `config` when you need the framework's own settings (`config.origin` for outbound URLs).

## When *not* to reach for it

`boot.ts` is for sources that run regardless of viewers. If your data is **viewer-driven**, there are better tools:

- **Someone is looking at it** (a forecast, a dashboard they opened) — drive the refresh from the client (a small island ticking while the tab is visible) or from a machine's `after` revalidation. It's demand-aware for free: closed tabs stop asking, and you never poll for data nobody wants. The [`weather` example](https://github.com/statorjs/stator/tree/main/examples/weather) does exactly this.
- **It reacts to something in the app** (an order was placed, a threshold crossed) — that's a machine **effect** on the transition, or a cross-machine subscription. No boot hook needed.

Reach for `boot.ts` when the source is autonomous and server-lived — telemetry, an external feed, a queue — and there's no request to hang it on.
