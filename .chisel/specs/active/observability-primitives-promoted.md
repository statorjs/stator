---
title: Observability primitives, promoted
status: draft
created: 2026-05-20
updated: 2026-05-20
area: protocol
---

## What and Why

The framework already dispatches three `CustomEvent`s on `window` at protocol edges: `stator:event-sent`, `stator:patches-received`, `stator:patch-applied`. They exist today because the demo inspector needed them. They earned their place as the cleanest primitive on the page — each event has one job, no framework coupling, observable from any script.

Today they're labeled "stable contract" in the README but are practically positioned as "what the demo inspector listens to." The why behind promoting them: a future devtools (Chrome extension, TUI inspector, telemetry exporter, framework-level tracing) shouldn't have to discover these events by reading the inspector source. They're an observation primitive in their own right, and naming them as such opens the door for tooling that doesn't exist yet.

Server-side has nothing equivalent today, only `pino` request log lines. The promotion should also fill that gap.

## Success Criteria

- Three client-side `CustomEvent`s are documented as the canonical observation contract, with a version field on the contract.
- The contract is documented separately from the inspector. The inspector references it; the framework owns it.
- Server-side equivalent: a small set of hook points (`onEventReceived`, `onDispatchCompleted`, `onPatchesEmitted`, `onConnectionOpened`, `onConnectionClosed`) that third parties can subscribe to without forking the framework.
- A worked example: a minimal "console exporter" that subscribes to both client and server hooks and emits structured JSON. Demonstrates the contract is sufficient to reconstruct framework traffic externally.

## Constraints

- Client-side hooks stay `CustomEvent`-shaped. Don't introduce a custom framework-specific subscription API where the platform already has one.
- Server-side hooks are simple `(event) => void` listeners registered with the framework instance. No fancy filtering DSL. Subscribers do their own filtering.
- Backwards compatibility for the existing three client events. The version field can be added, the shape can grow (new fields are fine), but existing keys don't change.
- Don't change protocol behavior to make observation easier. The hooks describe what the framework already does. If observing it requires extra work, that work is invisible to the framework's semantics.

## Approach

**Client-side**:

- Existing three events stay as-is.
- Add `version: '1'` to each detail payload so consumers can negotiate.
- Document in `WIRE.md` (or a dedicated observability section).
- Add `stator:connection-opened` / `stator:connection-closed` for SSE connection lifecycle.

**Server-side**:

- `createApp({ ..., observers: [observer1, observer2] })` accepts an array of observer instances.
- An observer is `{ onEventReceived?, onDispatchCompleted?, onPatchesEmitted?, onConnectionOpened?, onConnectionClosed? }`. Optional methods; the framework calls only what's defined.
- Hooks called at the same protocol edges the client-side events fire. Symmetry.
- Errors thrown by observers are caught and logged; they don't break the request.

**Worked example** lives in the example app: a small `obs/console-exporter.ts` that registers an observer and subscribes to the client events, printing both sides in a unified format. Demonstrates feature parity client-to-server.

## Alternatives Considered

- **OpenTelemetry-shaped instrumentation.** Considered. Rejected for now because OTel is a heavy spec and the framework's hooks would need to map onto its spans/traces model. Better to start with primitives and ship a separate "otel exporter" package later if anyone wants one.
- **Promote only the client side.** Rejected because the asymmetry is the bug. Anyone building real devtools wants both sides.
- **Framework-shipped inspector module.** Rejected. The hooks are the framework's job; building the UI is consumer work. The example app's inspector is one such consumer.

## Open Questions

- Versioning policy when the protocol grows. Adding `target: 'prop'` (or other reserved ops) doesn't break observers; adding a new event type might. The simplest answer: events have a stable name and detail shape; new events have new names; existing details only grow additively.
- Filtering controls. A high-traffic server with verbose observers could burn CPU. The framework shouldn't try to optimize this; observers that care can sample themselves.
- Whether `stator:dispatch-completed` (a client event corresponding to `onDispatchCompleted`) is worth adding. The current `stator:patches-received` is close to this, but doesn't include cross-machine cascade information. Probably yes, post-MVP.

## Implementation Notes

(The three client-side events exist today; this spec is about promoting and extending them.)
