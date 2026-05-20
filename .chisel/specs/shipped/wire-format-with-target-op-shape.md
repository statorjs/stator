---
title: Wire format with target/op shape
status: shipped
created: 2026-05-20
updated: 2026-05-20
area: protocol
---

## What and Why

The wire format is load-bearing. Server emitter, client applier, SSE pusher, and any future tooling all have to agree on it exactly. The original shape (`{ slot, value }` for text, `{ slot, attr, value, parentId }` for attrs, `{ slot, html }` for body swaps) grew by accretion and was already showing seams. Attribute patches carried a `parentId` field that the other ops ignored, which meant the addressing model was actually two different things smushed into one shape.

Pinning a clean format down before SSE lands matters more than it sounds. Once a push transport is multiplying the producers and consumers of patches, format changes get expensive. Doing the cleanup now, while three callers depend on it, is much cheaper than after a fourth shows up.

## Success Criteria

- Patches have one shape, addressing is one of two named kinds, and ops describe one of three named operations. Each dimension is closed-extensible.
- Server emits, client applies, and the format survives the addition of SSE without modification.
- Scope-subsumption is enforced explicitly. When a list or branch body is replaced, descendant text/attr patches must not leak alongside it.
- The contract is documented well enough that a third-party tool could implement either end.

## Constraints

- Discriminated unions, JSON only. No binary format yet.
- Closed semantics, open growth. Today's three ops (`text`, `html`, `attr`) are the only ones emitted, but the shape must accept future reserved ops (`attr-add`, `attr-remove`, `prop`, `insert`, `remove`, `move`) without rev-bumping.
- Clients that see unknown ops must `console.error` and continue, not crash.

## Approach

Two orthogonal dimensions:

- **`target`** is the addressing primitive. Two kinds: `{ kind: 'slot', id }` for positions inside the document (text spans, list/branch body containers), and `{ kind: 'element', id }` for elements that own attributes or events. Slot ids encode scope (`s0:i0:s2`), element ids are flat (`e0`).
- **`op`** is the operation primitive. `text` and `html` apply to slot targets, `attr` applies to element targets.

Server emitter (`recompute.ts`) builds patches with both fields. Client applier (`client/runtime.ts`) dispatches on `target.kind` then `op`. Scope subsumption is a server-side pass: when an `html` op fires for slot `sN`, any patch whose source slot is a descendant (`startsWith('sN:')`) is dropped from the batch.

`WIRE.md` at the repo root is the canonical contract document, intended for the same audience as a real protocol spec.

## Alternatives Considered

- **Keep the flat shape, add `parentId` everywhere for consistency.** Rejected. It conflated "what is this op acting on" with "what is the dom node for the op," even when those are the same thing. The flat-with-discriminators path keeps the shape honest.
- **Bake the addressing kind into the op name (`text-slot`, `attr-element`).** Rejected. It cross-products op and target into one axis, which makes the closed-extensibility story messier. Two independent enums are cleaner than one combinatorial enum.
- **String-based mini-language for patches.** Considered briefly (`s0:text=Hello`). Rejected as too cute, harder to extend, JSON is fine.

## Open Questions

- Patch ordering within a batch is currently slot-discovery order plus the scope-subsumption rule. That's enough for the current ops but worth pinning explicitly if keyed-list ops land.
- Versioning the format itself: nothing today. Additive changes are forward-compatible via the "ignore unknown ops" client rule. If a breaking change is ever needed, the right place to add a version field is at the response envelope level (`{ patches: [...], version: 2 }`), not per-patch.

## Implementation Notes

Shipped. The cleanup landed alongside an explicit scope-subsumption pass that previously worked only by accident (iteration order + lazy unregister). Documenting scope subsumption as a wire-correctness rule rather than an internal optimization was the most useful side effect: it makes the rule survive future refactors.

The discriminated-target shape made the SSE work cleaner than expected. The fan-out code emits the same patch shape the POST path does, and the client applier doesn't care which transport delivered them.