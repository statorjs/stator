import {
  html,
  read,
  each,
  on,
  when,
  type InstanceOf,
  type HtmlFragment,
} from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

type CartItem = { productId: string; quantity: number; unitPrice: number }
type Product = {
  id: string
  name: string
  description: string
  price: number
  category: 'stationery' | 'office' | 'lifestyle'
  initials: string
}

export default function cartPage(
  cart: InstanceOf<typeof CartMachine>,
  products: InstanceOf<typeof ProductsMachine>,
): HtmlFragment {
  const byId = products.byId as unknown as (id: string) => Product | undefined

  return html`<section class="cart">
  <header class="cart-header">
    <h1>Your cart</h1>
    <p class="cart-summary-line">
      ${read(cart, (c) => c.itemCount)} item${read(cart, (c) =>
        c.itemCount === 1 ? '' : 's',
      )} · subtotal
      <strong>$${read(cart, (c) => c.total.toFixed(2))}</strong>
    </p>
  </header>

  ${when(
    read(cart, (c) => c.isEmpty),
    () => html`<div class="cart-empty">
      <p>Your cart is empty.</p>
      <a href="/" class="link-back">← Browse products</a>
    </div>`,
  )}

  <ul class="cart-lines">
    ${each(
      read(cart, (c) => c.items as CartItem[]),
      (item, idx) => {
        const product = byId(item.productId)
        const name = product?.name ?? item.productId
        const cat = product?.category ?? 'stationery'
        const initials = product?.initials ?? '··'
        return html`<li class="cart-line">
          <div class="cart-line-thumb product-thumb--${cat}">
            <span class="product-thumb-initials">${initials}</span>
          </div>
          <div class="cart-line-info">
            <span class="cart-line-name">${name}</span>
            <span class="cart-line-unit">$${item.unitPrice.toFixed(2)} each</span>
          </div>
          <div class="cart-line-qty">
            <button class="qty-btn" ${on('click', () => cart.send({ type: 'DECREMENT', productId: item.productId }))}>−</button>
            <span class="qty-value">${read(cart, (c) => (c.items as CartItem[])[idx]?.quantity ?? 0)}</span>
            <button class="qty-btn" ${on('click', () => cart.send({ type: 'INCREMENT', productId: item.productId }))}>+</button>
          </div>
          <div class="cart-line-total">
            $${(item.unitPrice * item.quantity).toFixed(2)}
          </div>
          <button class="cart-line-remove" ${on('click', () => cart.send({ type: 'REMOVE_ITEM', productId: item.productId }))} title="Remove">×</button>
        </li>`
      },
    )}
  </ul>

  ${when(
    read(cart, (c) => !c.isEmpty),
    () => html`<footer class="cart-footer">
      <div class="cart-totals">
        <div class="cart-totals-row">
          <span>Subtotal</span>
          <span>$${read(cart, (c) => c.total.toFixed(2))}</span>
        </div>
        <div class="cart-totals-row cart-totals-row--muted">
          <span>Shipping calculated at checkout</span>
        </div>
        <div class="cart-totals-row cart-totals-row--grand">
          <span>Estimated total</span>
          <span>$${read(cart, (c) => c.total.toFixed(2))}</span>
        </div>
      </div>
      <div class="cart-actions">
        <button class="btn-secondary" ${on('click', () => cart.send({ type: 'CLEAR' }))}>Clear cart</button>
        <a href="/checkout" class="btn-primary">Checkout →</a>
      </div>
    </footer>`,
  )}
</section>`
}
