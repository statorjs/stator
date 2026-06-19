---
title: Stator compiler and Vite plugin implementation plan
status: draft
created: 2026-06-19
updated: 2026-06-19
area: compiler
---

## What and Why

Phase 3 of [[stator-1-0-implementation-plan]] — the `.stator` single-file
compiler and its Vite integration. This is the build-sequencing and structure
plan; the *what* lives in [[v1-compiler-against-real-templates]] (the format) and
[[client-scripts-directives-and-isomorphic-machines]] (the client model). This
doc records how it gets built, in what order, and which use cases the tests must
cover.

It is the largest 1.0 phase and unblocks the client half of
[[typed-events-and-machine-mediated-dispatch]] (`Machine.dispatch` in a
`<script>`). The engine (Phase 1) and server-side typed dispatch (Phase 2) are
merged and green on `main`.

## Decisions (made while planning)

- **Standalone compiler + thin Vite plugin.** The compiler is a pure function
  with no Vite imports; the plugin is a thin adapter. Confirmed by the build
  spike. The plugin ships as a subpath export `@statorjs/stator/vite`.
- **Framework dev server.** The framework provides a dev command that embeds Vite
  in middleware mode — the stator runtime renders, Vite transforms/HMRs. Batteries
  included; users don't hand-wire Vite.
- **Parse with the TypeScript compiler API (JSX enabled).** `ts.createSourceFile`
  in JSX mode + AST walk. Matches the spec's "TS AST transform, no Babel", reuses
  the toolchain, stays type-aware. No custom JSX parser.
- **MVP lowers JSX to `html\`…\`` source — runtime unchanged.** The compiler is a
  source-to-source transform from `.stator` syntax to the exact tagged-template
  `.ts` modules we already hand-write. Compile-time slot analysis (static slot ids
  baked into output) is a deferred optimization, not MVP. This is the key
  de-risking move: the runtime, recompute, and wire format are untouched; the
  compiler only adds nicer authoring syntax that lowers to existing primitives.
- **Staged 3a → 3b.** Server compiler first (independently shippable), then the
  client plane.

## Structure

```
packages/stator/src/compiler/        — pure, no Vite imports
  split.ts        — separate ---fence / template / <style> / <script>
  template.ts     — parse JSX body via the TypeScript AST
  lower.ts        — JSX → emitted `.ts` (html`…` tagged templates)
  directives.ts   — on: / bind: / ref: / class:list / style:list mapping
  styles.ts       — hash, scope-prefix, synthetic class injection
  script.ts       — <script> → client entry (custom element + wiring)
  capability.ts   — server-pinned-in-<script> = error; import-boundary
  index.ts        — compile(source, id, opts) => { serverCode, clientCode, css, deps, map }
packages/stator/src/vite/plugin.ts   — thin adapter, exported as @statorjs/stator/vite
```

## API surface to cover

`.stator` regions: `---` frontmatter (type-only machine imports,
`Stator.props<Props>()`), JSX template body, `<style>`, `<script>` (client).

Template constructs and their lowering target:

| construct | lowers to |
|---|---|
| `{read(m, sel)}` | `${read(m, sel)}` (slot binding) |
| `{expr}` | one-shot interpolation |
| `{when(cond, () => <p/>)}` | `${when(cond, () => html\`<p></p>\`)}` |
| `{each(items, fn)}` (+ `key=`) | `${each(items, fn, { key })}` |
| `{match(...)}` | `${match(...)}` |
| `on:click={h}` | `${on('click', h)}` |
| `class:list` / `style:list` | `${classList(...)}` / `${styleList(...)}` |
| `bind:text|html|value|checked|disabled|<attr>` | client-runtime bind helpers (3b) |
| `bind:value\|lazy` | two-way commit-on-change variant (3b) |
| `ref:name` | unique keyed attr + typed refs handle (3b) |

## Phase 3a — server compiler + Vite (no `<script>`)

Scope: split; JSX parse; lower `read`/`each`/`when`/`match`/`on`/`class:list`/
`style:list` to `html\`\``; `Stator.props<Props>()` rewrite; scoped `<style>` as a
`lang.css` virtual imported by the client entry (the build spike's hard
constraint — SSR never executes stylesheets); Vite plugin server-module + style
outputs; framework dev server (middleware mode) + HMR.

Exit criteria: the four example templates (`layout`, `product-list`, `cart-page`,
`checkout-page`) rewritten in `.stator` form compile to modules that produce
**byte-identical patches** to today's hand-written versions, end to end through
the runtime.

## Phase 3b — client `<script>` + directives

Scope: `bind:` (incl. two-way `bind:value|lazy`), `ref:`, custom-element codegen,
`use()` / inline `machine()`; client bundle output + per-component chunk manifest
the server reads to inject `<script>` tags; **client `Machine.dispatch(event)`**
(the deferred Phase 2 half) with the identity-vs-value import distinction (strip a
server machine's body from the browser bundle, keep its name + event types);
capability check (server-pinned machine in `<script>` → compile error) and
import-location boundary enforcement.

Exit criteria: a `.stator` component with a client machine, two-way form binding,
and a typed client→server commit works end to end in a browser (the client-model
spike, now compiler-produced rather than hand-written).

## Test matrix

Compiler is a pure function → heavy input→output unit tests.

- **Split**: all regions; missing regions; multiple `<style>`; violations
  (unquoted attrs, HTML comments, inline `<script>`/`<style>` in template) throw
  clear errors.
- **Lowering**: `{read}` slot; bare `{expr}` one-shot; each/when/match; keyed each
  (`key=`); `$`-escaping in JSX text.
- **Directives**: each `bind:` target; `bind:value|lazy`; `on:`; `ref:`;
  `class:list`/`style:list`.
- **Styles**: hash determinism; selector prefixing; synthetic class threaded
  through an element that also has `class:list`.
- **Capability / boundary**: server-pinned machine in `<script>` errors; portable
  OK; fence-import = server vs `<script>`-import = client.
- **Golden + identical-patches** (the killer regression): the four example
  templates compile and produce byte-identical patches to the hand-written
  versions through the real runtime.
- **Vite integration**: one `.stator` → three outputs (server module, client
  entry, scoped CSS) — regression of the build spike.
- **Client behavior (3b)**: a compiled `<script>` drives the DOM under happy-dom —
  actor send → bind: write.

## Alternatives Considered

- **Compile-time slot analysis in the MVP.** Rejected for MVP: lowering to
  `html\`\`` reuses the runtime parser and keeps the runtime unchanged, so the
  whole compiler is a syntax transform validated by identical-patch output.
  Static slot ids are a later perf optimization.
- **Combined (non-staged) Phase 3.** Rejected: server + client in one milestone is
  a large first green. Staging 3a/3b gives two independently shippable units.
- **Custom JSX parser.** Rejected: the TS compiler API already parses JSX,
  type-aware, no Babel weight; a custom parser risks divergence from real JSX.
- **Separate `@statorjs/vite-plugin-stator` package.** Deferred: a subpath export
  keeps 1.0 release surface small; a separate package can come later if the
  dependency boundary warrants it.

## Open Questions

- **Per-component chunk manifest shape** — how the server maps a route's rendered
  components to their client bundles for `<script>` injection. Sketch during 3b.
- **`send` vs `dispatch` naming** — settled when the client method form lands in
  3b (server uses the existing `dispatch` helper name today).
- **Production server + Vite** — dev embeds Vite middleware; production reads a
  built manifest + static client chunks. Confirm the prod build/serve story during
  3b (the server runtime stays the framework's, not Vite's, per the build spike).
- **Source maps** — emit through the TS transform so `.stator` line numbers
  survive into stack traces; verify in dev.

## Implementation Notes

(Not started. Plan only. Phase 1 engine and Phase 2 server dispatch are merged on
`main`. Begins with Phase 3a.)
