---
title: 'Trusted template values cannot be forged from JSON'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: template
---

## What and Why

The `html` tag escapes every interpolated value in text position, except the values it trusts: an `html`/`raw()` fragment and an `each`/`when`/`match`/`defer` region are spliced verbatim, and a `read()` result or an item read is written as a live binding. Up to 3.0 it recognised these by plain string-keyed properties (`__isHtmlFragment: true` and the like), checked in `isHtmlFragment` (`packages/stator/src/template/types.ts`), `isEachResult`/`isItemReadResult` (`each.ts`), `isBranchResult` (`conditional.ts`), `isDeferResult` (`defer.ts`), `isReadResult` (`read.ts`) and `isDirectiveInvocation` (`directives/core.ts`).

`JSON.parse` produces objects with whatever string keys the input names. So any JSON value that reaches a template in text position could claim to be trusted: a field from a database row, a remote API or feed, an app-lifecycle machine snapshot, or an event payload, which `/__events` accepts as arbitrary JSON and an ordinary `assign` stores in context. Such a value was spliced as raw markup on first render and in region re-renders over the wire. A forged `read()` result also had its slot id written into a `data-slot` attribute without escaping. On a machine shared by all visitors (a guestbook, a chat), that is stored script injection for every viewer.

This is finding 02-F1 of the November 2026 review, re-confirmed on `main` before 3.1.

## Success Criteria

- An object parsed from JSON that has the shape of any trusted value renders as escaped text (it stringifies like any other object), in text position and inside an interpolated array.
- A forged directive invocation in directive position is refused like any plain value.
- A fragment that goes through `JSON.stringify`/`JSON.parse` is no longer a fragment.
- Genuine `html`, `raw()`, `each`, `when`, `match`, `defer`, `read` and item reads render exactly as before. Author-facing signatures do not change.
- A value created by one copy of the package is recognised by another copy loaded in the same process (an app and a component library each resolving their own `@statorjs/stator`).
- The read slot id is escaped where it is written, as defence in depth.

## Constraints

- Patch release. No change to what authors write.
- No edit to files in the engine hash or to files other open branches change.
- Compiled `.stator` output and the checked-in compiled components must not change.
- Accepted: the interfaces carry a `unique symbol` key, so two copies of the package type-checked in one program have distinct `HtmlFragment` types, where the old string-keyed types were structurally identical. Runtime recognition is unaffected. Only code that passes one copy's `HtmlFragment` where the other copy's type is expected would see a type error. A component library declares `@statorjs/stator` as a peer dependency, so an app and its libraries share one copy and one set of types. The alternative, a string key in the types over a symbol at runtime, would make the types wrong about the runtime.

## Approach

A new module, `packages/stator/src/template/brand.ts`, holds one symbol per trusted kind, minted with `Symbol.for('@statorjs/stator:<kind>')`, and `hasBrand(v, brand)`. Every constructor sets `[BRAND]: true` instead of the string property, and every `is*` guard calls `hasBrand`. The interfaces (`HtmlFragment`, `EachResult`, `BranchResult`, `DeferResult`, `ReadResult`, `ItemReadResult`, `DirectiveInvocation`) carry the symbol key in their type.

`JSON.parse` cannot produce a symbol-keyed property, and structured clone drops them, so only the framework's own constructors can brand a value. `Symbol.for` uses the global symbol registry, so two copies of the package agree on the symbols.

`handleRead` in `html.ts` passes the slot id through `escapeAttribute`. Slot ids are generated from a selector-safe charset, so the output is unchanged for genuine reads.

Producers and consumers checked:

- Compiled `.stator` output never builds a marker literally. Island shells call `createHtmlFragment` and read `.html` (`compiler/compile.ts`); everything else goes through `html`, `each`, `when`, `match`, `defer`, `read` and `itemBind`. `build:components` reproduces the committed components byte for byte.
- `server/render.ts` (defer fill) and `server/recompute.ts` (region re-render) use the guards and `.html` in process; nothing serialises a marker.
- The wire carries rendered HTML strings and patch values, never markers. The client (`src/client`, island runtime, client `read()`) has no marker checks.
- Machine context is opaque JSON by contract (`server/store.ts`); `server/app-store.ts` and `server/redis-store.ts` round-trip it through JSON, while `InMemoryStore` keeps session snapshots by reference. This is the one place a branded value could have crossed a serialisation boundary on purpose: a `raw()` fragment kept in context used to render as markup after a JSON round trip. After this change it renders as markup only while it stays in process (the in-memory session store) and as escaped text once a JSON store has held it. No documented pattern, example or test keeps a fragment in context; the supported form is to keep the string and call `raw()` in the template.

Not changed: `__isEventDescriptor` (built in `server/instance-proxy.ts`, which is in the engine hash, and written into the `data-event-*` attribute as escaped JSON; it is not an escaping bypass), `__isStatorDirective` (no guard reads it), and the route and machine brands (definitions, never template values).

## Alternatives Considered

- **A module-private `WeakSet`.** Equally unforgeable, but two copies of the package would not recognise each other's values, so a component library with its own copy would have its output escaped.
- **A module-private `Symbol()`.** Same problem as the `WeakSet`.
- **Keep the string properties and also require the symbol.** Keeps the old shape visible in `JSON.stringify` output and in types for no benefit; nothing outside the template layer reads the string properties.
- **Validate event payloads.** 3.2 event schemas narrow `/__events` only, and only for machines that opt in. The brand is the one place that covers every source of JSON.
