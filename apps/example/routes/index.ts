import { defineRoute } from 'stator/server'
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'
import customerLayout from '../templates/customer-layout.ts'
import productList from '../templates/product-list.ts'

export const GET = defineRoute({
  reads: [CartMachine, ProductsMachine],
  render: ({ CartMachine: cart, ProductsMachine: products }: any) =>
    customerLayout(cart, productList(products, cart)),
})
