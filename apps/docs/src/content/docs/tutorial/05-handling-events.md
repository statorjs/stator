---
title: 5. Handling events
description: "Wire up add-to-cart: dispatch events and watch only the affected DOM update."
sidebar:
  order: 5
---

The catalog renders inside a real document now, with a cart count in the header. Time to wire up "Add to cart" and watch the surgical updates that follow.

## on:click and send

The `on:` directive attaches an event handler. The handler sends a typed event to a machine. Add a button to each product card in `templates/product-list.stator`:

```astro
<button on:click={() => cart.send({ type: 'ADD_ITEM', productId: product.id })}>
  Add to cart
</button>
```

`cart.send(...)` dispatches to the cart machine. Because the cart declared its event union (`events: {} as CartEvents`), this call is type-checked — a wrong `type` or a missing `productId` is a compile error, not a runtime surprise.

### payload events

Events carry data. `{ type: 'ADD_ITEM', productId: product.id }` is a **payload event**: the `type` selects the transition, and the rest is available as `ev` inside `do(ctx, ev)`. Events with no data — like `{ type: 'CLEAR' }` — are just the `type`.

## The round trip

When you click, here's what happens — and what doesn't:

1. The click POSTs the event to the server.
2. The server hydrates the cart, runs the `ADD_ITEM` transition, and persists the result.
3. It recomputes the bindings that read the cart and sends back a patch list.

There's no fetch to write, no JSON endpoint to define, no client store to update. The handler *is* the integration.

## The wire patch

Open your browser's network panel and click "Add to cart." The response isn't a new page — it's a small list of patches targeting only the slots that changed: the header's cart count, the button's label. Everything else on the page is untouched. This is "the DOM renders where its state lives" in action: one event, a handful of byte-sized updates.

## transitions → selectors → slots

Why does adding an item update the header count *and* the button label at once, in two different spots? Because both are bound to selectors over the same context:

- `read(cart, c => c.itemCount)` in the layout header.
- `read(cart, c => c.contains(product.id))` on the button (you'll add this next).

The `ADD_ITEM` transition mutates `ctx.items`. On recompute, every selector that derives from `items` re-runs; the ones whose value actually changed get a patch. You never wire up "when items change, update the count" — the binding *is* that wiring. (The cart page's `total` updates the same way the next time you visit it.)

## class:list

Bindings aren't only for text. `class:list` composes a class attribute reactively. Update the button to also reflect whether the product is already in the cart:

```astro
<button
  on:click={() => cart.send({ type: 'ADD_ITEM', productId: product.id })}
  class:list={{ 'add-btn': true, 'in-cart': read(cart, c => c.contains(product.id)) }}
>
  {read(cart, c => c.contains(product.id) ? 'In cart ✓' : 'Add to cart')}
</button>
```

`'add-btn'` is always on; `'in-cart'` toggles with the `contains` read. Click the button and the class flips in the same patch that updates the label and the header count.

Give the two states some style — add these rules to `product-list.stator`'s `<style>` block (the one from step 4):

```css
.add-btn {
  align-self: flex-start;
  margin-top: 0.75rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
}
.add-btn.in-cart {
  background: var(--accent);
  color: var(--surface);
}
```

Now the button visibly fills in when the product is in the cart — the reactive class drives a real visual state change.

## The cart page actions

The cart page from step 3 only *displays* line items. Now wire up the rest of the cart's events — `INCREMENT`, `DECREMENT`, `REMOVE_ITEM`, and `CLEAR` — each just another `on:click` sending the matching event. Here's the complete `routes/cart.stator`:

```astro
---
import CartMachine from '../machines/cart.ts'
import CustomerLayout from '../templates/customer-layout.stator'

const [cart] = Stator.reads([CartMachine])
---
<CustomerLayout cart={cart}>
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
            <span class="qty">
              <button on:click={() => cart.send({ type: 'DECREMENT', productId: item.productId })}>−</button>
              {read(cart, c => c.items[idx]?.quantity ?? 0)}
              <button on:click={() => cart.send({ type: 'INCREMENT', productId: item.productId })}>+</button>
            </span>
            <span class="line-price">${item.unitPrice.toFixed(2)}</span>
            <button class="link" on:click={() => cart.send({ type: 'REMOVE_ITEM', productId: item.productId })}>Remove</button>
          </li>
        )}
      </ul>
      <p class="cart-total">Total: ${read(cart, c => c.total.toFixed(2))}</p>
      <button on:click={() => cart.send({ type: 'CLEAR' })}>Clear cart</button>
    </div>
  )}
</CustomerLayout>

<style>
  .cart-lines { list-style: none; margin: 0; padding: 0; }
  .cart-line {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--border);
  }
  .qty { display: flex; align-items: center; gap: 0.5rem; }
  .qty button {
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .line-price { margin-left: auto; color: var(--muted); }
  .link {
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .cart-total { font-weight: 600; }
</style>
```

Each button is the same pattern as "Add to cart" — a typed event to `CartMachine`. There's nothing new to learn; the cart's whole behavior is just five events. Notice the payoff: increment a line and only that line's quantity, the total, and the header count patch — the empty-state `when` even swaps in automatically when you remove the last item, because `isEmpty` flips.

## What you built · next

A complete, interactive store — add to cart from the catalog, then change quantities, remove lines, and clear the cart, all with minimal patches and the header count always in sync. In [step 6](/tutorial/06-a-client-component/) we add interactivity that *shouldn't* touch the server: a theme toggle.
