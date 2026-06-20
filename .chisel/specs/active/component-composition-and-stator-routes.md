---
title: Component composition and stator routes
status: draft
created: 2026-06-19
updated: 2026-06-19
area: compiler
---

## What and Why

Phase 3a proved the `.stator` server compiler, but two gaps make the authoring
story feel unfinished — and both undercut the marketing pitch that `.stator` is
*the* way to build:

1. **Composition is sloppy.** Components are invoked as plain functions and a
   layout receives its content as a pre-rendered `body: HtmlFragment` prop
   (`customerLayout({ cart, body: productList({...}) })`). There's no real
   composition — the layout splices opaque HTML.
2. **Routes can't be `.stator`.** A route is `.ts` wiring that imports templates.
   The common case — "a page is its markup" — takes two files.

This spec ("block A") closes both with one coherent feature: **JSX-element
component invocation with a children/named-children model**, plus **`.stator`
route pages**. It also fixes routing gaps the route-page work exposes (priority,
catch-alls, page+API merge), using **Astro's router as the baseline** (a
battle-hardened specificity model). All server-side; builds directly on the 3a
compiler. Sequenced **before 3b** (the client plane), because it completes the
server authoring story and makes the framework feel whole.

## The composition model

### Component invocation

A capitalized JSX tag is a **Stator component invocation**; a lowercase tag is a
literal HTML element (including hyphenated custom elements like
`<counter-widget>`, which are web components, not Stator components). This matches
React/Astro/Solid.

```jsx
// before (function call, eager fragment prop)
{customerLayout({ cart, body: productList({ products, cart }) })}

// after (JSX element + children)
<CustomerLayout cart={cart}>
  <ProductList products={products} cart={cart} />
</CustomerLayout>
```

`<ProductList products={x} cart={y} />` lowers to a call of the imported
component: `ProductList({ products: x, cart: y })` (the default export of
`product-list.stator`, a `(props) => HtmlFragment`). The capitalized tag must
resolve to an in-scope imported identifier; the compiler errors otherwise.

### Children — the `<children>` mechanism (NOT `<slot>`)

We deliberately avoid the term `slot`: the web platform owns `<slot>` / `slot=""`
/ `part=""`, and 3b leans on custom elements that may use native `<slot>` for real
shadow-DOM distribution at runtime. A compile-time `<slot>` next to a runtime
native `<slot>` in the same file would be genuinely ambiguous (a sharper problem
than Astro's, since Astro doesn't use custom elements — and Astro regretted `<slot>`
anyway). So:

- **`<children />`** — default placeholder. Receives all unnamed children of the
  invocation, in source order.
- **`<children name="banner" />`** — named placeholder.
- **`child="banner"`** — caller-side marker on an element: "this is content for the
  `banner` region." Plain attribute (value = region name), mirroring the platform's
  own `slot="x"` value form one-to-one (just off the reserved word). `child` is not
  a reserved HTML/SVG/ARIA attribute, so it's collision-safe.
- **`child:modifier="banner"` is reserved** — the colon namespace stays open for
  future modifiers (scoped fallback, transform, conditional placement). Spending
  the colon on the *name* would foreclose that; value form keeps it free.

Plural `<children>` = the collector; singular `child` = a member. No fragment is
ever required in author-facing `.stator`: multiple children of a component are
native JSX nesting, and a multi-root template body is auto-wrapped by the compiler
(the 3a `<>…</>` wrap). **Rule: the author never writes `<>`; the compiler supplies
it.**

```jsx
// customer-layout.stator
<header><children name="banner"/></header>
<main><children/></main>

// caller
<CustomerLayout cart={cart}>
  <div child="banner">Free shipping over $50</div>
  <ProductList products={products} cart={cart} />   {/* → default <children/> */}
</CustomerLayout>
```

### Children semantics: eager, one render pass

Children render **eagerly at the call site**, in source order, then the component
splices them at its `<children>` placeholder(s). This is exactly today's behavior
(`productList(...)` already renders before being passed as `body`) — the new
syntax only changes the spelling, so `read()` bindings still register against the
active `RenderState` in one synchronous render and slot ids allocate correctly
(the 3a identical-patches test already covers nested rendering). Internally the
compiler passes a `children` value (default + named) into the component; `<children/>`
lowers to the default, `<children name="x"/>` to the named entry.

## `.stator` route pages

A `routes/*.stator` file is a **page**: frontmatter declares its machine reads and
optional route config; the body is the page markup. It compiles to a
`routes/*.stator.ts` exporting `GET = defineRoute(...)`. `routes/*.ts` is unchanged
— it stays for API / markup-less routes (`defineApiRoute`, redirects).

```jsx
// routes/index.stator
---
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'
import CustomerLayout from '../templates/customer-layout.stator'
import ProductList from '../templates/product-list.stator'

const [cart, products] = Stator.reads([CartMachine, ProductsMachine])
---
<CustomerLayout cart={cart}>
  <ProductList products={products} cart={cart} />
</CustomerLayout>
```

- **Value imports** of machines (a route needs the real def for its `reads:`
  graph), distinct from a *component's* type-only machine imports.
- **`Stator.reads([...])`** — compile-time marker; the argument is an **array**,
  mirroring `defineRoute({ reads: [...] })`. Destructure is **positional**
  (`const [cart, products] = Stator.reads([CartMachine, ProductsMachine])`) — the
  order matches the array. The compiler lifts the machine list into
  `defineRoute({ reads: [...] })` and binds the positional instances from the
  render context (keyed internally by machine `name`, but the author addresses them
  positionally). (Decided 2026-06-19.)
- **`Stator.route({ live: true })`** — optional, for route config (SSE, etc.),
  consistent with `Stator.props` / `Stator.reads`.

## Routing engine (Astro baseline)

The route-page work exposes three gaps in the current router, all fixed here.

### Priority / specificity (currently broken)

Today `matchPath` returns the *first* matcher in filesystem-walk order — no
specificity sort, so `/about` (static) vs `/[slug]` (param) is order-dependent (a
bug). Adopt **Astro's specificity model**: sort all routes most-specific-first,
then first match wins. Stated for review (Astro baseline — correct if this matches
your memory of the router):

- **Static routes** (no params) take precedence over any dynamic route.
- **Per segment, left to right**, more specific wins: `static` > named param
  `[x]` > rest/spread `[...x]`.
- **Named params** take precedence over **rest params**.
- **Rest params** have the lowest priority and match greedily (zero or more
  segments).
- **Ties resolved alphabetically.**
- `routes/index.stator` (`/`) ranks **above** a root `routes/[...slug].stator`
  (also matches `/`) — index is static, the catch-all is a rest param. (Confirmed.)
- (Astro also gives endpoints precedence over pages; for us GET-page vs `.ts`-API
  differ by *method*, handled by the merge rule below, so this is moot.)

**Out of scope for 1.0: prerendering / `getStaticPaths`.** Astro can resolve a
catch-all more precisely when it's prerendered (the route declares the exact URLs
it builds). Stator 1.0 is server-canonical / render-on-demand, so there's no
build-time URL enumeration — catch-alls resolve purely by the runtime specificity
rules above. A prerender mode (with declared paths feeding the sort) is a possible
future addition, not 1.0.

### Catch-all / rest params (currently unsupported)

`filePathToRoute` only parses `[name]` → `:name`. Add `[...name]` → a rest param
that matches zero or more segments (value is the matched path incl. slashes, or
empty). Matcher regex: a rest segment compiles to `(.*)` rather than `([^/]+)`;
`params.name` carries the joined remainder. `routes/[...slug].stator` matches
`/`, `/a`, `/a/b` (the CMS/404 catch-all pattern).

### page.stator + page.ts (same basename)

Resolve at the **method level**, not the file level: a `.stator` page contributes
`GET`; a sibling `.ts` of the same basename may contribute `POST`/`PUT`/etc. They
**merge** into one `DiscoveredRoute` (a real pattern — a page that also handles its
own form POST). Two files defining the **same** method for the same URL → a hard
discovery error with a clear message.

## Constraints

- **No runtime change.** Like 3a, this is a source-to-source transform: component
  invocation lowers to function calls, `<children/>` to spliced fragments, route
  pages to `defineRoute`. The runtime, recompute, and wire format are untouched.
- **Capitalized = component, lowercase = HTML.** Hyphenated custom elements stay
  literal HTML (web components, 3b). A capitalized tag with no matching import is a
  compile error.
- **Eager children, one render pass.** Children must render synchronously within
  the route's render so bindings register; no async, no deferral (matches the
  existing eager model).
- **Explicit reads on route pages.** `Stator.reads(...)` is required to surface a
  page's machine dependencies (preserves the explicit-reads invariant); no implicit
  auto-binding from `read()` calls in the body.
- **Astro routing semantics as baseline**, deviating only where Stator genuinely
  differs (e.g. the method-merge rule, which Astro's prerender/endpoint split
  doesn't need).

## Type generation (prop typing)

Caller-side prop typing must work — `<ProductList products={x}/>` typechecks
against the component's `Stator.props<P>()`. This is a major DX/safety win and a
decided requirement (2026-06-19). The blocker is the ambient `declare module
'*.stator'` wildcard, which types the default export as `(props?: any)`.

**Approach: per-component typegen** (the Astro `sync` / svelte-check / vue-tsc
pattern). A typegen step emits a `<name>.stator.d.ts` next to each component:

```ts
// product-list.stator.d.ts (generated)
import type { InstanceOf, HtmlFragment } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'
declare const _default: (props: {
  products: InstanceOf<typeof ProductsMachine>
  cart: InstanceOf<typeof CartMachine>
}) => HtmlFragment
export default _default
```

TS resolves `import ProductList from './product-list.stator'` to the specific
`product-list.stator.d.ts` (which beats the `*.stator` wildcard), so the caller
gets real prop types and `<ProductList .../>` is checked. The `.d.ts` carries the
frontmatter's type imports (which the compiler already separates) plus `P` from
`Stator.props<P>()`. The wildcard ambient remains as the fallback for
not-yet-synced files.

Runs in dev (watch regenerates on `.stator` change) and as a `stator sync`-style
step before `tsc`. Components without a `<style>`/props still get a `.d.ts` for
the default-export signature.

## Request / response access (route-scoped)

A `.stator` route page (and `defineApiRoute` handlers) can read the incoming
request and write the outgoing response via an ambient, mirroring Astro's
`Astro.request` / `Astro.response` — but **scoped to routes only**, never general
components. This is more disciplined than Astro (where any component can read
`Astro.request` and silently become request-coupled) and is dead-on the framework
thesis: request data enters at the route boundary and flows down explicitly.

```jsx
// routes/dashboard.stator
---
const [user] = Stator.reads([UserMachine])
const lang = Stator.request.headers.get('accept-language')   // read incoming
Stator.response.headers.set('cache-control', 'private')      // set outgoing
---
<Layout><h1>Hi</h1></Layout>
```

- `Stator.request` wraps the existing `RouteRequest` (params/query/headers/method/
  body); `Stator.response` writes to the existing response side-effect surface
  (`RenderedResponseEffects` — headers/cookies/status).
- Mechanism: a **runtime accessor reading the active render context** — the same
  ambient pattern `read()` already uses (`requireCurrentRenderState`). No compiler
  rewrite needed; works in `.ts` routes too.
- In a **component** (`templates/*.stator`), `Stator.request` / `Stator.response`
  is a **compile error**: "request/response are route-only; pass the value down as
  a prop." (Requires compilation-context awareness — below.)

## Diagnostics and compilation context

The route-only rule (and several others) means the compiler must know **what kind
of file it's compiling** and must report errors well. Both are cross-cutting —
they serve every compile-error case (this spec's, plus 3b's). Built first /
alongside stage 1.

**Compilation context.** `compile()` gains a `kind: 'route' | 'component'` option
(the Vite plugin / build sets it from the directory — `routes/` → route, else
component). `kind` gates a capability matrix:

| frontmatter capability                | component | route page |
|---------------------------------------|-----------|------------|
| `Stator.props<P>()`                   | ✓         | ✗ (no parent props) |
| type-only machine imports             | ✓         | —          |
| value machine imports + `Stator.reads([...])` | ✗ | ✓        |
| `Stator.request` / `Stator.response`  | ✗         | ✓          |
| `// @stator live` pragma              | ✗         | ✓          |

Each illegal use is a clear compile error naming the rule and the fix.

**Located diagnostics.** `CompileError` gains a location (`file`, `line`,
`column`) and a code frame, derived from the offending TS AST node
(`getLineAndCharacterOfPosition`). The Vite plugin maps `CompileError` →
Vite's error shape (`loc` + `frame`) so the dev overlay and terminal both show
file:line:col with a snippet. Messages follow a consistent "what's wrong → how to
fix" form. This replaces today's bare-string throws across the whole compiler.

## Approach (stages)

0. **Diagnostics + context** — `kind: 'route' | 'component'` on `compile()`;
   located `CompileError` (file/line/col + frame) mapped to Vite's error shape;
   the capability matrix gate. Foundational — stages 1–3 report through it.
1. **Component invocation** — capitalized-tag resolution in `lower.ts`; lower to a
   call with a props object; error on unresolved tag.
2. **Children** — collect a component invocation's children (default + `child="x"`
   named), pass as a `children` value; lower `<children/>` / `<children name>` in
   the component body. Wire scope-attribute injection to skip the `<children>`
   pseudo-element. **Validate named children**: a `child="x"` whose target
   component declares no `<children name="x"/>` is a **compile error** (decided
   2026-06-19). This requires *cross-file resolution* — compiling a caller resolves
   each `<Component>` import, reads the callee's declared region names, and checks
   every `child=` against them (plus the implicit default). This is the compiler's
   first cross-file analysis (it has been file-at-a-time); the resolved region set
   per component is cached and also feeds typegen.
3. **Route pages** — `Stator.reads` / `Stator.route` rewrite in the route-`.stator`
   compile path; emit `GET = defineRoute(...)`; directory-based detection
   (`routes/*.stator`).
4. **Routing engine** — rest-param parsing (`[...name]`), specificity sort, the
   method-merge rule in discovery.
5. **Typegen** — emit `<name>.stator.d.ts` per component (prop typing above); wire
   into dev watch + a sync step.
6. **Migrate the example** to component-invocation + `.stator` routes; delete the
   `body: HtmlFragment` plumbing.

## Alternatives Considered

- **`<slot>` (Astro/Svelte/Vue term).** Rejected — collides with the web platform,
  and worse for us than Astro because 3b uses custom elements with native `<slot>`.
- **`children` + `fill:` marker.** Rejected — mixed root words (`children` vs
  `fill`); `child`-rooted naming is more consistent and `fill` collides with SVG.
- **`child:banner` (namespaced marker).** Considered — consistent with `ref:`/`on:`.
  Rejected in favor of `child="banner"` (value form): a region name is a static
  identifier (belongs in a value, like the platform's own `slot="x"`), and the
  value form keeps `child:modifier` reserved for future modifiers.
- **Lazy component props / thunks for `body`.** Rejected — the degenerate
  single-child case of children; slots/children subsume it and handle multi-region.
- **Auto-binding route reads from `read()` calls in the body.** Rejected — breaks
  the explicit-reads invariant and the static-analyzability the framework rests on.
- **Custom routing instead of Astro's model.** Rejected — Astro's specificity
  rules are battle-tested; no reason to reinvent.

## Open Questions

### Resolved (2026-06-19)

- **Pragma form** → **`// @stator live`** (comment pragma, `@`-tag style like
  `@ts-check`/`@vite-ignore`). Placed at the top of the route frontmatter. The
  compiler validates the keyword against a fixed mode-flag set and errors on a typo
  (e.g. `// @stator liev`). Rationale: `live` is a **build-time** directive — its
  job is "compiler, emit `live: true` into this route's `defineRoute`"; the SSE
  behavior is a downstream runtime consequence (like Go's `//go:build` having
  runtime consequences yet being a build directive). Build-time directives
  conventionally use **comments** (Go `//go:build`, TS `///`, Vite/Webpack magic
  comments); the string-literal `'use X'` prologue is reserved for *runtime*
  directives (`'use strict'`/`'use client'`) and borrowing it for a build flag
  mildly misleads. Principle recorded for future flags: **build-time directives →
  comment pragma** (`// @stator …`); a genuine *runtime* module-mode (none yet)
  would use the string-literal prologue. Structured config (headers/cache) is never
  a pragma — it lives in the request/response surface.

- **Named-child validation** → in scope: a `child="x"` with no matching
  `<children name="x"/>` in the target component is a compile error. Needs
  cross-file region resolution (see stage 2).

- **`Stator.reads` form** → `Stator.reads([CartMachine, ProductsMachine])` (array
  arg, mirrors `defineRoute({ reads })`), **positional** destructure.
- **Prop typing** → yes, required; via per-component `.stator.d.ts` typegen (see
  Type generation). 
- **`index` vs root catch-all** → index wins (static > rest param), confirmed.
- **Routing priority rules** → confirmed against Astro's model.
- **Prerendering / `getStaticPaths`** → out of scope for 1.0 (render-on-demand).
- **Route config syntax** → a build-time **comment pragma** (`// @stator live`) for boolean
  rendering-mode flags; structured response config (headers/status) lives in the
  request/response surface, not route-config keys. `export const`-style config
  (option B) rejected — looks like a real export but is consumed/stripped (the
  compiled module exports `GET`), a known Astro misstep.
- **Request/response access** → `Stator.request` / `Stator.response`, **route-scoped
  only** (compile error in components); ambient accessor over the existing render
  context + response side-effect surface.

## Implementation Notes

(Not started. Spec for review. Builds on the 3a compiler
[[stator-compiler-and-vite-plugin-implementation-plan]]; precedes Phase 3b. Uses
Astro's router as the routing-specificity baseline.)
