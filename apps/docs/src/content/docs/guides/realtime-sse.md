---
title: Realtime with SSE
description: "Opt a route into server-sent events for live, cross-session updates."
sidebar:
  order: 10
---

Most pages are fine with request/response: your POST patches your view. Opt into SSE only when a page must reflect changes it didn't initiate.

## Opt a route in

Add a pragma to a `.stator` route's frontmatter (or `live: true` on a `.ts` route's `defineRoute`):

```astro
---
// @stator live
---
```

Stator injects a live marker; the client opens **one** `EventSource` for the route. No client code required.

## Cross-session fan-out

When any session changes a machine the route reads, the server recomputes the affected bindings and pushes the [patches](/concepts/rendering-and-patches/) to **every** open connection on that route — not just the originating session. The patch shape is identical to a POST response; only the transport differs.

## What is / isn't realtime

- **Opt-in** — a route is static request/response until `// @stator live`.
- **Reconnect = reload** — a dropped connection re-renders; there's no missed-event replay.
- **Single-replica** — fan-out is in-process.

:::caution[1.x]
Multi-replica fan-out (a Redis pub/sub backplane) and the durable inbox (reaching idle/non-connected sessions, server-originated transitions) are deferred to [1.x](/introduction/why-stator/#the-10--1x-boundary). On one replica, live cross-session display updates work today.
:::
