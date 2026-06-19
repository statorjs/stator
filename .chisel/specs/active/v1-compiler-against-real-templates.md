---
title: V1 compiler against real templates
status: draft
created: 2026-05-20
updated: 2026-05-20
area: compiler
---

## What and Why

POC templates are tagged template literals in `.ts` files. Works, has no compiler, ergonomic ceiling. V1 introduces a single-file component format (`.stator`) with frontmatter, JSX-flavored body, and scoped styles.

The why this matters more than ergonomics:

1. The current `html` tagged template is parser-shaped (every interpolation is classified at runtime). A real compiler does the slot allocation, scope tracking, and binding registration at build time. That removes work from every render and unlocks the "compile-time slot analysis" the original spec gestured at.
2. The framework's whole pitch is "explicit, declared, statically analyzable." Tagged templates make that hard to verify: a `read()` call could in principle be anywhere. SFC frontmatter makes the interface explicit.
3. Scoped styles need a build step. Without one, every page is dragging a global stylesheet.

The runtime is stable. The compiler is a contained second project that emits the same primitives the runtime already accepts. No runtime changes required to ship the format.

Client-side state and behavior — the `<script>` block, the `on:`/`bind:`/`ref:` directives, custom-element output, and the import-location boundary — build on this format and are specced separately in [[client-scripts-directives-and-isomorphic-machines]].

## Success Criteria

- A `.stator` file with frontmatter (imports + props), JSX-flavored body, and a `<style>` block compiles to a `.ts` module that the existing runtime consumes verbatim.
- The four existing example templates (`layout`, `product-list`, `cart-page`, `checkout-page`) can be rewritten in `.stator` form and produce identical patches end-to-end.
- All the constraints below survive the compile (one-source-per-attribute, explicit reads, no auto-tracking, slot-level diffs).
- Scoped styles work via a synthetic class injection that integrates with `class:list`.

## Constraints

- Explicit `read` only. The compiler must not auto-bind `{cart.itemCount}` into a slot. A bare `{expr}` is a one-shot interpolation; only `{read(machine, selector)}` produces a binding. This preserves the explicit-reads invariant the framework rests on.
- Colon-discriminated directives (`on:click`, `class:list`, `style:list`). The parser distinguishes a directive (`name:modifier`) from a normal attribute by the colon.
- Control flow via callbacks, not JSX components. `{when(cond, () => <body/>)}` not `<When cond=...>...</When>`. JSX component children evaluate eagerly; a `<When cond={false}>` would register event handlers and allocate slots even though it doesn't render. Callback form matches the runtime semantics directly.
- Type-only imports for machine references. The compiler errors on a value-import of a machine in a template (templates use `InstanceOf<typeof MachineDef>`, never the runtime def).
- One-source-per-attribute survives. `class:list`/`style:list` directives own whole attributes. The compiler enforces the same rule the runtime does.

## Approach

**Format**:

```
---
import { read, each, on, classList } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'

interface Props { cart: InstanceOf<typeof CartMachine> }
const { cart } = Stator.props<Props>()
---

<section class="products">
  <h1>Cart: {read(cart, c => c.itemCount)}</h1>
</section>

<style>
  .products h1 { color: red; }
</style>
```

**Output**: a `.ts` module with `export default function(props): HtmlFragment` that uses the existing `html`, `read`, `each`, `when`, `match`, `on`, `classList`, etc.

**Compiler base**: TypeScript AST transform. Type-aware, ESM-only, no Babel weight.

**Stages**:

1. Split frontmatter from body and styles.
2. Parse body as JSX, walk the AST.
3. Lower JSX to tagged-template-shaped source (or directly emit calls into `html`...`). Preserve callback closures in place.
4. Rewrite `Stator.props<Props>()` to the function-signature form.
5. Extract `<style>` blocks, hash, inject a synthetic class into every body element. Integrate with `class:list` specs that already exist on an element.

**Scope of MVP**: handles the four example templates. Compile-time slot analysis (static slot ids baked into output) is a follow-on optimization, not part of the MVP.

## Alternatives Considered

- **HTM** (HTML-in-JS tagged literals). No compile step needed. Rejected because the format work is the point; HTM provides no ergonomic gain over what we have.
- **Babel plugin.** Rejected. Babel weight is unjustified for a TypeScript-only codebase. TS AST is type-aware, the natural fit.
- **Fork of Astro's or Svelte's parser.** Considered. Rejected for the MVP because the JSX-flavored subset is small enough to handle directly; forking buys complexity we don't need yet. Worth revisiting if the format grows enough to justify it.
- **Component-form control flow** (`<When>`, `<Each>`, `<Match>`). Rejected for the MVP per the eager-evaluation problem. Possible future ergonomic sugar that desugars to callback form, but not a primitive.

## Open Questions

- Keyed `each`. JSX convention is `key={...}`. Compiler extracts `key` from the callback's returned element and rewrites to `each(items, fn, { key })`. This unlocks the keyed-each work; see that spec.
- Scoped styles × `class:list`. The compiler must thread the synthetic class through any element that has `class:list`, not just `class="..."`. The class:list runtime already accepts `string | array | object`; injecting the synthetic class as an array entry is the cleanest path.
- Dollar-sign escaping. JSX text content with literal `$` needs to be escaped when emitted into a tagged template literal. Easy to get wrong, easy to test. Compiler emit always escapes literal `$` to `\$` to round-trip safely.
- Editor support (LSP, syntax highlighting). Derivative work, mostly mirroring Astro/Svelte tooling. Out of scope for the MVP.
- Bundler orchestration. The "TS AST transform, no Babel" decision above is about the *compiler*, not the *build orchestrator*. A build spike (2026-06-17, captured in [[client-scripts-directives-and-isomorphic-machines]]) showed Vite cleanly hosts this transform as a plugin and routes one `.stator` file to a server module + client bundle + scoped CSS via virtual-query ids. The transform stays bundler-agnostic behind a thin plugin adapter; Vite wraps it. One concrete constraint surfaced: scoped `<style>` must be emitted as a `lang.css`-suffixed virtual module imported by the *client* entry (SSR does not execute stylesheets), which refines the synthetic-class approach in the Approach section above.

## Implementation Notes

(Not yet implemented. Hand-rewrites of the four existing templates exist as design exploration in this spec's predecessor design note.)
