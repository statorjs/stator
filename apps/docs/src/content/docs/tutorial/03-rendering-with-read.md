---
title: 3. Rendering with read()
description: "Render the catalog and cart from server state with read(), when, each, and match."
sidebar:
  order: 3
---

Now we put the machines on screen. A `.stator` file is a server-rendered component; a route is just a `.stator` file in `routes/`.

## The .stator file

A `.stator` file has up to four regions. For a page you need two: the **frontmatter** (between `---` fences) for imports and machine access, and the **body** for markup. Create `routes/index.stator`:

```astro
---
import ProductsMachine from '../machines/products.ts'
import CartMachine from '../machines/cart.ts'

const [products, cart] = Stator.reads([ProductsMachine, CartMachine])
---
<main class="catalog">
  <h1>Goods for the desk and home</h1>
  <p>Cart: {read(cart, c => c.itemCount)} items</p>
</main>
```

### Stator.reads([...]) and props

`Stator.reads([ProductsMachine, CartMachine])` is how a **route** gets live machine instances — it returns them in the order you asked. (Reusable components in `templates/` receive machines as props via `Stator.props<...>()` instead; we'll see that below.)

## read(machine, selector)

`read(machine, selector)` is the heart of rendering. It runs the selector and registers a **binding** on the surrounding node:

```astro
<p>Cart: {read(cart, c => c.itemCount)} items</p>
```

That `<p>`'s count is now bound to the cart's `itemCount`. When the cart changes, the server recomputes this binding and patches just this slot. A bare `{expr}` without `read()` — like `{product.name}` for static data — renders once and never updates.

Let's render the actual catalog. Pull the product grid into a reusable component, `templates/product-list.stator`, which takes the machines as props:

```astro
---
import type { InstanceOf } from '@statorjs/stator/template'
import type ProductsMachine from '../machines/products.ts'
import type CartMachine from '../machines/cart.ts'
import type { Product } from '../machines/products.ts'

const { products, cart } = Stator.props<{
  products: InstanceOf<typeof ProductsMachine>
  cart: InstanceOf<typeof CartMachine>
}>()
---
<ul class="product-grid">
  {each(read(products, p => p.all), (product: Product) =>
    <li class="product-card">
      <h3>{product.name}</h3>
      <span class="price">${product.price.toFixed(2)}</span>
    </li>
  )}
</ul>
```

Note the imports are **type-only** (`import type`): a template references a machine's *shape* via `InstanceOf<typeof ProductsMachine>`, never its runtime value. The route passes the real instances down.

Wire it into the page:

```astro
---
import ProductsMachine from '../machines/products.ts'
import CartMachine from '../machines/cart.ts'
import ProductList from '../templates/product-list.stator'

const [products, cart] = Stator.reads([ProductsMachine, CartMachine])
---
<main class="catalog">
  <h1>Goods for the desk and home</h1>
  <ProductList products={products} cart={cart} />
</main>
```

A capitalized tag (`<ProductList>`) invokes a component; lowercase tags are plain HTML.

## The cart page

Now the cart. Create `routes/cart.stator` — here's the **whole file**; we'll unpack the new pieces right after:

```astro
---
import CartMachine from '../machines/cart.ts'

const [cart] = Stator.reads([CartMachine])
---
<main class="cart">
  <h1>Your cart</h1>

  {when(read(cart, c => c.isEmpty), () =>
    <div class="cart-empty">
      <p>Your cart is empty.</p>
      <a href="/">← Browse products</a>
    </div>
  )}

  {when(read(cart, c => !c.isEmpty), () =>
    <div>
      <ul class="cart-lines">
        {each(read(cart, c => c.items), (item, idx) =>
          <li class="cart-line">
            <span>{read(cart, c => c.items[idx]?.quantity ?? 0)} ×</span>
            <span>${item.unitPrice.toFixed(2)}</span>
          </li>
        )}
      </ul>
      <p class="cart-total">Total: ${read(cart, c => c.total.toFixed(2))}</p>
    </div>
  )}
</main>
```

That's the complete route. It uses two of Stator's three control-flow helpers — `when` and `each`. Let's look at each.

### when()

`when(condition, body)` renders a region only when the condition holds. It's a callback, not a `<When>` component — the body isn't evaluated unless the condition is true (so a hidden branch costs nothing). The cart page uses it twice, for the two mutually-exclusive states: one `when(isEmpty)` for the empty message, one `when(!isEmpty)` for the populated view.

### each()

`each(items, (item, index) => …)` renders a list — you saw it for the product grid, and here for the cart lines. Inside the loop, `read(cart, c => c.items[idx]?.quantity ?? 0)` keeps each quantity live, so it'll update when you add events in the next step. (`item.unitPrice` is read directly because the price of a line never changes once it's in the cart.)

### match()

The third helper, `match`, picks one of several branches by value rather than a true/false condition. Desksmith doesn't need it, but for example — if a machine tracked an order's status — it would read:

```astro
{match(read(order, o => o.status), {
  pending: () => <span class="pill">Pending</span>,
  shipped: () => <span class="pill">Shipped</span>,
  cancelled: () => <span class="pill">Cancelled</span>,
})}
```

So: `when` for one condition, `match` for many, `each` for lists.

## What you built · next

The catalog and cart both render from server state, and you've seen the three control-flow callbacks. They're still bare fragments, though — no document shell, no shared chrome. In [step 4](/tutorial/04-layouts/) we wrap them in a layout, then [step 5](/tutorial/05-handling-events/) makes them interactive.
