---
title: 4. Layouts and styling
description: "Wrap pages in a layout — a full HTML document and shared header via <children> — and style components with scoped and global CSS."
sidebar:
  order: 4
---

So far each route renders a bare `<main>` fragment. To be a real page it needs a full HTML document — `<!doctype html>`, `<head>`, `<body>` — and you don't want to repeat that (or a shared header) in every route. That's what a **layout** is: a component that provides the document shell and slots your page into it. We'll build the layout, then style the whole app.

## Why a document shell

Two reasons every page needs a real document:

- The browser needs `<head>` (title, styles) and `<body>` to render properly.
- Stator **auto-injects its client runtime** into the document's `<body>` — the script that turns `on:click` into a server round-trip. A bare fragment has no `<body>`, so events wouldn't work. (You don't add the runtime yourself; the framework does — but it needs a document to put it in.)

## The base layout

A layout is just a `.stator` component. Create `templates/base-layout.stator` — the document shell, with a stylesheet link and two **slots** for content:

```astro
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Desksmith</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <header class="site-header">
      <children name="header" />
    </header>
    <main>
      <children />
    </main>
  </body>
</html>
```

`<children />` marks where content goes. There are two kinds:

- `<children />` — the **default** slot, for the page body.
- `<children name="header" />` — a **named** slot, for content the caller marks with `child="header"`.

This is a compile-time composition feature — not the browser's `<slot>` element, and no shadow DOM.

## Global styles

Some CSS is app-wide: the color palette, a font, a CSS reset, and the **dark theme** (which the theme toggle in step 6 will switch on). That belongs in a plain stylesheet, not scoped to any one component. Create `static/app.css`:

```css
:root {
  --bg: #faf9f7;
  --surface: #ffffff;
  --text: #1f1d1a;
  --muted: #6b6155;
  --border: #e6e2da;
  --accent: #2c5e3f;
}

[data-theme='dark'] {
  --bg: #16140f;
  --surface: #211e18;
  --text: #ece8df;
  --muted: #a39c8c;
  --border: #322e26;
  --accent: #6db98c;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem; }
a { color: var(--accent); }
h1 { font-size: 1.6rem; }
```

The `[data-theme='dark']` block redefines the same variables; flipping `data-theme` on `<html>` (step 6) swaps the whole palette. Files under `static/` are served as-is — `base-layout` links this one with `<link rel="stylesheet" href="/static/app.css" />`.

## The customer layout

Now a layout that fills the header once — with the shop brand and a live cart count — passes the page through, and carries its **own** scoped styles. Create `templates/customer-layout.stator`:

```astro
---
import type { InstanceOf } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
import BaseLayout from './base-layout.stator'

const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<BaseLayout>
  <div child="header" class="brand-bar">
    <a href="/" class="brand">Desksmith</a>
    <a href="/cart">Cart ({read(cart, c => c.itemCount)})</a>
  </div>
  <children />
</BaseLayout>

<style>
  .brand-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    max-width: 60rem;
    margin: 0 auto;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 600; margin-right: auto; }
</style>
```

Two composition details:

- The `<div child="header">` fills `BaseLayout`'s `<children name="header" />` slot. `child="x"` targets the slot named `x`.
- `<children />` inside `<BaseLayout>` forwards *this* layout's page content into BaseLayout's default slot.

And the `<style>` block is the key styling idea: **it's scoped to this component.** Stator hashes the block and rewrites its selectors so `.brand-bar` only matches elements *this* file renders — it can't leak into other components, and other components' `.brand-bar` (if any) wouldn't be affected. App-wide rules (the reset, theme tokens) stay in the linked `app.css`; component-specific rules live in a scoped `<style>`. Note the scoped CSS still reads the global tokens (`var(--border)`). See [Scoped styles](/guides/scoped-styles/) for the details.

## Style the catalog

Give the product grid from step 3 a scoped `<style>` too. Add this to the bottom of `templates/product-list.stator`:

```astro
<style>
  .product-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 1rem;
  }
  .product-card {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
  }
  .product-card h3 { margin: 0 0 0.25rem; font-size: 1rem; }
  .price { color: var(--muted); }
</style>
```

Because the cards use `var(--surface)` / `var(--text)` (inherited), they'll follow the theme into dark mode automatically.

## Wrap the pages

Update the routes to render through the layout. `routes/index.stator`:

```astro
---
import ProductsMachine from '../machines/products.ts'
import CartMachine from '../machines/cart.ts'
import CustomerLayout from '../templates/customer-layout.stator'
import ProductList from '../templates/product-list.stator'

const [products, cart] = Stator.reads([ProductsMachine, CartMachine])
---
<CustomerLayout cart={cart}>
  <h1>Goods for the desk and home</h1>
  <ProductList products={products} cart={cart} />
</CustomerLayout>
```

Do the same for `routes/cart.stator` — wrap its contents in `<CustomerLayout cart={cart}>`. Both pages now render a full, styled document with the shared header.

## What you built · next

A reusable layout (document shell + customer chrome with a live cart count, composed with default and named `<children>`), a global `app.css` for theme tokens and the dark palette, and component-scoped `<style>` blocks. Desksmith looks like a real shop now. In [step 5](/tutorial/05-handling-events/) we make "Add to cart" interactive.
