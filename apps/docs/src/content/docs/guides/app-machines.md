---
title: App machines
description: "One shared instance per server: live dashboards, tallies, and server-originated events."
sidebar:
  order: 13
---

A `lifecycle: 'session'` machine exists once per visitor. A
`lifecycle: 'app'` machine exists **once per server** — shared state every
session can see. It's what powers cross-session views: an admin dashboard, a
live poll tally, an inventory board.

```ts
export default defineMachine({
  name: 'BoardMachine',
  lifecycle: 'app',
  persist: true,
  subscribes: [{ from: Ping, event: 'pinged', dispatch: 'BUMP' }],
  // …
})
```

## How events reach an app machine

Two ways, by design:

**From sessions, via emits.** A session machine `emit`s; the app machine
`subscribes`. The framework injects `sourceSessionId` into the dispatched
event so the app machine knows who triggered it. This is the path for
"every order updates the shared board."

**From server code, via `dispatchToApp`.** Webhooks, cron jobs, and anything
else with no HTTP session use the typed server-originated entry point:

```ts
import { dispatchToApp } from '@statorjs/stator/server'
import Board from './machines/board.ts'

const app = await createApp({ /* … */ })

// e.g. inside a webhook handler or a setInterval:
await dispatchToApp(app.store, Board, { type: 'BUMP', by: 5 })
```

`dispatchToApp` sends the event, persists the machine if it opted in, and
fans the change out to every live SSE connection whose route reads it — a
cron job can move a dashboard in real time.

There is no direct *client*→app dispatch: browsers talk to their session
machines, and session machines emit upward. That keeps "who can change shared
state" an explicit, reviewable list.

## Surviving restarts: `persist: true`

App machines live in process memory and reset on deploy — often correct (a
cache should reset). When state must survive, opt in:

```ts
lifecycle: 'app',
persist: true,
```

Persisted app machines snapshot through an **AppStore** — a deliberately
separate interface from the session store (one blob per machine, no TTL).
`InMemoryAppStore` is the default; pass `RedisAppStore` for real durability:

```ts
import { RedisAppStore } from '@statorjs/stator/server'

const app = await createApp({
  // …
  appStore: new RedisAppStore(process.env.REDIS_URL!),
})
```

On boot, a persisted snapshot hydrates the actor before it starts. An
unusable snapshot logs loudly and boots fresh — restart-fresh is the safe
default. Writes are event-driven: whenever a transition touches the machine,
the new snapshot is saved.

Setting `persist: true` on a *session* machine is a define-time error —
session machines always persist through the session store.

## The single-replica caveat

App machines are in-process singletons. Two replicas would each run their own
copy and drift; the AppStore assumes a single writer. Multi-replica app state
is a 1.x problem with a designed path (leader/backplane) — don't scale out
with persisted app machines until it lands.
