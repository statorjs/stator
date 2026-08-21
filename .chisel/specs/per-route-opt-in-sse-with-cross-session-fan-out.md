---
title: Per-route opt-in SSE with cross-session fan-out
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

The framework's default transport is POST request/response. That's enough for the cart and checkout flows because every state change is initiated by the user whose view needs to update. But the admin dashboard breaks that pattern: state changes are caused by other sessions, and the viewer needs to see them without polling.

SSE earns its place specifically for this case. We're not adding push because push is fashionable, we're adding it because there's a class of UI that's structurally impossible without it.

The why behind making it opt-in rather than automatic: an SSE connection costs a held file descriptor, a per-connection runtime, and a slot map in memory. A marketing site with 10,000 concurrent users on a Cyber Monday peak would hold 10,000 idle SSE connections if every page opened one. Most pages don't need push. The ones that do should say so explicitly.

## Success Criteria

- Routes declare `live: true` to opt in.
- Pages that don't declare it never open an EventSource. Their POST responses cover their own updates.
- When any session's action mutates a machine, every connection whose route reads that machine receives a patch push.
- The push patch shape is identical to the POST response patch shape. The client applies them with the same code.
- The viewer's own POSTs to the same session don't double-update (their POST response already applies the patches).

## Constraints

- One EventSource per live page. No multiplexing.
- Per-connection runtime + slot map lives for the connection's lifetime. This is the one place per-session state outlives a single request. Acceptable because the connection *is* a long-running request.
- Connection registry is in-process. Cross-machine fan-out across replicas is V1 work (needs Redis pub/sub or equivalent). Until then, the demo runs as a single Fly machine.
- Reconnection strategy is `location.reload()`. Server has no record of what the client last saw across a reconnect. V1 is Last-Event-ID-based diff.

## Approach

`defineRoute` accepts `live: boolean`. When a route is marked live, the rendered HTML gets a `<meta name="stator-live" content="true">` injected. Client runtime opens an `EventSource('/__sse?route=GET%20%2Fadmin')` only when that meta is present.

Server-side, `/__sse` is a streaming endpoint. The handler creates a `SessionRuntime` for the connection, hydrates the route's reads, renders once to populate a `RenderState` with `lastValue` baselines, and registers the connection in an in-process `Map<connId, Connection>`. The runtime and slot map stay alive until the stream closes.

After every POST event handler completes its own work, it calls `fanOut(touched)`. This iterates open connections, filters by `route.reads ∩ touched`, recomputes against each connection's slot map, and sends the resulting patches over the event stream. Each connection's `lastValue` is updated, so subsequent pushes diff correctly.

Initial flush (`': open\n\n'`) and keep-alive (`': keep-alive\n\n'` every 25s) handle edge-proxy quirks. `X-Accel-Buffering: no` prevents proxy response buffering.

## Alternatives Considered

- **Auto-open on every page.** Rejected. Connection cost compounds at scale (Cyber Monday math); most pages don't benefit; opt-in matches the explicit-declaration philosophy everywhere else in the framework.
- **WebSocket transport.** Rejected for the POC. SSE is simpler operationally, works through more network configurations, doesn't need a separate connection-upgrade dance, and has built-in browser reconnect. WebSocket revisits when bidirectional push becomes a real need.
- **Long-poll.** Rejected. Held connections without keep-alives are fragile across proxies; SSE solves the long-held-stream case with battle-tested semantics.
- **Reconnect with diff.** The honest V1 answer. Today's reload strategy is acceptable for the demo (real reconnects are rare with single-machine + keep-alives) but loses state correctness in pathological cases.

## Open Questions

- Multi-replica fan-out. The current in-process connection registry means a POST landing on machine A doesn't notify connections on machine B. Demo runs at `max_machines_running = 1` to dodge this. V1 needs Redis pub/sub (or similar) to broadcast touched-machines across replicas. The inbox spec ties into this.
- Connection-shared runtime vs per-tab runtime. If the same session has two tabs both on /admin, each opens its own EventSource and gets its own runtime. The runtimes don't share state (they re-hydrate from the Store each time), so it works correctly, but it's wasteful for the same-session case. Open whether to coalesce.

## Implementation Notes

Shipped. The biggest implementation discovery was the deployment gotcha: Fly was auto-scaling to two machines and load-balancing POSTs across them, so a POST landing on machine A would fan out to A's connections only — and the admin tab was on B. Manifested as "30-50% of events delivered." Fix was pinning `max_machines_running = 1` until V1 cross-replica fan-out lands.

Other deployment-side fixes worth keeping: initial flush forces proxy header commit, keep-alive prevents idle-timeout connection closes, `X-Accel-Buffering: no` disables response buffering.

The client side is unchanged from the POST applier; SSE messages decode to the same patch shape and feed the same `applyPatches`. The wire format paying for itself.