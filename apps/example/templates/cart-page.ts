import { html, read, each, on, when, type InstanceOf, type HtmlFragment } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

type CartItem = { productId: string; quantity: number; unitPrice: number }

export default function cartPage(
  cart: InstanceOf<typeof CartMachine>,
  products: InstanceOf<typeof ProductsMachine>,
): HtmlFragment {
  return html`<section class="cart">
  <h1>Cart</h1>
  <p class="cart-summary">
    Items: ${read(cart, (c) => c.itemCount)} —
    Total: $${read(cart, (c) => c.total.toFixed(2))}
  </p>
  <ul class="cart-items">
    ${each(
      read(cart, (c) => c.items as CartItem[]),
      (item, idx) => html`<li class="cart-item">
        <span class="cart-item-name">${(products.byId as any)(item.productId)?.name ?? item.productId}</span>
        <span class="cart-item-price">$${item.unitPrice.toFixed(2)}</span>
        <span class="cart-item-qty">
          <button ${on('click', () => cart.send({ type: 'DECREMENT', productId: item.productId }))}>−</button>
          <span>${read(cart, (c) => (c.items as CartItem[])[idx]?.quantity ?? 0)}</span>
          <button ${on('click', () => cart.send({ type: 'INCREMENT', productId: item.productId }))}>+</button>
        </span>
        <button class="cart-item-remove" ${on('click', () => cart.send({ type: 'REMOVE_ITEM', productId: item.productId }))}>remove</button>
      </li>`,
    )}
  </ul>
  <div class="cart-actions">
    ${when(
      read(cart, (c) => !c.isEmpty),
      () => html`<button ${on('click', () => cart.send({ type: 'CLEAR' }))}>Clear cart</button>
      <a href="/checkout" class="checkout-link">Go to checkout →</a>`,
    )}
  </div>
</section>`
}
