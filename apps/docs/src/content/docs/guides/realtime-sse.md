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
- **Reconnect = resync** — a dropped or stale connection reopens and the initial sync converges the page in place (`data-stator-connection` on `<html>` tracks the transitions). There's no missed-frame replay; directives fired during the outage (e.g. a `navigate`) are not re-delivered.
- **Single-replica** — fan-out is in-process.

:::caution[Single replica]
Multi-replica fan-out (a Redis pub/sub backplane) and the durable inbox (reaching idle/non-connected sessions, server-originated transitions) are [deferred](/introduction/why-stator/#what-ships-and-whats-deferred). On one replica, live cross-session display updates work today.
:::
