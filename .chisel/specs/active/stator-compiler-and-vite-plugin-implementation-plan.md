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

### Scoped styles (decided 2026-06-19)

- **Plain attribute scoping**, not CSS `@scope`. Mark every rendered element with
  a `data-s-<hash>` attribute (the compiler already visits every element in
  `lower.ts`), and rewrite each `<style>` selector to require it. `@scope` was
  evaluated and rejected: its real payoff is *root-only* marking, but reliably
  identifying a component's root through fragments and control-flow callbacks is
  the unreliable part (a miss silently leaks styles). Once we mark every element
  for reliability, `@scope ([data-s-H]) to (:not([data-s-H]))` is functionally
  equivalent to a plain `[data-s-H]` selector for isolation — and the plain
  attribute has *more predictable* specificity (scoped `.btn[data-s-H]` (0,2,0)
  reliably beats a global `.btn` (0,1,0); `@scope` leaves them equal) and no
  browser-baseline dependency. Attribute scoping is also the converged choice of
  Astro/Svelte/Vue.
- **Attribute, not class.** Orthogonal to the reactive `class:list` directive, so
  scoping and class patching never interact (supersedes the format spec's earlier
  "synthetic class" plan).
- **CSS transform via PostCSS** (`postcss` + `postcss-selector-parser`), in the
  compiler as a pure `scopeCss(css, hash)` function (testable standalone; the Vite
  plugin calls it, then Vite's own pipeline handles `url()`/nesting/minify on the
  result). Handles: per-compound selector rewrite, `:global(...)` / `<style
  is:global>` lifted out unscoped, and `@keyframes` name scoping (rename per-hash
  + rewrite `animation`/`animation-name` references) to avoid collisions.
- **CSS variables from state: reuse `style:list`, no `define:vars`.**
  `style:list={{ '--accent': read(m, s => s.x) }}` on an element sets the custom
  property reactively (recompute patches the style attr) — strictly more powerful
  than Astro's static `define:vars`, and one fewer concept. CSS text stays static
  (no `{interpolation}` into CSS); the directive is the sanctioned state→CSS bridge.
- **SSR head injection.** The page collects the scoped CSS of the components it
  rendered and injects it into `<head>` at render time (via the `</head>` sentinel
  flagged in `http.ts`) — independent of client JS. (The build spike's
  "client entry imports the CSS" was a spike simplification; a server-rendered
  page needs its CSS in the head, not gated behind the JS bundle.)

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

### 3b decisions (2026-06-21)

- **Custom-element model: name-match, co-located islands.** A `<script>`'s named
  class exports map to custom-element tags by **kebab-case ↔ PascalCase**
  (`export class QuantityStepper` ↔ `<quantity-stepper>`). The name *is* the
  binding — explicit, visible in both places, no default-export magic. Checked both
  directions: a tag with no matching class → error; a class with no matching tag →
  error (dead code). The hyphen requirement is the platform's (custom elements need
  a `-`); a single-word class is a clear compile error.
- **Server component with client islands is the primary shape.** A `.stator` is
  server-rendered (default export, used as `<ProductCard/>`); its template embeds
  custom-element tags as client islands; the `<script>` defines those islands'
  classes, **co-located** in the same file. Multiple elements per file is the
  normal case (a card with a wishlist heart + a quantity stepper), not a fringe.
  A purely-client widget is the degenerate single-root case. Cross-file island
  reuse (define once, embed in many) is a follow-on — the reusable unit in 1.0 is
  the `.stator` component itself (`<ProductCard/>`), islands live inside it.
- **Hydration seed deferred.** Client actors start from the machine's static
  `context` (= what the server rendered from). No serialized seed channel; 1.0
  client state is ephemeral (drafts, toggles, steppers). Seeding client state from
  a server prop is a documented follow-on.
- **`bind:` drives both** the server initial paint (from the machine's static
  default context, read at compile time) and the client subscribe-and-write.

### 3b build stages

0. **Client runtime primitives** (`src/client/`): `StatorElement` base, `use()` /
   inline `machine()`, the subscribe→selector→diff→write loop, `refs`, the
   `dispatch` helper. Hand-written runtime the generated code calls.
1. **Element detection + name-match validation** (compiler, pure): find
   custom-element tags + `export class` names, validate both directions + hyphen.
2. **`ref:`** → unique keyed attr (server) + typed `this.refs.<name>` (client).
3. **`bind:` one-way** (`text`/`html`/`disabled`/`<attr>`): server initial paint +
   client subscription.
4. **`bind:` two-way** (`value`/`checked` + `|lazy`): loop-break / IME / typed
   values.
5. **`on:` generalized + client `Machine.dispatch`** (the deferred Phase-2 commit;
   identity-import).
6. **`{key}Changed` / `effect`** escape hatch.
7. **Custom-element codegen + client bundle emission**: `customElements.define`
   per island; per-component client bundle + `<script>` injection (dev + build).

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

## Production serve path (decided 2026-06-19)

Dev uses Vite; production must not ship it. Two constraints conflict: routing uses
runtime file-discovery + dynamic `import()` (not statically bundleable), and Node
can't `import` a `.stator` natively. Chosen approach — a **build to `dist/`** that
sidesteps both by reusing the proven `createApp` + `tsx` runtime over precompiled
output:

1. Copy `machines/`, `routes/`, `static/` into `dist/`.
2. Compile each `*.stator` → a sibling `*.stator.ts` (the server module), delete
   the `.stator`, and accumulate its scoped CSS.
3. Rewrite `.stator` import specifiers (`'./x.stator'` → `'./x.stator.ts'`) across
   the copied `.ts` and compiled modules.
4. Write the concatenated scoped CSS to `dist/static/components.css` (one cacheable
   stylesheet; scoped, so over-inclusion per page is inert).
5. Prod server: `createApp` over `dist/` with a `headExtras` hook that links
   `components.css` in `<head>`. No Vite, no loader hooks, no bundler — file
   discovery runs on the precompiled `dist/` exactly as today.

Rejected: a Node ESM loader hook (the compiler is TS; loading it in the loader
thread is fiddly) and full SSR bundling (fights dynamic-import discovery).

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

### Phase 3a built — 2026-06-19 (on `main` via the merged engine + dispatch base)

The server compiler and dev integration are implemented and green (62 tests).

- **Pure compiler** (`src/compiler/`): `split` (regions, bare-vs-attributed
  `<script>`/`<style>` disambiguation), `lower` (JSX → `html\`\`` via the TS AST,
  directives, recursive nested-JSX, scope-attribute injection), `compile` (server
  module: hoisted imports/types, `Stator.props<P>()` → typed `props`, auto-injected
  primitives), `styles` (`scopeCss` via PostCSS: subject-only rewrite, `:global`,
  `@keyframes` rename + animation rewrite), `hash`. The **identical-patches gate**
  proves compiled output ≡ hand-written through the runtime.
- **Vite plugin** (`@statorjs/stator/vite`): routes one `.stator` → server module
  + scoped-CSS `lang.css` virtual; transpiles the emitted TS module with esbuild
  (Vite doesn't run its TS transform on a `.stator` id); `handleHotUpdate`
  invalidates derived modules.
- **Dev server** (`createDevApp`, `src/server/dev.ts`): Vite middleware + the
  stator runtime. Two findings worth recording:
  1. **Load the runtime through Vite** (`ssrLoadModule('@statorjs/stator/server')`),
     not natively — otherwise the templates (Vite instance) and the runtime
     (native instance) get *different* render-context module instances and
     `read()` throws. One instance for runtime + routes + templates is mandatory.
     (`ssr.noExternal: [/@statorjs\/stator/]` forces Vite to transform the
     framework's TS source rather than externalize it.)
  2. **SSR scoped-CSS head injection**: walk the SSR module graph from the route
     file, collect reachable `.stator` files, and inline their compiled `css` into
     a `<style>` in `<head>` via the `headExtras` hook on `buildHonoApp` (uses the
     existing `</head>` insertion point). CSS comes from the compiler (same hash as
     the rendered markers), not Vite's CSS-to-JS dev transform.
- **Discovery** (`discoverMachines`/`discoverRoutes`) gained an injectable
  `ModuleLoader` (defaults to native dynamic import; the dev server injects
  `ssrLoadModule`). A `*.stator` ambient module declaration ships for TS.

Verified end-to-end: a `.stator` route renders through the dev app with the scope
attribute on elements, scoped CSS in `<head>`, and correct event patches.

**Example migration done — 2026-06-19.** All example templates are `.stator`
(layouts, product-list/category-section, cart, checkout, admin); the `.ts`
templates are deleted; the app runs via `createDevApp`. Surfaced + fixed two real
compiler bugs against real templates: a leading `<!doctype>` (not valid JSX —
stripped pre-parse, prepended verbatim) and the JSX rule that `{}` inside a
*quoted* attribute is literal (dynamic classes must use `class={\`…${x}\`}`).
Verified live: all four routes render, ADD_ITEM produces the exact 3 patches,
dynamic category classes correct.

**Production serve path done — 2026-06-19.** `buildApp` (`@statorjs/stator/build`)
compiles a `.stator` app to a `dist/` of plain `.ts` + a concatenated
`components.css`; the prod server runs `createApp` over `dist/` with a
`headExtras` hook linking the stylesheet — **no Vite**. `createApp` gained the
`headExtras` option. Example wired: `pnpm build` (tsx build.ts) → `pnpm start`
(tsx start.ts over dist). One sharp edge: `dist/` must live **inside the app dir**
so module resolution finds the same `@statorjs/stator` copy as the runtime —
otherwise the templates and `renderRoute` get split `render-context` instances and
`read()` throws (the same single-instance requirement the dev server solves via
Vite). Verified: full `build` → `start` cycle serves all routes + patches with no
Vite. Build unit test covers compiled siblings, specifier rewrite, and CSS
collection.

**Next: composition + routes (block A)** — JSX-element component invocation,
the `<children>`/`child="..."` model, `.stator` route pages, and the routing
engine fixes (priority, catch-alls, page+API merge). Specced in
[[component-composition-and-stator-routes]]; sequenced **before** 3b.

**Then: Phase 3b** — client `<script>`, `bind:`/`ref:`, custom elements,
client dispatch.
