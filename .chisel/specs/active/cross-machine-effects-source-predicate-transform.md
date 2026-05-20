---
title: 'Cross-machine effects: source, predicate, transform'
status: draft
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

`subscribes:` today handles the trivial cross-machine case: "when source emits X, dispatch Y to me." It explicitly resists growing into a function-shaped dispatcher. That resistance is correct — collapsing source, predicate, and transform into one opaque function destroys schema export, lint, and dev-tools introspection.

But the underlying need (conditional cross-machine effects, transforms of payloads, fan-out to multiple receivers) is real. The right answer isn't "let dispatch be a function." It's three named primitives, declared separately, each with one job.

The why this matters: V1 will face requests like "only react to ORDER_PLACED if status was active," and "emit ITEM_ADDED to inventory for each item in the cart, transformed to RESERVE events." The temptation will be huge to slip a function into `subscribes`. This spec is the answer that's already on file when someone proposes it.

## Success Criteria

- A working app can declare a cross-machine effect with a guard (predicate) and a transform without using a function-shaped dispatcher.
- Each of the three concerns has its own named primitive:
  - **Source**: a machine + named emit (already covered by `emits:` + `subscribes:`).
  - **Predicate**: a named guard on the receiver.
  - **Transform**: a named flow or selector.
- The schema export still describes every cross-machine relationship completely. No opaque functions.
- Examples in the docs cover the three common cases: guarded subscription, transformed payload, fan-out to multiple receivers.

## Constraints

- No primitive ships until a real use case forces it. Speculative primitives age badly. This spec is the design on file, not a code commitment.
- Each primitive is independent. Guards don't transform; transforms don't filter; fan-out is just multiple subscription entries. Composition over conflation.
- Backward compatible with today's `subscribes: [{ from, event, dispatch }]`. The new primitives extend the entry, never replace it.

## Approach

**Predicate** (guards on subscription entries):

```
subscribes: [
  { from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR', when: 'cartIsActive' }
]
```

`when` is a named guard on the receiving machine. The guard runs against the receiver's current context before the dispatch fires. If the guard returns false, the dispatch is skipped. Schema export sees both the subscription and the guard name.

**Transform** (named flow):

```
defineFlow({
  from: CartMachine,
  on: 'ITEM_ADDED',
  to: InventoryMachine,
  send: (event, ctx) => ({ type: 'RESERVE', sku: event.productId, qty: 1 })
})
```

`defineFlow` is the cross-machine equivalent of `defineMachine`: a top-level declaration, statically analyzable, schema-exportable. It owns the transform logic explicitly. The `send` function is pure of `(event, ctx)` (matches emit payload selectors), no external reads.

Flows are discovered from a `/flows/` directory at app boot, mirroring machine discovery.

**Fan-out** is just multiple subscription entries (or multiple flows), one per receiver. No new primitive needed.

## Alternatives Considered

- **Function dispatcher** (`dispatch: (event, ctx) => Event | null`). Rejected, repeatedly. Collapses three concerns into one opaque function. Schema export immediately loses fidelity ("`ITEM_ADDED` produces… something, somewhere, sometimes"). This is the primary thing this spec exists to refuse.
- **Predicate as inline arrow function** (`when: (ctx) => ctx.status === 'active'`). Rejected. Named guards already exist on machines, are introspectable, and avoid the function-in-config smell. Inline arrows scatter logic and break schema export.
- **`defineFlow` collapsed into `subscribes`** (`subscribes: [{ ..., transform: 'flowName' }]`). Rejected because a flow can target a different machine than the source's reverse-index subscriber list, and embedding it inside `subscribes` confuses ownership. Flows are their own thing.

## Open Questions

- Where flows fit in the dispatch context. They run as part of the source's transition or as a follow-on step? Probably follow-on, after the source's actions complete and before recompute. Spec to confirm when implementation begins.
- Multiple flows on the same source/event pair. Allowed? Probably yes — fan-out is a feature, and a flow per receiver is a natural way to express it. Boot validation catches truly-ambiguous cases.
- Interaction with inbox model. When cross-machine delivery is inbox-mediated, flows still apply at the publisher boundary (transform-then-append) rather than the consumer boundary (drain-then-transform). Spec to nail down which side runs the flow.

## Implementation Notes

(Not yet implemented. This is the design on file to refuse premature function-dispatcher additions to `subscribes`.)
