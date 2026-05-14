# Cross-machine event delivery — V1 design options

Status: open design, V1 work. POC ships with the dual-path model (Option A).

## Context

stator's POC delivers cross-machine events two different ways depending on
relationship:

- **Same-session (currently implemented):** When CartMachine `subscribes:` to
  CheckoutMachine.ORDER_PLACED, the `SessionRuntime` hydrates both actors,
  installs `actor.on('ORDER_PLACED', …)` listeners across them, and the
  emit fires the listener synchronously inside a single `processEvent` call.
  Touched set populates; both machines' patches go out in the same response.

- **App-source → session-receiver (not implemented):** No path exists today.
  An app-lifecycle machine emitting an event has nowhere to deliver it
  because session targets aren't enumerable from inside an actor listener
  (which session do we dispatch to?).

V1 needs to fill the app→session gap. The question is whether to do it as
a *second* delivery path or by **unifying both into one path**.

## Option A — dual path (POC behavior, formalized for V1)

Same-session: in-process listeners across co-resident transient actors
(today's behavior, unchanged).

App-source → session-receiver: introduce a per-session inbox in the Store.

- Source emit fans out to every active session whose receiver subscribes:
  one `Store.set(sid, "inbox", append({topic, event, ts}))` per subscriber.
- Receiver's inbox drains the next time that session is hydrated for any
  reason (request or SSE push). Drain happens before the request's primary
  event is processed (inbox-first ordering).
- Active sessions enumerated via `Store.listSessions(machineName)`.

**Pros:**
- Same-session path keeps in-process latency (microseconds).
- Inbox handles the cross-process / offline cases cleanly.
- Each path is locally optimal for its case.

**Cons:**
- Two delivery mechanisms — server code that orchestrates cross-machine
  events has to consider both.
- The co-residency requirement on same-session subscribers means
  `SessionRuntime.loadGraph` over-fetches: a request that only needs
  CartMachine still hydrates CheckoutMachine because they're
  subscription-linked. Marginal in small apps, accretes in larger ones.
- Two correctness models — wiring-time-coupled (synchronous, fires only
  if both actors are loaded in the same request) vs. inbox-delivered
  (asynchronous, fires when the receiver next hydrates). Subscribers can't
  reason about which they'll get without tracing the load graph.

## Option B — universal inbox

All cross-machine events route through the Store inbox. Same-session
included.

- Source emit → `Store.appendInbox(sid, receiverName, { topic, event, ts })`
  for every subscriber, regardless of where the receiver lives.
- `SessionRuntime.loadGraph` no longer pulls in subscription targets for
  co-residency reasons. It only loads machines the request directly reads
  or sends events to.
- Inbox drain happens at every render/persist boundary inside the request.
  When a loaded receiver has inbox entries, they're processed before the
  next render or before persistence. Drain runs to quiescence — a drained
  event may itself emit, populating more inboxes, repeat until stable.
- For receivers not loaded in the current request, their inbox entries
  remain in the Store and drain on next hydration. (Same as Option A's
  app→session behavior.)

**Pros:**
- Single delivery mechanism. Schema export, dev tools, and SSE fan-out all
  look at one place.
- The co-residency constraint dissolves. `loadGraph` is purely about *what
  this request renders*, not about *what this request's machines might
  emit to*.
- App→session is the same code path as same-session.
- Future scaling: inbox can absorb retries, dead-letter queues, distributed
  delivery without further architectural change.

**Cons:**
- Same-session cross-machine events incur Store round trips. On
  `InMemoryStore` these are Map ops (negligible). On Redis they're network
  hops (a few ms each, more under load).
- Drain-to-quiescence per dispatch step adds Store traffic in proportion to
  cross-machine cascade depth. A subscription chain A→B→C produces three
  inbox writes + three drains in the same request, vs. three synchronous
  listener calls under Option A.
- Within-request visibility is preserved (the receiver's inbox is drained
  before patches go out), but the mental model is more complex — the
  emit-to-effect path goes through serialization instead of memory.

## Decision criteria

The architectural argument tilts toward Option B (unified mechanism,
co-residency constraint gone, single schema). The latency argument tilts
toward Option A (in-process listeners are free, Store traffic isn't).

**Measure before committing.** The deciding factor is whether Option B's
extra Store traffic is observable in practice:

1. Implement the cart-clear-on-checkout flow under both options against
   `InMemoryStore`.
2. Measure end-to-end POST `/__events` latency for `SUBMIT_PAYMENT` (which
   triggers a same-session cross-machine cascade).
3. If Option B adds < 5ms in dev, ship it as the V1 default. The
   architectural cleanup is worth a few ms.
4. If Option B adds noticeably more (say > 15ms with InMemoryStore, which
   would mean the orchestration overhead dominates), keep Option A and
   document the dual-path rule clearly.
5. Re-measure under a real Redis adapter when one exists. Redis hops will
   shift the numbers significantly; Option B may become a non-starter for
   high-frequency cross-machine effects.

## Edge cases either option must handle

- **Ordering when both an inbox event and a request event are pending.**
  Resolution: inbox-first. The request's render sees the consequences of
  inbox-delivered transitions plus its own event in a single coherent pass.
- **Drain to quiescence.** A drained event can transition the receiver,
  which emits, which routes to another inbox, repeat. Bounded by the
  subscription graph (cycle-checkable at boot).
- **Active session enumeration.** `Store.listSessions(receiverName)` must
  exist as an adapter primitive. In `InMemoryStore` it's a Map walk; in
  Redis it's a `SCAN` with prefix; in Postgres it's a `SELECT DISTINCT`.
- **Offline / never-returning sessions.** Inbox grows unbounded if the
  receiver session never hydrates again. Needs a TTL or a session-disposal
  hook. Out of POC scope; flagged.
- **Cycle detection.** Subscription cycles (A subscribes to B's emit, B
  subscribes to A's emit) are caught at boot from declarations. Runtime
  fan-out cycles (state-dependent emit loops) are theoretically possible
  but bounded; an iteration cap on drain-to-quiescence is a safety belt.

## Related design notes

- [`app-to-session-subscriptions.md`](./app-to-session-subscriptions.md) — focused on the
  app→session case specifically (the gap Option A leaves open).
- [`v1-compiler-against-real-templates.md`](./v1-compiler-against-real-templates.md) — independent.

## Open questions

- Inbox storage shape: per-session per-receiver, or per-session global with
  receiver dispatch happening at drain time? Per-receiver is cleaner for
  fan-out and `listSessions` indexing; per-session global is fewer keys.
- Should sources be allowed to declare `dispatch: 'inline'` vs.
  `dispatch: 'inbox'` per subscription for tuning? Probably no — adds
  surface area without clear benefit, and the unified model wants one
  delivery semantics, not a knob.
