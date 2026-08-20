---
title: POC runtime model
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

The first thing Stator had to prove was that state-machines-as-the-unit-of-composition could survive contact with a real request lifecycle, not just a unit test. The POC nails down the runtime model that everything else compounds on: how machines come to life, how a request flows through them, where state lives between requests, and what the client actually receives over the wire.

The why is structural. Most frameworks that gesture at "state machines" treat them as a library inside the component tree. Stator inverts that. Machines are the canonical state, templates read from them, events are how anything changes. If that model can't handle a normal CRUD flow end-to-end, the rest of the framework doesn't matter.

## Success Criteria

- A cart can be added to, modified, and cleared from a single browser session.
- Session state survives navigation between pages.
- Each event POST produces a small JSON patch list that updates only the affected DOM positions.
- A new template can be added without touching framework code.
- The framework's own source can be read in one sitting.

## Constraints

- Wrap XState v5 rather than building a custom state-machine implementation. The framework still gets its own surface (`defineMachine`) so the user-facing shape is ours, but XState handles state graphs, transitions, guards, actions, and emit. **(Superseded post-POC: XState was later replaced by a hand-written isomorphic engine to get type-safe events end-to-end and a readable client runtime — see [[custom-isomorphic-state-machine-engine]]. The `defineMachine` surface this POC established carried over unchanged.)**
- File-based discovery for machines and routes. One source of truth per machine, declared dependencies via `reads:`, no decorators, no implicit context propagation.
- Templates as tagged template literals. No compiler in the POC. The SFC compiler is V1 work.
- HTTP transport only. SSE is a separate concern handled by a different spec.

## Approach

Per-request actors with persistent state via a Store. Each request creates a `SessionRuntime` that selectively hydrates the machines it needs from the Store, processes the event under a dispatch context, persists the touched machines back to the Store, and disposes everything before returning. App-lifecycle machines are the exception: they live in the process for the duration of the server.

The dispatch context carries the runtime and touched-machines set so actions, guards, and cross-machine subscription listeners can resolve `reads:` proxies and record what got mutated. Recompute walks bindings registered during the route's render pass, diffs against `lastValue`, and emits patches.

The wire format is documented separately. The runtime's job is to produce patches, the format is its consumer.

## Alternatives Considered

- **Long-lived session actors in process memory.** Cheapest, fastest, and what the original spec implied. Rejected because it scales O(sessions × routes-visited) in process memory and forecloses on multi-replica deployments. We pulled the V1 Store adapter forward to get bounded memory and a clean swap target.
- **Custom state-machine implementation.** Considered for control over the surface area. Rejected for the POC because XState is mature and the value of writing one ourselves only shows up once we want type-safe events end-to-end, which is V1 work anyway.

## Open Questions

- The eager-instantiation behavior (hydrating subscription targets even when the request doesn't directly read them) is the right shape for the current model but may want revisiting once the inbox lands. Tracked in the cross-machine event delivery spec.
- Concurrent events to the same session are serialized via a per-session async lock. Works at single-replica scale, but the inbox model is the answer at multi-replica.

## Implementation Notes

Shipped. The runtime model held up through every subsequent feature without rework. The single biggest learning was that going stateless-between-requests is cheaper architecturally than persisting actors. The follow-on work (Store adapters, SSE, inbox) all compose cleanly with this shape.