---
title: Cross-machine event delivery model
status: draft
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

Today's framework has two cross-machine event paths emerging organically:

- **Same-session**: in-process `actor.on` listeners across co-resident transient actors. Synchronous, microseconds.
- **App→session and cross-replica**: don't exist. Validated against at boot.

The why behind picking a model now: the cross-machine fan-out problem already bit us in the demo (the multi-machine Fly issue). The architectural answer is some form of inbox-mediated delivery. The question is whether the inbox replaces same-session delivery or just augments it for the cases the in-process path can't handle.

This decision shapes the V1 architecture more than any other single choice. Getting it written down with the tradeoffs explicit is worth more than rushing to a conclusion.

## Success Criteria

A decision committed before the inbox starts being implemented. Measurable enough to choose: a target latency budget for the same-session cross-machine cascade, and a target for cross-replica delivery.

## Constraints

- Whatever ships must preserve "by the time my request's event runs, my session reflects everything the app has told it about." Inbox-first ordering when a request hydrates a session with queued events.
- Drain to quiescence: a drained event can transition the receiver, which emits, which routes to another inbox. Loop until no new entries for any loaded receiver.
- At-least-once delivery for inbox-mediated paths. Receivers must tolerate re-delivery. Idempotent event handlers are documented as a contract.
- The Store interface stays simple. Inbox primitives extend it rather than replacing the existing four methods.

## Approach

Two options on the table.

### Option A: dual path (current behavior, formalized)

Same-session in-process listeners stay. App→session adds an inbox.

- Source emit fans out to every subscriber-session's inbox: `Store.appendInbox(sid, receiverName, event)` per subscriber.
- Inbox drains on next hydration of that session, before the primary event runs.
- Active sessions enumerated via `Store.listSessions(receiverName)`.

Pros:
- Same-session keeps microsecond latency.
- App→session and offline-session cases handled cleanly.

Cons:
- Two delivery mechanisms to reason about, document, and debug.
- The co-residency constraint (`loadGraph` over-fetches because session→session subs must be co-resident) doesn't go away.
- Subscribers can't reason about which path delivers their event without tracing the load graph.

### Option B: universal inbox

All cross-machine events route through the Store inbox. Same-session included.

- `loadGraph` no longer over-fetches. It pulls only what the request directly reads.
- Inbox drain happens at every render/persist boundary. Co-resident receivers' inboxes drain in the same request.
- Non-co-resident receivers drain on next hydration.

Pros:
- One mechanism. Schema, dev tools, telemetry all point at one place.
- Co-residency constraint dissolves.
- Future-scaling features (retries, dead-letter queues, distributed delivery) fold in without architectural change.

Cons:
- Same-session events take Store round trips. On `InMemoryStore` that's fine (Map ops); on Redis it's a few ms each.
- Drain-to-quiescence per dispatch step adds Store traffic proportional to cascade depth.

## Alternatives Considered

- **Per-machine `delivery` flag** (`subscribes: [{ ..., delivery: 'inline' | 'inbox' }]`). Adds API surface without clear benefit. Single delivery semantics > a knob.
- **Topic indexing** instead of per-session enumeration. Slightly different shape of the same idea. The publisher path's primitive is "list subscriber sessions for this source"; that primitive exists either way. Topic indexes are an optimization; not part of the choice.

## Open Questions

- The deciding factor between A and B is whether Option B's extra Store traffic is observable. The measurement plan:
  1. Implement cart-clear-on-checkout under both options against `InMemoryStore`.
  2. Measure end-to-end POST `/__events` latency for `SUBMIT_PAYMENT`.
  3. If Option B adds < 5ms in dev, ship it. Architectural cleanup wins.
  4. If Option B adds > 15ms (orchestration overhead dominating), keep A and document the dual-path rule.
  5. Re-measure under real Redis. Redis hops will shift the picture significantly.
- Inbox storage shape: per-session-per-receiver, or per-session global with receiver-dispatch at drain time? Per-receiver is cleaner for fan-out indexing.
- TTL on inbox entries vs. session TTL. Offline sessions grow inboxes unboundedly. Probably adapter-level: drop entries older than N days at drain time, or sweep.
- Cycle detection: subscription cycles are caught at boot from declarations. Runtime fan-out cycles (state-dependent emit loops) are bounded by an iteration cap on drain-to-quiescence.

## Implementation Notes

(Not yet implemented.)
