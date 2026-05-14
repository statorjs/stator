import { defineRoute } from 'stator/server'
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'
import layout from '../templates/layout.ts'
import productList from '../templates/product-list.ts'

export const GET = defineRoute({
  reads: [CartMachine, ProductsMachine],
  render: ({ CartMachine: cart, ProductsMachine: products }: any) =>
    layout(cart, productList(products, cart)),
})
