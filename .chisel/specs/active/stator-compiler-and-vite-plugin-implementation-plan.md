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

- **Separate-file client components (revised 2026-06-21; was co-located islands).**
  One `.stator` = one component, server **or** client — never both. A `.stator` is a
  *client component* iff it has a `<script>` exporting a `StatorElement` subclass
  whose name kebab-matches its custom-element root tag (`export class
  QuantityStepper` ↔ root `<quantity-stepper>`); otherwise it's a *server component*
  (no `<script>`). File kind is **intrinsic** — derivable by reading the file
  (`extends StatorElement` + custom-element root is a true structural statement, like
  `extends HTMLElement`), NOT an out-of-band signal. Explicitly rejected: a
  `'use client'` pragma or a `@statorjs/stator/client` import path as the signal —
  both are coloring bolted on top (the RSC failure mode). The client helpers
  (`use`/`machine`/`StatorElement`) are auto-injected like the server template
  primitives, so no colored import appears in author code.

  Rationale: co-location quietly broke the "single-file component" invariant — one
  file would define a server template *plus* N client custom elements. Separation
  restores 1 file = 1 component, makes the strict "client bind = client actors"
  rule **structural** (a client template can't `read()` server state — it's not in
  scope; server content arrives via props/attributes or slotted children), and
  removes island-scope detection from the compiler entirely.
- **Name-match (unchanged).** kebab tag ↔ PascalCase class, checked both directions;
  hyphen required (platform rule), single-word class is a clear error. The custom
  element **must be the file's root** — a nested custom element under server chrome
  (`<div><my-toggle/></div>`) is an error (it re-creates the "one file, two
  components" blur). A plain non-Stator custom element is *not* defined in a
  `.stator` `<script>` at all: write its tag as literal markup (Stator emits it
  verbatim) and define it in your own JS module / import a separate Stator client
  component. `.stator` `<script>` = define *this file's* `StatorElement` client
  component, full stop (the "tight" rule — `.stator` never becomes "a file with
  optional client JS").
- **Custom-element name collisions: build-time detection.** Custom-element names are
  a single global registry per document, so two distinct client components both
  producing `<my-toggle>` collide (the 2nd `customElements.define` throws, or the
  `defineElement` HMR-idempotency guard silently no-ops → wrong behavior). Because
  the compiler sees the whole project, the **build / `stator sync` scans all client
  `.stator` and hard-errors on a duplicate tag, naming both files** — turning a
  silent/runtime footgun into a loud early build error. The user owns the namespace
  (platform reality); prefix shared/library elements by convention (`<acme-toggle>`,
  like `<sl-button>`). Rejected: auto-namespacing the tag with a hash
  (`my-toggle-a1b2c3`) — it reintroduces the magic generated name (source ≠ rendered
  DOM), the thing name-match exists to avoid. Limits (documented, not solved):
  collisions with *third-party* web components (defined in node_modules JS, outside
  our scan) surface only at runtime — convention (prefixing) is the mitigation;
  scoped custom-element registries (emerging standard) are the future escape, too
  thin for 1.0.
- **Composition: server component composes client components.** A server template
  imports and invokes a client component uniformly as `<QuantityStepper
  unit-price={product.price}/>` (block A's component invocation) — its render emits
  the `<quantity-stepper …>` shell server-side; the client bundle upgrades it.
  Client-component "props" are attributes (scalar, coerced via `attr()`); arbitrary
  server content passes as slotted children. Same `<Foo/>` at every call site;
  whether a component renders server-side or hydrates is intrinsic to the imported
  file, not a call-site burden.
- **Client reactivity API: member-access with dependency inference (decided
  2026-06-21).** `use(Machine)` returns a live `InstanceOf` proxy (selectors/
  context as properties read through `getSnapshot()` per access — the client mirror
  of the server instance proxy). A `bind:` expression is authored as plain member
  access (`bind:text={qty.count}`); the compiler **infers the reactive
  dependencies** by scanning the expression for referenced `use()` fields,
  subscribes to all of them, and re-evals→diffs→writes on any change. One binding
  mechanism: *(dependency set, value thunk) → subscribe / eval / diff / write*.
  Multi-machine binds (`{qty.count + other.x}`) are handled **identically** — the
  dep set just has more members (N subscriptions, same generated body); there is
  no arity limit and no special case. `read(instance, selector)` survives only as
  an *optional explicit spelling* of the same mechanism (when you want the
  dependency named), not a separate primitive. Signals were rejected — they'd be a
  second reactive system, violating "one reactivity model."
- **Client `bind:` references client actors only (strict rule).** Every reactive
  identifier in a client `bind:` expression must be a `use()` client actor. Server
  state is not locally reactive — it reaches the client via wire patches, a
  separate path — so referencing a server machine in a client bind is a compile
  error. A DOM node mixing client + server state resolves via the value-vs-live-
  source distinction: a server *value* that's constant for the interaction (e.g.
  `unitPrice`) is **seeded into the client machine** (see narrow seed below) and the
  derivation becomes pure-client; only two genuinely-*live* sources on one node is
  the (rare) smell the rule rightly forbids.
- **Narrow hydration seed (A) IN scope; full resume (B) deferred.** Split the
  conflated "hydration seed": (A) a server *value* → a client machine's initial
  context (scalar, server-rendered as an attribute, read on connect) is cheap and
  needed for 1.0 (the Allbirds price-×-quantity stepper is first-class). The engine
  already supports it (`createActor(def, { context })`); the server already renders
  the attribute (3a); the only new piece is `use(Machine, seed)` + a
  `this.attr('name', coerce)` reader. (B) serializing/resuming a server-*run* client
  machine's whole state tree mid-flight stays deferred to a future release —
  revisit once real usage shows the need.
- **`bind:` initial paint at server-render time.** Compute every `bind:` initial
  value by evaluating its selector against the seeded initial context
  (`{ ...static, ...seed }`) at *render* time — selectors are isomorphic, so the
  server runs them — NOT at compile time from static context. This is uniform
  (no static-vs-seeded special case) and makes the narrow seed fall out for free.
  Then the client subscribe-and-write takes over.

### 3b status / resume point (updated 2026-06-21 — separate-file model)

**Stages 0–3 done** (136 tests green, committed): the full client *runtime*
(`StatorElement`/`defineElement`, `use(Machine, seed?)` + live proxy + narrow seed,
the `bind()` loop, terse `machine()`, `effect`, `attr`, `dispatch`) — validated
end-to-end in happy-dom; custom-element name-match (stage 1); `ref:` (stage 2);
`<script>` class analysis (`use()` fields + methods, stage 3). All survive the
separate-file revision unchanged.

**Simplified by separate-file:** a client component is a whole-file custom element,
so there is **no island-scope detection** — the entire template of a client `.stator`
is client-scoped. Revised stages:

4. ✅ **Client-component lowering** (`lower.ts` `client` mode): collect `bind:`/`on:`
   directives under per-element `data-b` markers, infer deps (`inferDeps`), strip
   from the server shell. `ref:` stays `data-ref`.
5. ✅ **Emit the client module** (`client-emit.ts` `emitClientModule`): auto-inject
   the client primitives import, keep the user class, generate a `__<Name>Impl
   extends <Name>` subclass whose `setup()` wires each directive (`bind(...)` /
   `addEventListener`), `defineElement(impl, tag)`. Member refs (`qty.count`, `inc`)
   rewritten to `this.<member>`. One-way binds (text/html/disabled/checked/attr) +
   on: done and proven running in happy-dom. **Remaining (additive):** two-way
   `bind:value|checked` (+ `|lazy`) with loop-break/IME; `{key}Changed`/`effect`;
   client `Machine.dispatch`.
6. **Compile integration + bundle + injection + collision check** (NEXT). Wire
   stages 4–5 into `compile()`: detect a client file (has `<script>` exporting a
   `StatorElement` subclass matching a custom-element root tag); produce BOTH the
   server shell render module AND the client module. Per-component client entry;
   server emits the `<script type=module>` tag; wire dev + build. Build/`stator sync`
   hard-errors on duplicate custom-element tags (global-registry collision) +
   enforces root-must-be-the-custom-element.

   **Open decision (gates stage 6): server→client prop passing.** When a server
   template invokes `<QuantityStepper unitPrice={product.price}/>`, the client
   component's server module must render `<quantity-stepper unit-price="12.00">…
   </quantity-stepper>` — props become **root attributes** read via
   `this.attr('unit-price', Number)`. Decide: camelCase prop → kebab attribute
   mapping; scalars-only (attributes are strings — what about non-scalar?); how
   server *content* passes (slotted children vs attrs). Interacts with the narrow-
   seed model. Resolve before building stage 6.

**Open: client dynamic lists** (a list whose length changes purely client-side).
Raised 2026-06-21; not yet designed. See the client-model spec — most ecommerce
"lists" are actually *server* lists (re-rendered via `each`/recompute wire patches)
or fixed-shape lists the client only toggles, so genuine client dynamic lists are
rarer than they seem; the hard case (client-only add/remove with no client JSX
renderer) likely reuses Phase-4 keyed-each's diff algorithm with `<template>`
cloning as the node factory. Decide scope before stage 4/5 if Allbirds needs it.

### 3b build stages

**Superseded by the separate-file revision — the authoritative stage list lives in
the "3b status / resume point" section above** (stages 0–3 done; 4 client-component
lowering; 5 emit class + `setup()`; 6 client bundle + injection + collision check).
The earlier co-located "per island / island-scope" framing here is obsolete; kept
only as history. Done so far: ✅ 0 runtime, ✅ 1 name-match, ✅ 2 `ref:`, ✅ 3 script
analysis.

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
