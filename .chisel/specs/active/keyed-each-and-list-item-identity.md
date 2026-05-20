---
title: Keyed each and list item identity
status: draft
created: 2026-05-20
updated: 2026-05-20
area: runtime
---

## What and Why

`each()` today re-renders the whole list body on any change to its source array. That works for the cart (small lists, no inputs, no transitions to preserve), but breaks the moment you have:

- a focused input inside a list item that survives a reorder
- a CSS transition mid-flight when a row appears
- a select box's open state surviving an unrelated row's addition

The why behind framing this as a missing primitive, not a missing feature: the framework has **slot identity** (an `sN` id, stable across renders of the same shape) but no **item identity** (a key derived from data, stable across reordering). These are two different primitives.

Slot identity lets us address "position 3 in this list." Item identity lets us address "the row for productId p1, wherever it is now." You need both to address into a list correctly under change.

When this lands as a real primitive, the wire-format ops we reserved (`insert`, `remove`, `move`) become emittable. The ops aren't the primitive. The identity is.

## Success Criteria

- `each` accepts an optional `key: (item) => string` selector.
- When the underlying array changes shape, the framework computes a diff against the previous keys and emits item-level patches (`insert`, `remove`, `move`) instead of a single full-body `html` patch.
- A focused input inside a list item survives a reorder of unrelated rows.
- The wire format gains the three reserved ops, fully documented.
- Existing unkeyed `each` usage is unchanged (no `key` means full-body re-render, same as today).

## Constraints

- `key` is a pure selector of the item, like other framework selectors. No closure over external state.
- Keys must be string-typed for wire-format simplicity. Numbers are coerced; objects and arrays as keys are an error.
- Duplicate keys in the same list at the same time are an error caught at render. Two rows with `productId="p1"` is a bug, not behavior to be polite about.
- The client applier must handle keyed patches deterministically. Ordering within a batch matters when applying inserts and moves together. Spec ordering rule explicitly.

## Approach

`each(items, fn, { key: (item) => string })` registers a `kind: 'list-keyed'` binding (or extends `kind: 'list'` with an optional key fn). The binding holds the previous render's keys array alongside the items array.

On recompute:
- Compute new keys from new items.
- Diff old keys vs new keys. Standard list diff algorithm (longest common subsequence, or a simpler "remove then insert then move" pass).
- Emit one patch per item change:
  - `{ target: { kind: 'slot', id: parentSlot }, op: 'insert', index, value: '<rendered-item-html>' }`
  - `{ target: { kind: 'slot', id: parentSlot }, op: 'remove', index }`
  - `{ target: { kind: 'slot', id: parentSlot }, op: 'move', from, to }`

Client applier walks the patches in order, applying each against the actual DOM. Insert and move use index-based positioning within the parent slot's children.

For unkeyed `each` (no `key:`), behavior is unchanged: full-body `html` patch on shape change.

## Alternatives Considered

- **Implicit positional keys** (use the array index as the key). Rejected. This is what unkeyed `each` already does, and the failure mode (reorder = full re-render) is exactly what we're trying to fix.
- **Reference-identity keys.** Considered for the case where items are stable object references. Rejected as a default because it doesn't survive serialization (server-rendered HTML can't carry JS references) and because explicit key selectors are clearer.
- **Diff at the DOM level.** Considered (let the client compare old DOM to new DOM and figure out moves). Rejected. Server has the data, server has the previous keys, server should do the diff and emit minimal patches. The architecture invariant is "server is authoritative," and that should include the diff.

## Open Questions

- Move semantics under reorders that touch many items. Naive emit produces N moves where 1 reorder would suffice. A smarter diff produces fewer patches. Defer optimization until profiling shows it matters.
- Animation hints. A future spec might add `transition:` directives that the framework respects when emitting moves vs. inserts. Out of scope for this primitive.
- Interaction with `when`/`match`. A branch swap currently emits a full-body html patch. If the branch body contains a keyed `each`, can the patch be more granular? Probably not worth it; the branch swap is the whole region's identity changing, not items moving.

## Implementation Notes

(Not yet implemented. The wire-format reserved ops are documented in `WIRE.md` as anticipating this work.)
