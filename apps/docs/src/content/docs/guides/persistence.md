---
title: Persistence
description: "Store adapters for session state: in-memory, Redis, and cached Redis with per-session TTL."
sidebar:
  order: 9
---

Session-lifecycle state is persisted to a **store** between requests. Swapping stores is an infrastructure change — your machines and templates never know.

## The Store interface

Any store implements four methods over opaque JSON snapshots:

```ts
interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId: string, machineName: string, snapshot: unknown, ttlSeconds: number): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
}
```

TTL is **per session**, not per machine — a whole session expires together, so a cart never loses individual lines mid-checkout.

## In-memory (default)

`InMemoryStore` keeps snapshots in a `Map`. Zero-config and ideal for development, but **state is lost on restart** — not for production.

```ts
store: new InMemoryStore()
```

## Redis

`RedisStore` persists to Redis so state survives restarts and deploys:

```ts
store: new RedisStore(process.env.REDIS_URL)
```

## Cached Redis

`CachedStore` fronts any store with an in-memory cache (write-through), cutting Redis command counts on chatty sessions:

```ts
store: new CachedStore(new RedisStore(url), {
  memoryTtlSeconds: 300,
  maxEntries: 10_000,
})
```

A crash loses only the cache, not committed state.

## What persists

Only `lifecycle: 'session'` machines are stored. App machines live in process memory and re-seed on boot — see [Sessions and state](/concepts/sessions-and-state/).
