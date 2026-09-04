---
title: Persistence
description: "Store adapters for session state: in-memory, Redis, and cached Redis with per-session TTL."
sidebar:
  order: 9
---

Session-lifecycle state is persisted to a **store** between requests. Swapping stores is an infrastructure change — your machines and templates never know. In `stator.config.ts` the store lives at `persistence.session`.

## The Store interface

Any store implements four required methods over opaque JSON snapshots, plus one optional method that session rotation depends on:

```ts
interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId: string, machineName: string, snapshot: unknown, opts?: { ttlSeconds?: number }): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
  renameSession?(oldSessionId: string, newSessionId: string): Promise<void>
}
```

TTL is **per session**, not per machine — a whole session expires together, so a cart never loses individual lines mid-checkout.

`renameSession` moves every snapshot from one session id to another. It's optional for a custom adapter, but [`rotateSession`](/recipes/authentication/) — the login/logout session-fixation defense — **fails loudly without it**, so a custom store that will ever sit under authentication should implement it. The built-in stores all do.

## In-memory (default)

`InMemoryStore` keeps snapshots in a `Map`. Zero-config and ideal for development, but **state is lost on restart** — not for production.

```ts
persistence: { session: new InMemoryStore() }
```

## Redis

`RedisStore` persists to Redis so state survives restarts and deploys:

```ts
persistence: { session: new RedisStore(process.env.REDIS_URL) }
```

## Cached Redis

`CachedStore` fronts any store with an in-memory cache (write-through), cutting Redis command counts on chatty sessions:

```ts
persistence: {
  session: new CachedStore(new RedisStore(url), {
    memoryTtlSeconds: 300,
    maxEntries: 10_000,
  }),
}
```

A crash loses only the cache, not committed state.

## Choosing from the environment

Most apps want Redis in production and nothing to install locally, which used to mean writing the conditional yourself:

```ts
// Works, but degrades in silence
const store = url ? new RedisStore(url) : new InMemoryStore()
```

The problem isn't the fallback — it's right for development, and right for CI, where a build machine has no business holding production credentials. The problem is that in production it means the app runs, looks healthy, and quietly loses every session on restart. Written this way, the framework cannot tell that outcome from a deliberate choice, so it cannot warn you.

`sessionStore` moves the conditional inside, which is enough to change that:

```ts
import { sessionStore } from '@statorjs/stator/server'

export default defineConfig({
  persistence: {
    session: sessionStore({
      redisUrl: process.env.REDIS_URL,
      cache: { memoryTtlSeconds: 300, maxEntries: 10_000 },
    }),
  },
})
```

A URL means Redis, wherever it comes from — so pointing CI at a test Redis is nothing special, just the variable being set. An absent, empty, or whitespace-only value means in-memory, which is silent in development and, in production, reported by name:

```
stator: REDIS_URL is empty, so session state is in memory and will not survive a restart
```

Passing the key is what says you want durability from the environment. Calling `sessionStore()` with nothing — or omitting `persistence.session` entirely — chooses in-memory deliberately, and is never reported. `appStore` does the same for [persisted app machines](/guides/app-machines/). Neither ever refuses to start: persistent storage is assumed to be what you want, never required.

## Knowing what you got

Every startup states the posture, at any log level, so a deploy log never leaves it to inference:

```
stator v2.10.0 · http://localhost:3000/ · 4 machines · 4 routes · sessions CachedStore
stator v2.10.0 · http://localhost:3000/ · 4 machines · 4 routes · sessions in-memory
```

In production, anything actually at risk also logs a warning — session machines on ephemeral storage, or `persist: true` app machines with no durable app store. An app with no session machines has no session state to lose and is left alone. `stator build` says its part too: if your config declares no session store at all, the build notes it, because whether a store is *declared* is knowable from the code while which store it *resolves to* depends on the production environment a build machine doesn't have.

## What persists

Only `lifecycle: 'session'` machines are stored through the session `Store`. App machines live in process memory and re-seed on boot unless they opt in with `persist: true`, which saves them through the `AppStore` — see [Sessions and state](/concepts/sessions-and-state/).

## What survives a deploy

Machine state is **working state with a TTL, not persistence**. Stator keeps a session's machines across requests, live connections, and deploys that leave their code untouched, and lets them go when the session expires, when a server with no configured store restarts, or when the machine's code has changed.

That last rule is the one to design around: **sessions never outlive the code that made them.** Every persisted snapshot carries a hash of the machine's code — the machine file and every module it reaches, tree-shaken — and a snapshot whose hash no longer matches the running machine is discarded at the next hydration. The machine starts fresh, exactly as it would for a new session, and a line is logged. A guard you rewrote can never run against state it would not have allowed, and a state you renamed can never strand a session. The rule is the same in `stator dev` (a save resets the affected machines on their next request) and in production (a deploy resets the machines whose code changed — `stator build` prints which), and it holds for every `Store`.

So anything whose loss would be an incident is a **durable fact**, and durable facts belong in your own database, written by an effect and read back by an entry effect when the machine starts — for a new session, after TTL expiry, and after a reset alike. The entry effect knows *whose* data to load from `meta.session`: the session id and its claims, the same claims middleware reads with [`stator(c).claims()`](/guides/middleware/):

```ts
type Me = { userId: string }

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  context: { items: [] as Item[] },
  initial: 'loading',
  states: {
    loading: {
      // Runs on every fresh start — new session, expired session, snapshot
      // reset — and rebuilds the working copy from the durable cart.
      entry: async (_ctx, meta): Promise<CartEvents> => {
        const me = meta.session?.claims<Me>()
        const cart = me ? await loadCart(me.userId) : null
        return cart ? { type: 'LOADED', cart } : { type: 'EMPTY' }
      },
      on: {
        LOADED: { to: 'ready', do: (ctx, ev) => { ctx.items = ev.cart.items } },
        EMPTY: 'ready',
      },
    },
    ready: {
      on: {
        ADD: {
          do: (ctx, ev) => { ctx.items.push(ev.item) },
          effect: async (ctx, _ev, meta) => {
            await saveCart(meta.session!.claims<Me>()!.userId, ctx.items)
            return null
          },
        },
      },
    },
  },
})
```

With that shape a reset is a cache miss: deploys, restarts, TTL expiry, a flushed Redis, and a second replica all become the same non-event. Effects run after the commit, never inline, so the first render of a fresh machine shows its `loading` state and the `LOADED` completion lands moments later — over SSE on a [live route](/guides/realtime-sse/), or on the next request otherwise. That is the ordinary entry-effect rhythm, and it needs nothing from the client. `meta.session` is set for session machines only; app machines and client islands have none.

`persist: true` app machines follow the same rule: they survive restarts while the machine's code is unchanged. A shared tally or counter that must outlive a code change is a durable fact too.

What resets a machine, precisely: any change to code that can execute as part of it — states, defaults, guards, actions, effects, selectors, and the used exports of anything it imports — plus a framework upgrade. A machine that imports another machine is reset when that machine changes too — an import may carry values (a default mirrored into context), not only identity. What does not reset: comments and formatting, exports nothing in the machine uses, and anything that is not code — environment variables, database contents, config.
