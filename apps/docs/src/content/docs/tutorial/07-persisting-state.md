---
title: 7. Persisting state
description: "Keep the cart across requests and restarts with a Store."
sidebar:
  order: 7
---

The cart already survives navigation — click around and it stays full. That's the store doing its job. This step explains how, and how to swap the in-memory store for Redis so the cart also survives a server restart.

## Sessions & state lifetime

A `lifecycle: 'session'` machine belongs to one visitor, identified by a session cookie Stator sets automatically. Between requests, the cart isn't a live object sitting in memory — it's a snapshot in the **store**, keyed by session. Each request rehydrates the machines it needs, runs the event, and writes the touched ones back. (App-lifecycle machines like the catalog are the exception — they live in the process and aren't per-session.)

This is why the runtime stays cheap: there's no long-lived actor per visitor, just snapshots that load and save around each request.

## The Store interface

A store is anything implementing four methods:

```ts
interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId: string, machineName: string, snapshot: unknown, ttlSeconds: number): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
}
```

Snapshots are opaque JSON — the store never needs to understand your machine, just persist its serialized form. TTL is **per session**, not per machine, so a whole cart expires together rather than losing line items mid-checkout.

## In-memory default

`InMemoryStore` (what we've used so far) keeps snapshots in a `Map`. It's perfect for development and zero-config, with one catch: **state lives only as long as the process.** Restart the dev server and every cart is gone. You'll see a warning to that effect on boot, which is your reminder that it's not for production.

## Swapping in Redis

Move to durable persistence by changing one line in `server.ts`. Stator ships `RedisStore` and a `CachedStore` wrapper that fronts Redis with an in-memory cache to cut command counts:

```ts
import {
  InMemoryStore,
  RedisStore,
  CachedStore,
  type Store,
} from '@statorjs/stator/server'

let store: Store
if (process.env.REDIS_URL) {
  store = new CachedStore(new RedisStore(process.env.REDIS_URL), {
    memoryTtlSeconds: 300,
    maxEntries: 10_000,
  })
} else {
  store = new InMemoryStore()
}

const app = await createDevApp({
  // …root, dirs…
  store,
  sessionTtlSeconds: 86_400, // 24h idle window, refreshed on each cart action
})
```

Nothing in your machines or templates changes — the store is a pure infrastructure swap. Set `REDIS_URL` and carts now survive restarts and deploys.

### What persists vs not

- **Session machines** (the cart) — persisted to the store, survive restarts on Redis.
- **App machines** (the catalog) — live in process memory; re-seeded on boot.

:::caution[1.0]
App-machine state is **not** persisted across restarts in 1.0. For a seeded catalog that's fine (it re-seeds), but durable app state and cross-replica sharing are part of the deferred [1.x work](/introduction/why-stator/#the-10--1x-boundary).
:::

## What you built · next

A cart that persists across requests and — on Redis — across restarts, with no change to your application code. In [step 8](/tutorial/08-going-live-sse/) we make a page update live as state changes elsewhere.
