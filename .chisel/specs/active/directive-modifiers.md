---
title: Directive modifiers
status: draft
created: 2026-08-07
updated: 2026-08-08
area: compiler
---

## What and Why

Pipe-separated modifiers on directives — Svelte's syntax:

```stator
<form on:submit|preventDefault={() => form.send({ type: 'SAVE' })}>
<button on:click|stopPropagation|once={handler}>
```

They adjust *how* a directive behaves without a new directive per behavior, they
compose, and they follow a pattern authors already know (Svelte's `|`, Vue's
`.`). The `|` reads well precisely because `:` is already the namespace
separator.

Two reasons now: (1) it is the right extensibility axis for behavioral tweaks
(`preventDefault`, `stopPropagation`, …) that today force a hand-written wrapper
in the handler; (2) with the `send()` helper, modifiers complete the ergonomics
that make an explicit, no-two-way form model comfortable — `send()` carries the
data, `|preventDefault` carries the behavior, neither reaches for `@set`.

Independent of the binding rework, but it lands well with it: under
[[isomorphic-reactive-model-read-for-display-on-for-events]] the directive surface
narrows to `on:` (in) + `ref:` (identity), so modifiers concentrate on `on:` —
exactly where they are most useful. **Decoupled from the removal gate, though:**
the `bind:`-removal ergonomics must not depend on modifiers landing — the
`send()` helper alone carries them, and modifiers are additive polish on top.

Additive; a bounded compiler addition; can ship in a minor — **once the syntax
hazard below is resolved.**

## Blocking: `|` does not parse as TSX

"Templates must parse as TSX" is a permanent design constraint, and the repo has
already run this experiment: TS's JSX parser rejects `|` (and `.`) in attribute
names — verified during the `is:inline` work, recorded in
[[client-scripts-directives-and-isomorphic-machines]] ("the `|` pipe (and `.`)
do not parse as JSX"; Svelte/Vue/Astro accept modifiers only because they ship
custom template parsers) and independently in
[[editor-tooling-lsp-and-vscode]] ("only the dropped `|lazy` pipe failed to
parse"). The Approach's step 1 — parsing `|` off the name in `lowerAttribute` —
presumes the attribute name reaches the lowerer intact; it will not, the file
fails TSX parse first. This spec previously did not mention the constraint.

Re-entry paths, none free:
- **A preprocessor pass** (the path the vision spec recorded) that rewrites
  `on:click|once` to a TSX-legal spelling before parse — touches the compiler
  front door *and* the LSP's virtual-code mapping (positions shift).
- **A TSX-legal spelling** — e.g. `on:click$once` (`$` is legal in a JSX
  identifier) — no parser work, but a syntax nobody else uses and `$` reads
  poorly.
- **Attribute-per-modifier or a wrapper helper** — no grammar change at all,
  at the cost of the compositional one-attribute form this spec exists for.

Until one is chosen and spiked against both the compiler and the language
server, this spec is design-blocked and must not be load-bearing for anything
else's sequencing.

## Success Criteria

- `on:click|preventDefault={h}` parses, and the emitted event binding carries the
  modifier; the runtime dispatcher honors it.
- Modifiers compose: `on:click|stopPropagation|once`.
- The set is **closed and validated** — an unknown modifier is a compile error
  ("`|stpoPropagation` is not a modifier; did you mean …").
- Works for both server `on:` (dispatch-time metadata on the `data-event-*`
  binding) and client-island `on:` (listener options / a guarded wrapper).
- Zero per-modifier runtime: each is a boolean flag the dispatcher reads.

## Constraints

- **Closed, built-in vocabulary.** No custom/user modifiers — consistent with
  the closed directive-namespace finding (there is no custom-directive path in
  `.stator` today). A known set is greppable and typo-checkable.
- **Flag-only for v1.** No modifier arguments (`|debounce=300`). Arguments are a
  real grammar step-up and are deferred (see Open Questions).
- **Behavior, not data.** Modifiers own event behavior only. Value extraction and
  coercion stay in `send()` / the machine handler — do not let modifiers become a
  data-mapping DSL (Vue's `v-model.number` is the anti-pattern to avoid).
- **Metadata, not handler-wrappers.** A Stator `on:` handler runs at render and
  returns an `EventDescriptor`; the DOM event fires later via the dispatcher. So
  a modifier is a declarative flag on the binding, not a closure wrapping the
  handler (cleaner than Svelte, which wraps).

## Approach

1. Parse `|`-separated modifiers off the directive's `name` in `lowerAttribute`
   (`on:click|a|b` → event `click`, modifiers `[a, b]`). The directive namespace
   handling already splits namespace/name; this splits the name further.
2. Validate each modifier against the closed set; error with a suggestion on a
   miss.
3. Emit modifiers as flags on the event binding — for server `on:`, extra data on
   the `data-event-*` attribute the delegated runtime listener reads; for client
   islands, `addEventListener` options (`{ once, capture }`) plus a small guarded
   prologue (`preventDefault`, `stopPropagation`, `self`).

Proposed shortlist (flag-only, DOM-standard, behavior-only):

| Modifier | Purpose |
|---|---|
| `preventDefault` | forms — suppress native submit/navigation |
| `stopPropagation` | nested interactive elements |
| `self` | fire only when `event.target` is the element itself (backdrop dismiss) |
| `once` | fire once, then detach |
| `capture` *(maybe)* | capture-phase listener |

## Alternatives Considered

- **New directives/attributes** (`model=`, `on-change=`). Rejected — proliferation,
  and they aren't directives so they don't compose with the `on:` machinery.
- **Vue `.` syntax.** `on:click.stop` reads like property access; `|` is clearer
  next to the `:` namespace separator.
- **Svelte-style handler-wrapping.** Not applicable — Stator handlers produce a
  descriptor at render, so modifiers are binding metadata, which is simpler.

## Open Questions

- Final shortlist — include `capture`? `passive`/`nonpassive` (scroll/touch) are
  probably not worth it; `stopImmediatePropagation`/`trusted` are niche.
- **Modifier arguments** (`|debounce=300`, `|throttle`). Genuinely useful for
  inputs, but they force an argument grammar. Flagged as *the* trigger to add
  arg support later — not v1.
- Do modifiers apply uniformly to server `on:` and client-island `on:`? (Intended
  yes; the flag semantics must match on both paths.)
- `on:` only. (`bind:` folds into `read()` under the model spec, so it is not a
  modifier target; `ref:` takes no value and has no event to modify.)

## Implementation Notes

<!-- not yet built -->
