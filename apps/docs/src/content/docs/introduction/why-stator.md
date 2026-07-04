---
title: Why Stator
description: "The problems Stator solves, the tradeoffs it makes, and when (not) to reach for it."
sidebar:
  order: 2
---

Stator exists because the dominant way we build interactive apps — canonical state in the browser, mirrored to the server — creates a class of problems that never fully go away. Stator makes the server's state canonical and gives the client a precise, declared window into it.

## The problem

Client-canonical architectures share three recurring costs:

- **State drift.** The same fact lives in two places (client store and server database), and keeping them honest is a permanent tax — optimistic updates, refetching, cache invalidation, reconciliation bugs.
- **Hydration cost.** The server renders HTML, then the client re-renders the same tree to "attach" behavior, shipping and executing a component runtime to do it.
- **Invisible boundaries.** Which code runs where is encoded in conventions (`"use client"`, file location, framework magic) that are easy to get subtly wrong and hard to see when reading a file.

## How Stator answers it

- **One canonical state.** A machine is the single source of truth. There is no second copy to reconcile; the client holds no authoritative state unless you deliberately put it in an island.
- **Explicit reads.** A node says exactly what state it shows with `read(machine, selector)`. Nothing is auto-tracked, so what updates — and why — is legible from the template.
- **A boundary you can see.** Where a machine runs is decided by where you import it: in a `.stator` file's frontmatter (server) or its `<script>` (client). The compiler checks that a machine using a server-only capability never ends up on the client.

## Tradeoffs you accept

Stator is opinionated, and the opinions cost something:

- **A server round-trip for server-state events.** Changing canonical state is a request. For server-authoritative apps this is correct; for state that should be instant and local, you use a client island instead.
- **Explicit `read()` over auto-tracking.** You declare dependencies rather than having them inferred. More to type, far less to debug.
- **No client-side JSX re-render.** The browser does not re-run your template. DOM creation in the browser happens through native APIs inside a client component, never a render loop.

## When to use Stator

Stator is a strong fit when:

- State is **server-authoritative** — carts, dashboards, admin tools, multi-step flows, anything backed by a database or shared across a session.
- You want **fine-grained updates** without owning a client state-management stack.
- You value a **readable, statically analyzable** boundary between server and client.

## When not to (yet)

:::caution[Not a fit today]
Reach for something else if you need heavy **offline / local-first** behavior, must run **multi-replica from day one**, or depend on **deep statechart features** (nested/parallel states, history, invoked actors). These are 1.x considerations or out of scope.
:::

## The 1.0 / 1.x boundary

What ships in 1.0:

- The custom isomorphic engine (with [async effects](/guides/effects/)), typed machine-mediated dispatch, the `.stator` compiler, server rendering with slot patches, [keyed lists](/guides/keyed-lists/), client islands with a [production build](/guides/production/), file-based routing, API routes, per-session persistence (in-memory or Redis), [opt-in app-machine persistence](/guides/app-machines/), server-originated dispatch for webhooks and cron, and **opt-in SSE with cross-session fan-out on a single replica**.

What is deferred to 1.x:

- **The durable inbox** — app→session delivery and reaching sessions with no open connection.
- **Horizontal scaling** — a Redis pub/sub backplane over the existing fan-out choke point.
- **Statechart richness** — nested/parallel/history/invoke; 1.0 ships flat machines with extension points.

## Where to go next

- [The mental model](/introduction/mental-model/) — the whole model in one read.
- [Quick start](/introduction/quick-start/) — see it run.
