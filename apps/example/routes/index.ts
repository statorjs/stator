import { defineRoute } from '@statorjs/stator/server'
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'
import customerLayout from '../templates/customer-layout.stator'
import productList from '../templates/product-list.stator'

export const GET = defineRoute({
  reads: [CartMachine, ProductsMachine],
  render: ({ CartMachine: cart, ProductsMachine: products }: any) =>
    customerLayout({ cart, body: productList({ products, cart }) }),
})
