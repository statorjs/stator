import { html, read, each, on, classList, type InstanceOf, type HtmlFragment } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

type Product = {
  id: string
  name: string
  price: number
  description: string
}

export default function productList(
  products: InstanceOf<typeof ProductsMachine>,
  cart: InstanceOf<typeof CartMachine>,
): HtmlFragment {
  return html`<section class="products">
  <h1>Products</h1>
  <ul class="product-grid">
    ${each(
      read(products, (p) => p.all as Product[]),
      (product) => html`<li class="product-card">
        <h3>${product.name}</h3>
        <p class="description">${product.description}</p>
        <p class="price">$${product.price.toFixed(2)}</p>
        <button
          ${on('click', () =>
            cart.send({
              type: 'ADD_ITEM',
              productId: product.id,
            }),
          )}
          ${classList({
            'add-btn': true,
            'in-cart': read(cart, (c) => c.contains(product.id)),
          })}
        >
          ${read(cart, (c) => (c.contains(product.id) ? 'In cart' : 'Add to cart'))}
        </button>
      </li>`,
    )}
  </ul>
</section>`
}
