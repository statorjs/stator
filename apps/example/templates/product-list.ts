import {
  html,
  read,
  each,
  on,
  classList,
  type InstanceOf,
  type HtmlFragment,
} from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
import type ProductsMachine from '../machines/products.ts'

type Product = {
  id: string
  name: string
  description: string
  price: number
  category: 'stationery' | 'office' | 'lifestyle'
  initials: string
}

function categorySection(
  title: string,
  blurb: string,
  cat: Product['category'],
  products: InstanceOf<typeof ProductsMachine>,
  cart: InstanceOf<typeof CartMachine>,
): HtmlFragment {
  return html`<section class="catalog-section catalog-section--${cat}">
    <header class="catalog-section-header">
      <h2>${title}</h2>
      <p class="catalog-section-blurb">${blurb}</p>
    </header>
    <ul class="product-grid">
      ${each(
        read(products, (p) => (p.byCategory as (c: string) => Product[])(cat)),
        (product: Product) => html`<li class="product-card">
          <div class="product-thumb product-thumb--${product.category}">
            <span class="product-thumb-initials">${product.initials}</span>
          </div>
          <div class="product-body">
            <h3 class="product-name">${product.name}</h3>
            <p class="product-description">${product.description}</p>
            <div class="product-footer">
              <span class="product-price">$${product.price.toFixed(2)}</span>
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
                ${read(cart, (c) =>
                  c.contains(product.id) ? 'In cart ✓' : 'Add to cart',
                )}
              </button>
            </div>
          </div>
        </li>`,
      )}
    </ul>
  </section>`
}

export default function productList(
  products: InstanceOf<typeof ProductsMachine>,
  cart: InstanceOf<typeof CartMachine>,
): HtmlFragment {
  return html`<div class="catalog">
    <section class="catalog-hero">
      <h1>Goods for the desk and home</h1>
      <p>A small, hand-picked selection. Everything ships from one workshop.</p>
    </section>

    ${categorySection(
      'Stationery',
      'Notebooks, pens, and the things that go around them.',
      'stationery',
      products,
      cart,
    )}
    ${categorySection(
      'Office',
      'Working-from-anywhere essentials.',
      'office',
      products,
      cart,
    )}
    ${categorySection(
      'Lifestyle',
      'Quietly nice things for the rest of the day.',
      'lifestyle',
      products,
      cart,
    )}
  </div>`
}
