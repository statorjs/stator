# V1 compiler — design against real example templates

Status: design exploration. The runtime is stable; the compiler is a
contained second project. This note hand-rewrites the four
`apps/example/templates/*.ts` files in a plausible `.stator` SFC format and
captures the surprises that emerge from the exercise.

## Why hand-rewrite first

Designing the SFC format in the abstract surfaces the easy decisions
(JSX-flavored body, `<style>` blocks, frontmatter for imports) but hides the
ergonomic friction points that only appear when you actually try to express
real flows. The runtime model is locked; the format's job is to lower
cleanly onto it without losing the runtime's correctness properties (slot
binding, scope subsumption, explicit reads).

## Proposed format

```
---
// Frontmatter — TypeScript. Imports + props declaration. Runs once per
// render, before the body.
import { read, each, when, match, on, classList } from 'stator/template'
import type CartMachine from '../machines/cart.ts'

interface Props {
  cart: InstanceOf<typeof CartMachine>
}
const { cart } = Stator.props<Props>()
---

<!-- Body — JSX-flavored. {expr} interpolates. on:event={fn} for events.
     class:list={spec} for compound class. <></> for fragments. -->
<section class="cart">
  <h1>Cart: {read(cart, c => c.itemCount)}</h1>
</section>

<style>
  /* Scoped to this component via a synthetic class injected by the compiler. */
  .cart h1 { color: red; }
</style>
```

Compiler emits a `.ts` module that the existing runtime consumes:

```ts
// emitted from the .stator file above
import { html, read } from 'stator/template'
import type CartMachine from '../machines/cart.ts'

interface Props { cart: InstanceOf<typeof CartMachine> }

export default function (props: Props) {
  const { cart } = props
  return html`<section class="cart">
    <h1>Cart: ${read(cart, c => c.itemCount)}</h1>
  </section>`
}
```

`<style>` blocks are extracted into separate CSS output keyed by a hash;
the synthetic class is injected into every element in the body. (V1+
detail; not covered here.)

## The four templates, hand-rewritten

### `layout.stator`

```
---
import { read } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type { HtmlFragment } from 'stator/template'

interface Props {
  cart: InstanceOf<typeof CartMachine>
  body: HtmlFragment
}
const { cart, body } = Stator.props<Props>()
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>stator demo</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <header class="site-header">
      <a href="/" class="brand">stator demo</a>
      <nav>
        <a href="/">Products</a>
        <a href="/cart">Cart ({read(cart, c => c.itemCount)})</a>
        <a href="/checkout">Checkout</a>
      </nav>
    </header>
    <main>{body}</main>
    <script src="/static/client.js"></script>
  </body>
</html>
```

### `product-list.stator`

```
---
import { read, each, on, classList } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

const { products, cart } = Stator.props<{
  products: InstanceOf<typeof ProductsMachine>
  cart: InstanceOf<typeof CartMachine>
}>()
---

<section class="products">
  <h1>Products</h1>
  <ul class="product-grid">
    {each(read(products, p => p.all), (product) => (
      <li class="product-card">
        <h3>{product.name}</h3>
        <p class="description">{product.description}</p>
        <p class="price">${product.price.toFixed(2)}</p>
        <button
          on:click={() => cart.send({ type: 'ADD_ITEM', productId: product.id })}
          class:list={{
            'add-btn': true,
            'in-cart': read(cart, c => c.contains(product.id)),
          }}
        >
          {read(cart, c => c.contains(product.id) ? 'In cart' : 'Add to cart')}
        </button>
      </li>
    ))}
  </ul>
</section>
```

### `cart-page.stator`

```
---
import { read, each, on, when } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

const { cart, products } = Stator.props<{
  cart: InstanceOf<typeof CartMachine>
  products: InstanceOf<typeof ProductsMachine>
}>()
---

<section class="cart">
  <h1>Cart</h1>
  <p class="cart-summary">
    Items: {read(cart, c => c.itemCount)} —
    Total: ${read(cart, c => c.total.toFixed(2))}
  </p>
  <ul class="cart-items">
    {each(read(cart, c => c.items), (item, idx) => (
      <li class="cart-item">
        <span class="cart-item-name">
          {products.byId(item.productId)?.name ?? item.productId}
        </span>
        <span class="cart-item-price">${item.unitPrice.toFixed(2)}</span>
        <span class="cart-item-qty">
          <button on:click={() => cart.send({ type: 'DECREMENT', productId: item.productId })}>−</button>
          <span>{read(cart, c => c.items[idx]?.quantity ?? 0)}</span>
          <button on:click={() => cart.send({ type: 'INCREMENT', productId: item.productId })}>+</button>
        </span>
        <button class="cart-item-remove" on:click={() => cart.send({ type: 'REMOVE_ITEM', productId: item.productId })}>remove</button>
      </li>
    ))}
  </ul>
  <div class="cart-actions">
    {when(read(cart, c => !c.isEmpty), () => (
      <>
        <button on:click={() => cart.send({ type: 'CLEAR' })}>Clear cart</button>
        <a href="/checkout" class="checkout-link">Go to checkout →</a>
      </>
    ))}
  </div>
</section>
```

### `checkout-page.stator`

```
---
import { read, on, match } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type CheckoutMachine from '../machines/checkout.ts'

const { checkout, cart } = Stator.props<{
  checkout: InstanceOf<typeof CheckoutMachine>
  cart: InstanceOf<typeof CartMachine>
}>()
---

<section class="checkout">
  <h1>Checkout</h1>
  <p class="state-label">Current state: {read(checkout, c => c.state)}</p>

  {match(read(checkout, c => c.state), {
    shipping: () => (
      <div class="step">
        <h2>1. Shipping</h2>
        <p>Name: {read(checkout, c => c.shippingName)}</p>
        <p>Address: {read(checkout, c => c.shippingAddress)}</p>
        <div class="step-actions">
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' })}>Set name</button>
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'shippingAddress', value: '123 Demo St' })}>Set address</button>
          <button on:click={() => checkout.send({ type: 'SUBMIT_SHIPPING' })}>Continue to payment →</button>
        </div>
        <p class="hint">Both name and address must be set; the guard blocks the transition otherwise.</p>
      </div>
    ),
    payment: () => (
      <div class="step">
        <h2>2. Payment</h2>
        <p>Card last 4: {read(checkout, c => c.paymentLast4)}</p>
        <div class="step-actions">
          <button on:click={() => checkout.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '4242' })}>Set card</button>
          <button on:click={() => checkout.send({ type: 'BACK' })}>← Back</button>
          <button on:click={() => checkout.send({ type: 'SUBMIT_PAYMENT' })}>Place order</button>
        </div>
      </div>
    ),
    complete: () => (
      <div class="step">
        <h2>3. Complete</h2>
        <p>Thanks! Order number: <strong>{read(checkout, c => c.orderNumber)}</strong></p>
        <div class="step-actions">
          <button on:click={() => checkout.send({ type: 'RESET' })}>Start a new order</button>
        </div>
      </div>
    ),
  })}
</section>
```

## Surprises and decisions surfaced

### 1. Explicit reads must not be auto-converted

The principle "explicit reads via `read(machine, selector)`" is load-bearing.
A naive JSX compiler that sees `{cart.itemCount}` and turns it into a
reactive binding (Svelte / Solid style) would break the framework's
contract — the developer must opt into reactivity per slot.

**Rule:** the compiler treats `{expr}` as a one-shot interpolation (current
behavior of `${expr}` in tagged templates). Only `{read(...)}` produces a
bound slot. The JSX layer is purely sugar over the existing primitives;
reactivity semantics are unchanged.

This is enforceable at compile time: if the compiler detects a binding
pattern that doesn't go through `read`, that's a plain expression. No
heuristics, no inference.

### 2. Directive syntax: colon discriminator

`on:click={handler}`, `class:list={spec}`, `style:list={spec}` — all
directives appear as attribute-shaped syntax with a colon discriminator.
The parser distinguishes a directive (`name:modifier`) from a normal
attribute (`name`) by the colon presence.

The pattern extends cleanly to future directives (`bind:value` when client
signals arrive, `transition:fade`, `use:autofocus`, etc.). All are
desugared by the compiler to `${invoke(directive, modifier, arg)}` in the
emitted tagged-template form.

### 3. `each` / `when` / `match` — callback form, not component form

JSX idiom would suggest `<Each items={...}>{(item) => <li>...</li>}</Each>`.
This has two problems:

- **`<When>` breaks JSX evaluation semantics.** Stock JSX evaluates all
  children eagerly. A `<When cond={false}>` whose body contains
  `<button on:click={fn}>` would *evaluate* the children — registering
  event handlers, allocating slots — even though they wouldn't render.
  Avoiding this requires the compiler to lift children into a deferred
  function, which is unusual JSX and surprises developers.
- **The callback form already matches the runtime.** `{when(cond, () =>
  <body/>)}` is a one-to-one translation to the existing `when(cond, fn)`
  runtime call. No magic.

**Decision:** callback form is the baseline. Component-form sugar
(`<When>`, `<Each>`, `<Match>`) is a future ergonomic decision; if added,
it desugars to the callback form at the compile step, not as runtime
indirection.

### 4. Props accessor

`Stator.props<Props>()` is a compile-time hook — the compiler rewrites it
to the function-signature form in the emit:

```ts
// .stator source
const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()

// emitted
export default function (props: { cart: InstanceOf<typeof CartMachine> }) {
  const { cart } = props
  ...
}
```

Alternative considered: `export const props = ...` magic identifier (Astro
style). Stator.props() reads more honestly as "this is where props come
from" and avoids a magic export. Either works.

### 5. Inline arrow callbacks must close over rendered context, not module context

Inside `each(items, (item) => ...)` the callback closes over `item` and any
outer-scoped names from frontmatter. The compiler must preserve this
closure correctly when emitting tagged-template form. Today's runtime does
this naturally because the callback is a real function; the compiler just
needs not to break it.

Risk: a naive AST transform that lifts callbacks out of their lexical
position breaks. Solution: emit callbacks in-place inside the tagged
template literal.

### 6. Imports: type vs value, and which subset survives

```ts
import { read, each, when, match, on, classList } from 'stator/template'
import type CartMachine from '../machines/cart.ts'  // type-only
```

`stator/template` imports are values used at runtime — emitted as-is.
`import type` imports are erased.

But: `import CartMachine from '../machines/cart.ts'` (not type-only) would
be a value import — the template doesn't actually instantiate the machine,
but it does *typeof* it (`InstanceOf<typeof CartMachine>`). If treated as
a value import, it pulls the machine module into the template's bundle,
which is unnecessary and creates noisy dependency graphs.

**Decision:** require `import type` for machine references in templates.
The compiler can lint for non-`type` machine imports in `.stator` files
and emit a clear error pointing to this rule.

### 7. Frontmatter expressions evaluate once per render

`const { cart } = Stator.props<...>()` runs once per render. Anything else
the developer puts in frontmatter — destructuring, helper functions, local
constants — runs once per render too. This matches Astro's model and the
existing tagged-template render function semantics.

What this means: side effects in frontmatter happen per render. Should
they? Probably document as "don't do that," but the compiler can't prevent
it. Same trap exists today in tagged-template files; not new.

### 8. The dollar-sign collision

In tagged template literals, `${...}` is the interpolation syntax. In JSX,
`{...}` is interpolation and `$` is literal. The transition is mostly
fine, with one case: prices.

```jsx
<p class="price">${product.price.toFixed(2)}</p>
```

JSX renders this as literal `$` followed by the interpolation. In emitted
tagged-template form it becomes `<p class="price">$${product.price.toFixed(2)}</p>`
— the compiler must escape the literal `$` so it's not treated as the
start of an interpolation.

Risk: easy to forget. Compiler emits should always escape literal `$`
characters from JSX text content into `\$` (or use String.raw idioms) to
guarantee they round-trip correctly.

### 9. JSX fragments map to `<></>` and emit nothing in the wrapper

`when`'s callback body is often multi-element:

```jsx
{when(cond, () => (
  <>
    <button>Clear cart</button>
    <a href="/checkout">Checkout</a>
  </>
))}
```

`<></>` is a JSX fragment with no wrapping element. The compiler emits the
body of the fragment as a tagged-template fragment — i.e. multiple sibling
elements inside one `html\`...\``. No wrapper element added.

### 10. Scoped styles + `class:list` interaction

`<style>` blocks get scoped via a synthetic class name (e.g. `s-abc123`)
injected onto every element in the body. But `class:list` *owns* the
entire `class` attribute. If the compiler naively writes `class="s-abc123"`
on an element that also has `class:list={...}`, both directives try to
own the same attribute — failing the one-source rule the runtime enforces.

**Decision:** scoped styles' synthetic class is injected *through* the
class:list spec when one exists. The compiler rewrites:

```jsx
<button class:list={{ 'add-btn': true, 'in-cart': read(...) }}>
```

into:

```jsx
<button class:list={['s-abc123', { 'add-btn': true, 'in-cart': read(...) }]}>
```

Same for elements with a plain `class="foo"` — that becomes `class="foo s-abc123"`.
For elements with neither, the compiler emits `class="s-abc123"`. The
class:list runtime already handles `string | array | object`, so no runtime
changes are needed.

### 11. Compile-time slot analysis becomes possible

The POC does slot tracking at runtime via the tagged-template render. With
a compiler, `read()` calls are statically discoverable — the compiler can
emit the slot-machine map at build time, eliminating the runtime slot
allocation pass entirely. This is the spec's original "compile-time slot
analysis" vision, deferred to V1.

Specifically: every `read(machine, selector)` in the template becomes a
statically-numbered slot. The emit doesn't need `allocSlotId` calls; slot
ids are baked into the output as literals. The framework's runtime just
needs to maintain the binding map populated from static metadata at first
render.

This is a meaningful perf win and a meaningful schema-export win
(every binding's machine + selector is known at build time, exportable
without running anything).

### 12. Keyed `each` for stable identity

JSX convention is `key={...}`. The natural form:

```jsx
{each(read(cart, c => c.items), (item) => (
  <li key={item.productId}>...</li>
))}
```

The compiler extracts the `key` prop and rewrites to a future keyed `each`
runtime call:

```ts
each(read(cart, c => c.items), (item) => html`<li>...</li>`, {
  key: (item) => item.productId,
})
```

This unlocks the V1 wire-format reservation for `insert` / `remove` /
`move` patches — the runtime would compare old and new key arrays and emit
fine-grained patches instead of a full subtree `html` patch.

## What to do next

This note is a sketch, not a spec. To proceed:

1. Pick a JSX-to-tagged-template compiler base. Candidates: a TS AST transform
   (typescript / ts-morph), a Babel plugin, a custom parser (Astro's
   approach). Recommend TS AST transform — type-aware, matches stator's
   ESM-only model, no Babel weight.
2. Build a single-file compile path that handles one of these four
   templates end-to-end. Start with `layout.stator` (simplest).
3. Run the existing example app with the compiled output substituted for
   the hand-written `.ts`. End-to-end tests pass: format works.
4. Expand to `each` / `when` / `match` / `class:list`. Verify the
   one-source-per-attribute rule holds through the compile (it should,
   since the rule is enforced by the runtime parser).
5. Add scoped styles last. Compile to CSS module-keyed output.

Compile-time slot analysis and keyed `each` are V1.5 — ship the format
first against the existing runtime; optimize the runtime path after the
format is stable.

## Open questions

- **JSX or HTM-like?** JSX is more familiar, has tooling. HTM (tagged
  template literals with HTML syntax) needs no compiler but provides
  fewer ergonomic wins. The whole point of this V1 work is the format;
  JSX is the right answer.
- **`use:` directives for client-side concerns?** When client signals
  land in V1, `use:focus={cond}`, `use:transition={...}` etc. are
  natural. Same mechanism (`defineDirective`).
- **Editor support — LSP, syntax highlighting.** Tooling work, mostly
  derivative of what Astro / Svelte already do. Out of scope for this note.
