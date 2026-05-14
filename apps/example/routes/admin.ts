import { defineRoute } from 'stator/server'
import AdminMachine from '../machines/admin.ts'
import ProductsMachine from '../machines/products.ts'
import CartMachine from '../machines/cart.ts'
import layout from '../templates/layout.ts'
import adminPage from '../templates/admin-page.ts'

export const GET = defineRoute({
  reads: [AdminMachine, ProductsMachine, CartMachine],
  live: true,
  render: ({ AdminMachine: admin, ProductsMachine: products, CartMachine: cart }: any) =>
    layout(cart, adminPage(admin, products)),
})
