import { html, read, type InstanceOf, type HtmlFragment } from 'stator/template'
import type CartMachine from '../machines/cart.ts'

export default function layout(
  cart: InstanceOf<typeof CartMachine>,
  body: HtmlFragment,
): HtmlFragment {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>stator demo</title>
    <link rel="stylesheet" href="/static/app.css">
  </head>
  <body>
    <header class="site-header">
      <a href="/" class="brand">stator demo</a>
      <nav>
        <a href="/">Products</a>
        <a href="/cart">Cart (${read(cart, (c) => c.itemCount)})</a>
        <a href="/checkout">Checkout</a>
        <a href="/admin">Admin</a>
      </nav>
    </header>
    <main>${body}</main>
    <script src="/static/client.js"></script>
  </body>
</html>`
}
