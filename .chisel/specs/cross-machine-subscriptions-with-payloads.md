---
title: Cross-machine subscriptions with payloads
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

The original spec declared `emits:` on machines as metadata, but nothing actually delivered an emit to another machine. The first real use case made that gap visible: the cart should clear when checkout completes. There was no clean way to express "when CheckoutMachine emits ORDER_PLACED, dispatch CLEAR to CartMachine."

The why behind making this declarative rather than imperative: machines are supposed to be self-describing. If "cart clears on order" lives inside a side effect inside an action, the relationship is invisible to schema export, lint, dev tools, and any LLM trying to reason about the system. Putting it in the machine's declaration keeps the graph statically analyzable.

## Success Criteria

- A machine declares which other machine's emits it cares about and what to do when they fire.
- The subscription graph is visible from machine definitions alone, no closure-scanning required.
- Cross-lifecycle subscriptions (session-machine emit → app-machine receiver) carry the source session identity automatically, so the receiver can correlate.
- Subscribers get the payload, not just the event type. Denormalizing receivers (like an admin view) can update their state without re-reading the source.
- The same-lifecycle case (session → session) doesn't pay any overhead beyond what an in-process actor listener would cost.

## Constraints

- Receiver-side declaration, not sender-side. The source machine doesn't know who's listening. This decouples them and matches the schema-export goal (you ask "what listens to X" once at the source, "what does Y listen for" once at the target, never both).
- Resist function-shaped dispatchers. The temptation to make `dispatch` a function (subsumes guards, transforms, and fan-out) collapses three distinct concerns into one opaque thing. Hold the line: `dispatch` is `string` or `EventObject`.
- Emit payloads are declared at the source via a `payload: (ctx, ev) => ...` selector. Pure of `(ctx, ev)`, runs after the transition's actions. No async, no external reads.
- App→session subscriptions are blocked at boot validation. They need the inbox model to deliver across the "which session?" gap, and that's a separate spec.

## Approach

`defineMachine` accepts `subscribes: [{ from, event, dispatch }]`. `MachineStore` builds a reverse index at boot (`subscribersBySource`) so `SessionRuntime` can look up "who subscribes to CartMachine?" with one Map hit.

Wiring is direction-uniform. `SessionRuntime.wireSubscriptions` iterates the session machines it loaded, looks up their subscribers from the reverse index, and installs `actor.on(event, ...)` listeners. The target may be another session machine in the same runtime (session→session) or an app machine in the long-lived `appInstances` map (session→app). The same code handles both. App→app wiring happens once at app boot inside `MachineStore`.

For session→app, the listener injects `sourceSessionId` into the dispatched event automatically. The receiver gets `{ type: 'SESSION_CART_CHANGED', items, total, sourceSessionId: 'abc-123' }` and can denormalize per-session.

Emits become an object form: `emits: { ITEM_ADDED: { payload: (ctx) => ({ items: ctx.items, ... }) } }`. Bare-string shorthand (`emits: ['CART_CLEARED']`) is preserved for no-payload events. Transition-level `emit: 'NAME'` is validated at machine-definition time: emitting an undeclared name throws.

## Alternatives Considered

- **Sender-side declaration** (machine declares "I emit X to Y on event Z"). Rejected because it forces the sender to know its receivers, which collapses the abstraction.
- **Function dispatcher** (`dispatch: (event, ctx) => Event | null`). Rejected because it bundles guards, transforms, and fan-out into one opaque function, and the schema export immediately loses fidelity.
- **Auto-include the originating event's payload in the emit.** Rejected because it conflates the trigger (a command shape) with the notification (a fact shape). Refactoring the source machine would silently break every subscriber.
- **Magic key for `sourceSessionId`** (`subscribes: [{ ..., includeSourceSession: true }]`). Rejected as opt-in for something nobody opts out of. Automatic injection for cross-lifecycle, omitted for same-lifecycle.

## Open Questions

- Same-lifecycle subscriptions today use in-process `actor.on` listeners. When the inbox lands for app→session, we'll have to decide whether to unify all delivery through the inbox or keep two paths. Tracked in the cross-machine event delivery spec.
- Guards on subscriptions (`subscribes: [{ ..., when: 'guardName' }]`) and transforms haven't shipped yet. Each is a named primitive on the receiver, deliberately kept separate from `dispatch`. Wait for a real use case before designing.
- Emit payload pureness is documented but not enforced. A V1 dev mode could double-invoke the selector and error on divergence, similar to React strict mode. Out of scope today.

## Implementation Notes

Shipped. The reverse-index decision turned out to be load-bearing in a way I hadn't expected. When session→app was added, the wiring code switched from "iterate targets" to "iterate sources, look up subscribers" and the same code path handled session→session, session→app, and app→app. The reverse index is the architectural commitment, not the subscription syntax.

The dogfood discovery: source-driven wiring via the reverse-index is the right shape, not a workaround. Direction (session vs app) is incidental; the relationship is the data.