---
title: Store adapter with per-session TTL
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: persistence
---

## What and Why

The runtime model is per-request actors plus persistent state somewhere else. The Store is that somewhere else. It's the swap point that lets the framework run with no infrastructure (in-memory), on a hosted KV (Redis/Upstash), or eventually on something more durable (Postgres) without changing any user code.

The why behind committing to this early: long-lived actor-per-session works fine until the moment it doesn't, and the moment it doesn't is exactly when someone tries to deploy across two replicas. Pulling the V1 adapter forward to the POC closes that escape hatch and makes the upgrade path trivial.

Per-session TTL is the other half. Without it, every adapter accumulates dead sessions forever. With it, idle sessions expire as a unit and the storage layer stays bounded.

## Success Criteria

- A single interface (`Store`) with four methods: `get`, `set`, `has`, `deleteSession`.
- At least two implementations ship: `InMemoryStore` for dev and local use, `RedisStore` for production.
- A swap is a one-line change in the app's `createApp({ store })` call.
- TTL semantics are documented and consistent across adapters. Per-session, not per-entry.
- Adapter ergonomics good enough that a third one (Postgres, SQLite) could be written without reading framework internals.

## Constraints

- Values are opaque JSON. The framework treats stored snapshots as bytes, not as machine state. This keeps the adapter contract small.
- App-lifecycle machine state is not persisted by this layer. It lives in the process for the duration of the server. App state is shared, not session-scoped, and bringing it into the Store would conflate two different storage problems.
- Per-session TTL means: any `set` to any machine inside session X refreshes the whole session's expiry. Adapters must honor this, not just the entry being written.
- Async interface even on the in-memory path. The framework is built around `await`-able Store calls. A sync in-memory adapter would force a branch in every call site.

## Approach

Interface in `packages/stator/src/server/store.ts`. Two shipping implementations:

- **`InMemoryStore`**: nested Map plus a per-session expiry timestamp Map. Lazy expiry on `get`/`has`. Process-lifetime only.
- **`RedisStore`** (`ioredis`): one hash per session (`stator:session:<sid>`) with machine names as fields. `HSET` and `EXPIRE` are pipelined in `set()` so the whole hash's TTL refreshes atomically. The hash-per-session shape is what makes per-session TTL natural at the Redis level.

`SessionRuntime.persistTouched` is the only place inside the framework that calls `Store.set`. It passes `MachineStore.sessionTtlSeconds` (configured via `createApp({ sessionTtlSeconds })`). Default is 24h.

A third optional adapter, `CachedStore`, wraps any backing Store with a write-through LRU memory cache. Reduces command counts against paid adapters (Upstash) by 40-50% on chatty sessions without changing the durability story.

## Alternatives Considered

- **Per-entry TTL.** Each `set` would set its own expiry. Rejected because it allows a session's cart to drop while the user is mid-checkout — an active user has an active cart, by definition. Per-session expiry treats activity correctly.
- **Sync interface for in-memory.** Considered for ergonomics in tests. Rejected because making sync the canonical shape would force every adapter to fake-async or wrap sync calls, and most realistic backends are async. The async-everywhere choice means a single call-site shape works for all of them.
- **Adapter discovery.** Considered a plug-in mechanism (`createApp({ store: 'redis' })`). Rejected as overkill for the POC. Direct `new RedisStore(url)` is two lines and stays clear about what's actually wired up.
- **Bundling app-machine state into the Store.** Briefly considered for "one storage model to rule them all." Rejected because app state has different needs (shared across sessions, no TTL, restart-fresh is sometimes correct) and bundling them would force every adapter to handle both shapes.

## Open Questions

- Cross-replica fan-out for app-machine updates is not addressed by this design. App state is process-local. When multi-replica becomes real, app machines either get their own gossip mechanism or get demoted to "configuration loaded at boot." Not a Store concern.
- Postgres adapter shape: the four-method interface fits, but TTL via row expiry is awkward in SQL. A real Postgres adapter likely needs a background sweep job. Out of scope until someone needs it.
- Inbox storage (for the deferred cross-machine event delivery work) probably reuses the Store, but the access patterns (append, drain, list-sessions-by-receiver) are different enough that the interface may need extending rather than reusing `get`/`set`.

## Implementation Notes

Shipped. The four-method interface held up through both shipped adapters and a third (`CachedStore`) that decorates rather than implements the backing.

The biggest non-obvious payoff: hash-per-session in Redis turned "refresh the whole session's TTL on activity" from a coordination problem into a single `EXPIRE` call. If we'd gone per-entry keys (`stator:session:<sid>:CartMachine`) instead, we'd be issuing N `EXPIRE` calls per set or accepting drift. The shape of the data on Redis enforces the TTL semantic naturally.