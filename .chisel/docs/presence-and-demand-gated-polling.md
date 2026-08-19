# Presence & demand-gated server polling (design note, 2026-08-18)

> **Status:** territory note for the ~2.6 presence follow-up. `boot.ts` (2.5) is the poll half; this is the demand half. Not a spec yet — the public presence surface must be designed deliberately before building.

## The itch

Weather drives forecast refresh from the **client** (a `refresh-clock` island ticks `REFRESH` while a tab is visible). It works and is demand-aware, but it's a hack: cadence policy lives in the browser, and the server is passive. The wanted shape: the **server** keeps prediction data fresh on a regular poll, but **only for locations a live session is watching** — and stops the moment the last watcher disconnects. A cold location on connect is warmed before responding, or served stale then updated over SSE.

## Why `boot.ts` alone isn't enough

`boot.ts` gives the server-lifetime poll loop. The missing piece is **demand**: which entities have live watchers right now.

For weather, demand is **session-scoped and not addressable**: weather is a single route (`GET /`), and "which locations" lives in each session's `WeatherMachine.places`, not the URL. So the watched-set = ∪ `places` over sessions with a live SSE connection.

The framework already holds the raw material — the SSE registry is a `Map<string, Connection>`, and each `Connection` carries `sessionId`, `routeKey`, and the session's live `runtime` (with `WeatherMachine` loaded, since the route reads it). But the only public accessor is `activeConnectionCount()`. **The missing primitive is a presence read into the live-connection set.** This is the roadmap's presence/connection-lifecycle gap — planning-poker was the scout; weather is the second, stronger evidence point.

## Feasibility (verified against the code)

- **Poll only watched locations** — boot poll derives the watched-set from live connections each tick → `dispatchToApp(ForecastCache, REFRESH{watched})`. `ForecastCache`'s existing staleness guard drops fresh ones; existing fan-out pushes `LOADED` patches to watchers over SSE. No cache changes needed.
- **Stop on disconnect** — the connection leaves the registry (`unregisterConnection` on abort; the zombie-watchdog catches silent drops). Derive-each-tick → its places drop from the set next tick. Automatic, nothing to reconcile.
- **Cold-on-connect** — already handled: `WeatherMachine`'s entry effect dispatches `REFRESH` for its places on view. "Warm-before-respond" (await in a `defer`) and "stale + SSE" (render cached, poll catches up) are both expressible; weather does the latter.

## The design fork (where demand comes from)

- **A — derive-from-truth each tick (preferred).** Presence read exposes the live connections; boot unions each session's watched entities per tick. Robust: demand is recomputed from ground truth, so disconnects self-heal and there's no refcount to drift on a crash. Cost: reads N sessions' state per tick (fine at weather scale).
- **B — event-sourced refcounts.** Framework fires connect/disconnect events; an app machine keeps `watchers[entity]`. Cleaner poll but refcounts drift on crashes, and at connect-time the framework can't know the watched entities (session state) anyway — the app still maps connection→entities.
- **C — demand-TTL window.** Cache ages out entities not re-`REFRESH`ed within a TTL. Avoids the registry read, but needs a periodic "still here" signal — which is the client tick again. Reintroduces the hack.

**A wins:** demand *is* connection-liveness, so tie it to the registry, not to events or heuristics.

## Open surface questions (the spec's job)

- **Shape of the presence read.** Minimal `activeConnections(): { sessionId, routeKey, params }[]` doesn't give weather its `places` (session-machine state). Options: (a) expose a way to read a watched machine per connection (the connection already holds the loaded `runtime` — but leaking `runtime` is ugly); (b) a server-side "read session machine by id" helper; (c) have the app declare a per-connection "watched projector" the framework calls. (c) is the most machinery / bind-family risk; (a)/(b) are thinner.
- **Cost control** at scale — reading many sessions per tick. Cache the derivation between ticks? Bound it?
- **Does this stay app-derived, or does the framework grow a first-class "watched-set"?** Keep it a read + app-derivation (per the machine-self-containment principle) unless evidence demands more.

## Non-goals / guardrails

- Don't build declarative `clock()`/`source()` primitives (still deferred — bind-family caution).
- Keep demand derivation in the app where possible; the framework contributes the *presence read*, not a "polling manager."
- Ships as its own minor (~2.6), spec-first — presence is a durable public surface.
