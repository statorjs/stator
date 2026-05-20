---
title: Inspector and observability hooks
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

Two related problems, one solution.

The demo's distinctive properties (slot-addressed patches, per-route SSE, no full re-renders) are invisible by default. Someone playing with the cart sees the same DOM update they'd see in any framework. The architecture's value lives in the wire traffic, and the wire traffic lives in the network tab. That's a high friction barrier for someone evaluating the framework.

The other problem: future devtools, framework integrations, and third-party telemetry all need an observation surface that isn't "monkey-patch the client runtime." Without explicit hooks, anyone wanting to plug in gets stuck doing fragile things.

One solution fixes both. The framework dispatches a small set of `CustomEvent`s on `window` at the protocol edges. The demo's inspector subscribes to them and renders an in-page log. Any future tooling can subscribe to the same events without coordination.

## Success Criteria

- Three events fire on `window` at fixed lifecycle points: `stator:event-sent`, `stator:patches-received`, `stator:patch-applied`.
- Each carries enough detail in its `detail` payload to fully reconstruct the framework's protocol traffic.
- The demo includes a visible inspector that subscribes to those events and shows them in an in-page drawer.
- Slot flash highlights the DOM element a patch hit, color-coded by op.
- The hooks are documented as a stable contract, not an inspector implementation detail.

## Constraints

- The hooks live in the framework's client runtime. The inspector lives in the example app. The framework can't ship an inspector, only the surface a third party would use to build one.
- `CustomEvent` on `window`. Standard, observable from any script, no framework coupling.
- Events fire whether or not anyone is listening. The cost of an unconsumed dispatch is one allocation and one no-op event bubble.
- Don't change protocol behavior to make observation easier. The hooks describe what the framework already does.

## Approach

Three events:

- `stator:event-sent` — before each event POST. Detail: `{ machine, event, routeKey, timestamp }`.
- `stator:patches-received` — after a patch batch parses, before apply. Detail: `{ patches, source: 'post' | 'sse', durationMs?, timestamp }`. The `source` discriminator lets a consumer distinguish POST-response patches from SSE pushes; `durationMs` is round-trip time for POSTs and absent for pushes (the framework doesn't time those).
- `stator:patch-applied` — once per patch, after applying. Detail: `{ patch, element, timestamp }`. `element` may be null if the patch target id didn't resolve.

`window.dispatchEvent(new CustomEvent(name, { detail }))` at each call site in `client/runtime.ts`. Total surface: ~10 lines plus three event constants.

The inspector (`apps/example/static/inspector.js`) is a plain vanilla JS module loaded by the base layout. It subscribes to the three events, maintains a bounded log (40 entries), renders a bottom-fixed drawer with one row per event, supports expand-to-JSON, and toggles a brief CSS animation class on patched elements for slot flash.

## Alternatives Considered

- **Console logging only.** Considered (it's what most frameworks do). Rejected because the value of the demo is making the wire traffic visible, not buried in devtools. A dedicated in-page surface earns its space.
- **Inside-framework inspector UI.** Considered shipping the inspector as part of the framework. Rejected because UI in the framework is scope creep. The hooks are the framework's job; the UI is a consumer.
- **Single `stator:traffic` event** with a discriminator on `detail.kind`. Rejected because three named events are clearer at subscribe sites, and modern browsers dispatch them just as cheaply.
- **Imperative listener API** (`stator.onEvent(cb)`). Rejected because `CustomEvent` is the platform's existing answer to this problem and doesn't require a framework reference to use.

## Open Questions

- Should `patches-received` fire before or after `applyPatches`? Currently it fires before, so subscribers see incoming patches even if they crash the applier. Both orderings are defensible. The choice is documented; not seen as fragile.
- Server-side equivalent hooks (per-event server log lines) are partially covered by `pino` request logging. A more structured server-side equivalent (e.g., `stator:dispatch-completed` with touched-machines) would complete the picture. Not urgent.

## Implementation Notes

Shipped. The non-obvious payoff: this turned out to be the cleanest primitive on the page. Each event has one job, no framework coupling, observable from any script. The inspector that uses them is unambiguously *consumer* of the framework, not part of it.

Worth promoting from "the inspector listens to these" to "this is the observation contract." Doing so makes future devtools (a real Chrome extension, a TUI inspector, a telemetry exporter) all plug into the same surface.