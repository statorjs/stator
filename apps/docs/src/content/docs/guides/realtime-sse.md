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
- **Reconnect = resync** — a dropped, released, or stale connection reopens and the initial sync converges the page in place (`data-stator-connection` on `<html>` tracks the transitions). There's no missed-frame replay: the channel carries state, and the resync is what makes any gap in it recoverable.
- **Idle pages let go** — a live page releases its connection 30 seconds after its tab is hidden, and on `pagehide`/`freeze`; it reconnects and resyncs on the way back. Browsers hold a hidden tab's sockets open indefinitely, and the HTTP/1.1 pool is per *origin per profile* (6 in Chrome), so background tabs otherwise spend the budget of the tab you're actually looking at until every request to the origin blocks. Nothing durable rides the connection — session state lives in the store, `after` timers and in-flight effects are process-wide — so a release costs a re-render on return, nothing more. The released state is `idle`, distinct from the fault states, so offline banners don't fire on tab switches.
- **Reconnect to a new build = reload** — the one exception to resync. Each page carries the build it was rendered against; if it reconnects to a server running a newer build (a dev restart, or a production deploy), the page hard-reloads instead of resyncing onto a slot map that may no longer match. In production the id is per *build*, so a crash-restart of the same build doesn't reload anyone — only an actual deploy does.
- **One connection per visible live tab** — served directly over HTTP/1.1, a browser allows about 6 connections per origin, so a handful of live tabs can exhaust the pool for that origin. Put a TLS-terminating proxy in front (Fly, Traefik, nginx, Cloudflare) and the browser hop is HTTP/2, where streams multiplex over one connection and the limit stops mattering. The release policy above is what keeps the HTTP/1.1 case workable, including in `stator dev`.
- **Single-replica** — fan-out is in-process.

:::caution[Single replica]
Multi-replica fan-out (a Redis pub/sub backplane) and the durable inbox (reaching idle/non-connected sessions, server-originated transitions) are [deferred](/introduction/why-stator/#what-ships-and-whats-deferred). On one replica, live cross-session display updates work today.
:::
