import { defineRoute } from '@statorjs/stator/server'
import AdminMachine from '../machines/admin.ts'
import ProductsMachine from '../machines/products.ts'
import adminLayout from '../templates/admin-layout.ts'
import adminPage from '../templates/admin-page.ts'

export const GET = defineRoute({
  reads: [AdminMachine, ProductsMachine],
  live: true,
  render: ({ AdminMachine: admin, ProductsMachine: products }: any) =>
    adminLayout(adminPage(admin, products)),
})
