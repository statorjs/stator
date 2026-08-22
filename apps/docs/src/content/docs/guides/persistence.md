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

## What persists

Only `lifecycle: 'session'` machines are stored through the session `Store`. App machines live in process memory and re-seed on boot unless they opt in with `persist: true`, which saves them through the `AppStore` — see [Sessions and state](/concepts/sessions-and-state/).

## What survives a deploy

Machine state is **working state with a TTL, not persistence**. Stator keeps a session's machines across requests, live connections, and deploys that leave their code untouched, and lets them go when the session expires, when a server with no configured store restarts, or when the machine's code has changed.

That last rule is the one to design around: **sessions never outlive the code that made them.** Every persisted snapshot carries a hash of the machine's code — the machine file and every module it reaches, tree-shaken — and a snapshot whose hash no longer matches the running machine is discarded at the next hydration. The machine starts fresh, exactly as it would for a new session, and a line is logged. A guard you rewrote can never run against state it would not have allowed, and a state you renamed can never strand a session. The rule is the same in `stator dev` (a save resets the affected machines on their next request) and in production (a deploy resets the machines whose code changed — `stator build` prints which), and it holds for every `Store`.

So anything whose loss would be an incident is a **durable fact**, and durable facts belong in your own database, written by an effect and read back when the machine starts:

```ts
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  context: { cartId: null as string | null, items: [] as Item[] },
  initial: 'idle',
  states: {
    idle: {
      on: {
        // The client holds the cart token (a cookie or localStorage) and
        // dispatches RESUME on load — so a fresh machine, new session or
        // post-reset, finds its durable cart.
        RESUME: {
          to: 'loading',
          do: (ctx, ev) => { ctx.cartId = ev.cartId },
        },
      },
    },
    loading: {
      entry: async (ctx): Promise<CartEvents> => {
        const cart = await loadCart(ctx.cartId!)
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
          effect: async (ctx) => { await saveCart(ctx.cartId!, ctx.items); return null },
        },
      },
    },
  },
})
```

With that shape a reset is a cache miss: deploys, restarts, TTL expiry, a flushed Redis, and a second replica all become the same non-event. The key has to come from outside the snapshot — the snapshot is what a reset throws away — which today means the client sends it. Keying by the session's identity on the server (claims in the entry effect, no client round trip) is where this is going.

`persist: true` app machines follow the same rule: they survive restarts while the machine's code is unchanged. A shared tally or counter that must outlive a code change is a durable fact too.

What resets a machine, precisely: any change to code that can execute as part of it — states, defaults, guards, actions, effects, selectors, and the used exports of anything it imports — plus a framework upgrade. What does not: comments and formatting, exports nothing in the machine uses, other machines (a machine importing a sibling only for identity keeps its own hash), and anything that is not code — environment variables, database contents, config.
