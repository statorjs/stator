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
- **Reconnect to a new build = reload** — the one exception to resync. Each page carries the build it was rendered against; if it reconnects to a server running a newer build (a dev restart, or a production deploy), the page hard-reloads instead of resyncing onto a slot map that may no longer match. In production the id is per *build*, so a crash-restart of the same build doesn't reload anyone — only an actual deploy does. Behind a CDN that is still serving the old page, the reload brings the old build back; the tab then waits (5 seconds, then longer, up to a minute) and tries again instead of reloading in a loop, with no connection held and `data-stator-connection="stale"` on `<html>` until the new page arrives.
- **A layout that no longer matches = reload** — the other exception. Slot ids are positional, so a plain `{x ? … : …}` or `{x && …}` that holds bindings, or sits ahead of them, fixes the ids of everything after it at render time. When the value behind it changes under an open page (signing in or out in another tab, going Back to a page from before sign-in, a machine value copied into a frontmatter `const`), the server's next render addresses different elements than the page holds. Every page carries a fingerprint of its top-level bindings (`<meta name="stator-layout">`) and echoes it when it connects and when it sends an event; on a mismatch the server sends no patches and the page reloads once. An event sent from such a page still commits, and the reloaded page shows its result. Pages that are not live are covered too. A branch written as `when(read(machine, …), …)` is part of the page's live state: it swaps by patch and never needs the reload, so that is where a branch on session or machine state belongs.
- **One connection per visible live tab** — served directly over HTTP/1.1, a browser allows about 6 connections per origin, so a handful of live tabs can exhaust the pool for that origin. Put a TLS-terminating proxy in front (Fly, Traefik, nginx, Cloudflare) and the browser hop is HTTP/2, where streams multiplex over one connection and the limit stops mattering. The release policy above is what keeps the HTTP/1.1 case workable, including in `stator dev`.
- **Single-replica** — fan-out is in-process.

:::caution[Single replica]
Multi-replica fan-out (a Redis pub/sub backplane) and the durable inbox (reaching idle/non-connected sessions, server-originated transitions) are [deferred](/introduction/why-stator/#what-ships-and-whats-deferred). On one replica, live cross-session display updates work today.
:::
