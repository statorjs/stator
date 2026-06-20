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

## Approach (stages)

1. **Component invocation** — capitalized-tag resolution in `lower.ts`; lower to a
   call with a props object; error on unresolved tag.
2. **Children** — collect a component invocation's children (default + `child="x"`
   named), pass as a `children` value; lower `<children/>` / `<children name>` in
   the component body. Wire scope-attribute injection to skip the `<children>`
   pseudo-element.
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

- **Route config surface.** `Stator.route({ live: true })` (leaning — `Stator.*`
  consistency, scales to more options) vs a frontmatter `export const live = true`.
  Could also defer until a second option beyond `live` exists.
- **Typed children.** Should a component declare which named children it accepts
  (so `child="typo"` is a compile error)? Nice-to-have; likely defer past block A.

### Resolved (2026-06-19)

- **`Stator.reads` form** → `Stator.reads([CartMachine, ProductsMachine])` (array
  arg, mirrors `defineRoute({ reads })`), **positional** destructure.
- **Prop typing** → yes, required; via per-component `.stator.d.ts` typegen (see
  Type generation). 
- **`index` vs root catch-all** → index wins (static > rest param), confirmed.
- **Routing priority rules** → confirmed against Astro's model.
- **Prerendering / `getStaticPaths`** → out of scope for 1.0 (render-on-demand).

## Implementation Notes

(Not started. Spec for review. Builds on the 3a compiler
[[stator-compiler-and-vite-plugin-implementation-plan]]; precedes Phase 3b. Uses
Astro's router as the routing-specificity baseline.)
