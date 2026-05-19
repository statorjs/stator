import { html, read, type InstanceOf, type HtmlFragment } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
import baseLayout from './base-layout.ts'

/**
 * Customer-facing layout: imports CartMachine because the header shows
 * the current cart count. Routes for /, /cart, /checkout use this layout
 * and must include CartMachine in their `reads:` array so the runtime
 * hydrates it.
 *
 * The admin UI uses a different layout (admin-layout) precisely so admin
 * pages don't pull in CartMachine just because the shared chrome wanted it.
 */
export default function customerLayout(
  cart: InstanceOf<typeof CartMachine>,
  body: HtmlFragment,
): HtmlFragment {
  const header = html`<header class="site-header">
      <a href="/" class="brand">stator demo</a>
      <button
        class="nav-toggle"
        type="button"
        popovertarget="site-nav"
        aria-label="Toggle navigation"
      >
        <span class="nav-toggle__bar"></span>
        <span class="nav-toggle__bar"></span>
        <span class="nav-toggle__bar"></span>
      </button>
      <nav id="site-nav" popover>
        <a href="/">Products</a>
        <a href="/cart">Cart (${read(cart, (c) => c.itemCount)})</a>
        <a href="/checkout">Checkout</a>
        <a href="/admin">Admin</a>
      </nav>
    </header>`
  return baseLayout(header, body)
}
