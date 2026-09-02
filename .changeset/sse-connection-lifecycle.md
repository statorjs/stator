---
"@statorjs/stator": minor
---

Live pages now give their SSE connection back when nobody is watching, so open tabs stop exhausting the browser's per-origin connection budget.

A browser never reclaims an idle tab's sockets on its own, and the HTTP/1.1 pool (6 per origin in Chrome) is shared across every tab in the profile — so background tabs spend the budget of the tab you're actually using, and enough of them block *every* request to the origin, not just the live ones. Dev was worse than production: each page held two event-streams, one for the live channel and one for the reload client, wedging a dev session at three tabs.

- A live page releases its channel 30 seconds after its tab is hidden, immediately on `pagehide` (bfcache included) and on `freeze`, and reconnects on visibility, `pageshow`, and `resume`. Reconnect is a full resync, and nothing durable rides the connection — session state is in the store, `after` timers and in-flight effects are process-wide — so a release costs a re-render on return and nothing else.
- `data-stator-connection` gains a fourth value, `idle`, for a deliberate release. Offline banners keyed to `disconnected`/`stale` keep working unchanged, and don't fire on tab switches.
- New `stator:live-message` window event carrying each raw wire envelope, for inspectors and devtools.
- `stator dev` no longer opens a second event-stream on a live page — the rebuild and build-error signals ride the live channel, halving connections per dev tab. Pages without a live channel keep `/__stator_dev`.
- The dev build id is now per build rather than per process, so a page that reconnects after missing a rebuild is told to reload instead of resyncing onto a stale slot map.
- The connection registry evicts a superseded connection from the same page-load, and re-initializing the client's live channel replaces the previous one instead of stacking a second `EventSource` and watchdog beside it.
- **Fixed a server-side leak that predates the rest of this work:** a client that disconnected during the connect-time render — after the connection was registered, but before the handler subscribed to the abort — was never unregistered, holding its `SessionRuntime` and a slice of every fan-out for the life of the process. Hono fires a stream's abort subscribers exactly once, at abort time, so the late subscription simply never ran. A page that opened the channel and immediately navigated away hit this every time, not occasionally.

Served directly over HTTP/1.1 the ~6-per-origin ceiling still applies; behind a TLS-terminating proxy the browser hop is HTTP/2 and streams multiplex over one connection.
