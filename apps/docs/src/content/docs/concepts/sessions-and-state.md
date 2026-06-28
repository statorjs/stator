---
title: Sessions and state
description: "Where state lives between requests, and the per-session lifecycle."
sidebar:
  order: 7
---

Machines are the canonical state — but a machine instance doesn't sit in memory waiting for the next request. This page explains where state actually lives between requests, and the short lifecycle each request runs.

## Stateless between requests

Stator does **not** keep a long-lived actor per session in process memory. That would scale with sessions × routes-visited and foreclose multi-replica deployments. Instead, canonical state lives as snapshots in the [store](/guides/persistence/), and each request spins up only the actors it needs, then throws them away.

This was an early, load-bearing decision: going stateless-between-requests turned out cheaper architecturally than persisting live actors, and every later feature (store adapters, SSE, the future inbox) composes cleanly on top of it.

## SessionRuntime lifecycle

Each request creates a `SessionRuntime` that runs a short, predictable cycle:

1. **Load** — `loadGraph` pulls *only* the machines this request reads from the store and hydrates transient actors from their snapshots. Machines the request doesn't touch are never loaded.
2. **Wire** — cross-machine `subscribes` listeners are rebuilt for this request's actor graph.
3. **Process** — the event runs through the relevant machine's transition; the runtime records which machines were **touched**.
4. **Persist** — `persistTouched` writes the touched session machines back to the store with a refreshed TTL.
5. **Dispose** — every transient actor is stopped; after dispose the runtime is done.

Only touched machines are written, and only read machines are loaded — the request does the minimum I/O its work requires.

## The Store as the swap point

The runtime never talks to Redis or a `Map` directly; it talks to the `Store` interface. That indirection is the swap point: `InMemoryStore` for development, `RedisStore` (optionally behind `CachedStore`) for production, with no change to machines or templates. TTL is applied **per session** — a whole session expires together on inactivity, so a cart never loses individual line items mid-checkout. See [Persistence](/guides/persistence/).

## App machines

`lifecycle: 'app'` machines are the exception to all of the above. They live in process memory for the server's lifetime, shared by every session, and are **not** persisted on touch — a seeded catalog re-seeds on boot. They're loaded once at startup rather than per request.

## The single-replica boundary

Within one replica, concurrent events to the same session are **serialized by a per-session async lock**, so transitions never interleave and corrupt state. This is correct and sufficient on a single replica.

:::caution[1.x]
Scaling past one replica needs a Redis pub/sub backplane over the existing fan-out choke point, and reaching idle or non-connected sessions needs the durable inbox. Both are deferred to [1.x](/introduction/why-stator/#the-10--1x-boundary). The stateless-between-requests shape is specifically what makes that future swap localized rather than a rewrite.
:::
