---
title: App-to-session subscriptions via inbox
status: draft
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

The current framework enforces same-lifecycle subscriptions (session→session, app→app). Session→app was added when AdminMachine landed. The remaining direction — app→session — is blocked at boot validation with a deliberate error message pointing here.

The why: app-lifecycle machines that need to broadcast to all sessions are a real pattern. A FeatureFlagsMachine updates and every cart re-evaluates promotions. A MaintenanceModeMachine toggles and every session shows a banner. An InventoryMachine records a stockout and every cart with that product checks availability.

The synchronous in-process listener model has no answer to "which session?" because the source actor lives above any specific session. The inbox model is the answer. This spec covers the inbox specifically for app→session; the broader decision about whether to unify all delivery is in the cross-machine event delivery model spec.

## Success Criteria

- An app-lifecycle machine can declare emits, and a session-lifecycle machine can subscribe to them.
- When the app source emits, the event lands in every active subscriber-session's inbox.
- On next hydration of a subscriber session (request or SSE push), inbox events drain before the primary event runs.
- Receivers see ordinary events through their normal transition path. Inbox delivery is indistinguishable from a regular `actor.send` at the receiver.
- The boot-time validation error for app→session subs goes away.
- Receivers tolerate at-least-once delivery (idempotent handlers, documented contract).

## Constraints

- Inbox storage is an extension of the Store interface. New primitives: `appendInbox`, `drainInbox`, `listSessions`, `deleteInbox` (implied by `deleteSession`).
- Per-session FIFO. Within a single receiver's inbox, events drain in append order. No global ordering across receivers.
- Subscription declarations stay receiver-side (matches the existing model). The boot-time same-lifecycle constraint drops the app→session check.
- Offline sessions grow inboxes. TTL is an adapter responsibility. The framework's contract is "drain returns entries in append order; entries may be dropped by the adapter per retention policy."

## Approach

**Storage primitives** (extending `Store`):

- `appendInbox(sid, receiverName, event): Promise<void>` — atomic append.
- `drainInbox(sid, receiverName): Promise<Event[]>` — atomic read-and-clear.
- `listSessions(receiverName): AsyncIterable<sid>` — every session that has at least one entry for that receiver. Used by the publisher to enumerate.
- `deleteInbox(sid)` — implied by `deleteSession`.

**InMemoryStore**: trivial Map operations.

**RedisStore**: lists keyed `stator:inbox:<sid>:<receiverName>`, plus an active-subscribers set per receiver (`stator:subscribers:<receiverName>`) updated on first append.

**Publisher path**: an app machine emits. The framework reads `subscribersOf(sourceName)` from the reverse-index. For each subscriber (target name + dispatch), enumerate active sessions via `listSessions(targetName)` and append the event to each session's inbox.

**Drain path**: `SessionRuntime.loadGraph` already pulls every machine the request needs. After hydrating, but before processing the request's primary event, drain each loaded machine's inbox. Apply drained events in append order. If a drained event causes the receiver to emit (and that emit routes to another machine inbox in this same runtime), drain that one too. Loop until quiescent.

**Ordering rule**: inbox first, then primary event. This preserves "by the time my request's event runs, my session reflects everything the app has told it about."

## Alternatives Considered

- **Synchronous fan-out across all sessions at emit time.** Rejected. Would require loading every active session into the emitting context, which defeats the stateless-between-requests model and scales O(active sessions) per emit.
- **Push notifications only via SSE.** Considered (skip the inbox; only deliver to currently-connected sessions). Rejected because most sessions are not currently connected; an inventory event that fires while a user has the cart page open but not /admin still needs to reach their next request.
- **Sender-side declaration** (app machine declares "I emit X to all sessions of receiver Y"). Rejected. Same reason as session→session: keeps subscriptions receiver-side for schema-export coherence.

## Open Questions

- Per-event payload size limits. Inboxes hold serialized events; high-cardinality publishers with large payloads could blow up storage. Adapter-level concern; document the contract.
- Coalescing. If `INVENTORY_UPDATED` fires 10 times before any session drains, the receiver gets 10 events. For receivers that only care about latest state (e.g. denormalized snapshots), the inbox could collapse them at append. `subscribes: [{ ..., coalesce: 'latest' }]` is a natural hint. Defer until a real use case forces it.
- Cross-replica publisher reach. If session A's POST emits an app-machine event on replica 1, does replica 2's connection table see the fan-out? Only if the emit goes through the Store (which inbox-mediated delivery does). Confirms that universal-inbox-as-the-design-endpoint and app→session-via-inbox are the same direction.
- Cycle detection at runtime. Subscription cycles are caught at boot. State-dependent emit loops (machine A's emit triggers receiver to emit triggers receiver to emit...) need an iteration cap on drain-to-quiescence as a safety belt.

## Implementation Notes

(Not yet implemented.)
