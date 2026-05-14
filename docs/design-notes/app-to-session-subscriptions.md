# App-to-session subscriptions — V1 design

Status: open design, V1 work. Companion to
[`cross-machine-event-delivery.md`](./cross-machine-event-delivery.md), which
poses the broader question of whether to also unify same-session delivery
into the same path.

## The gap

The POC enforces same-lifecycle subscriptions: a session-lifecycle machine
can only subscribe to other session-lifecycle machines. App-lifecycle
machines can be subscription sources only for other app-lifecycle machines.

This rules out a real V1 need: app-lifecycle machines that broadcast to
session-lifecycle receivers. Concrete examples:

- `FeatureFlagsMachine` updates → every cart machine re-evaluates available
  promotions.
- `MaintenanceModeMachine` toggles on → every session sees a banner.
- `InventoryMachine` records a stockout → every cart with the affected
  product re-checks line items.

The POC defers this because the synchronous in-process listener model has
no answer to "which session do I dispatch to?" — the source actor lives
above any specific session.

## The mechanism: per-session inbox in the Store

Every session-lifecycle subscriber gets an inbox in the Store, indexed by
`(sessionId, receiverMachineName)`. The publisher path:

```
AppMachine emits event 'INVENTORY_UPDATED'
  ↓
Framework looks up subscribersOf('AppMachine') from the reverse-index
  ↓
For each (receiverName, dispatchEvent) pair:
  For each sid in Store.listSessions(receiverName):
    Store.appendInbox(sid, receiverName, dispatchEvent)
```

The drain path:

```
Any time a SessionRuntime hydrates a machine:
  Drain its inbox (Store.drainInbox(sid, machineName))
  Apply each drained event in order (oldest first)
  If draining transitioned the actor and emitted further events, append
    those to *other* inboxes per the same rules
  Repeat draining for any newly-touched machines in this runtime until quiescent
```

The receiver sees the inbox events as ordinary `actor.send` events
indistinguishable from incoming POST events — they go through the same
transition logic. The only thing distinguishing inbox delivery is the order
relative to request-scoped events: **inbox first**, then the request's own
event. This preserves the invariant "by the time my request's event runs,
my session reflects everything the app has told it about."

## Required Store primitives

| Primitive | Used by |
|---|---|
| `appendInbox(sid, receiverName, event)` | Publisher (app emit, possibly also same-session emit per the universal-inbox option) |
| `drainInbox(sid, receiverName) → Event[]` | `SessionRuntime` hydration |
| `listSessions(receiverName) → AsyncIterable<sid>` | Publisher fan-out |
| `deleteInbox(sid)` (implied by `deleteSession`) | Session cleanup |

For `InMemoryStore`: trivial Map operations. For Redis: lists keyed by
`stator:inbox:<sid>:<receiverName>`, plus a SET of `stator:subscribers:<receiverName>`
for `listSessions`. For Postgres: a single `inbox` table indexed on
`(receiver_name, session_id)`.

## Ordering rules

1. **Inbox first.** Inbox events drain before the request's primary event
   is sent.
2. **Drain to quiescence.** A drained event may transition the receiver
   and emit further events into other inboxes; those drain in the same
   pass if their receivers are loaded in this runtime. Loop until no new
   inbox entries appear for any loaded machine.
3. **Per-receiver FIFO.** Within a single receiver's inbox, events drain
   in append order. Wall-clock time is not authoritative across receivers
   (clocks skew, multi-process publishers race); only same-receiver order
   is guaranteed.
4. **At-least-once.** A publisher crash mid-fan-out leaves some
   subscribers with the event delivered and some without. Receivers must
   tolerate re-delivery — practically, idempotent event handlers. Worth
   documenting as part of the contract.

## What stays declarative

Subscriptions remain receiver-side declarations on `defineMachine`:

```ts
defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  subscribes: [
    { from: FeatureFlagsMachine, event: 'FLAGS_UPDATED', dispatch: 'FLAGS_REFRESH' },
    { from: InventoryMachine, event: 'STOCKOUT', dispatch: 'CHECK_AVAILABILITY' },
  ],
  // ...
})
```

The boot-time validator drops the same-lifecycle constraint when this is
implemented. The reverse-index in `MachineStore.subscribersBySource` already
supports any source lifecycle.

## Offline / dormant sessions

If a session's owner closes the browser and never returns, its inbox grows
forever. Two mitigations, neither in V1 critical path:

- **TTL on inbox entries.** Drop entries older than N days at drain time
  or via a background sweep.
- **Session TTL.** Drop entire sessions (cookie, inbox, snapshots) after N
  days of inactivity. Tracked via a `lastTouched` timestamp on
  `Store.set`.

Adapter-level. The framework's contract is just: "drain returns entries in
append order; entries may be dropped by the adapter per its retention
policy."

## Interaction with the universal-inbox question

This note assumes Option A from
[`cross-machine-event-delivery.md`](./cross-machine-event-delivery.md): the
inbox is *added* for app→session while same-session keeps its in-process
path.

If Option B (universal inbox) wins after measurement, the only difference
is that **same-session events also go through the inbox**, using exactly
the primitives and rules above. The publisher just doesn't distinguish:
every emit fans out to every subscriber's inbox regardless of lifecycle.
The mechanism is the same; the scope changes.

## Open questions

- **Per-event payload size limits?** Inboxes hold serialized events. A
  publisher that fires high-cardinality events with large payloads could
  blow up storage. Adapter-level concern; document the contract.
- **Should `subscribes:` carry a `priority` or `coalesce` hint?** If
  `INVENTORY_UPDATED` fires 10 times in a row before any session drains,
  the receiver gets 10 events. For receivers that only care about the
  latest state (`coalesce: 'latest'`), the inbox could collapse them at
  append time. Not POC. Worth a separate note if it comes up.
- **Cross-machine guards** (`when: 'guardName'` on a subscription entry)
  — see notes in [`cross-machine-event-delivery.md`](./cross-machine-event-delivery.md) on
  resisting function-shaped dispatchers. Named guards on the receiver are
  the right answer if/when guards become necessary.
