import { defineRoute } from '@statorjs/stator/server'
import AdminMachine from '../machines/admin.ts'
import ProductsMachine from '../machines/products.ts'
import adminLayout from '../templates/admin-layout.stator'
import adminPage from '../templates/admin-page.stator'

export const GET = defineRoute({
  reads: [AdminMachine, ProductsMachine],
  live: true,
  render: ({ AdminMachine: admin, ProductsMachine: products }: any) =>
    adminLayout({ body: adminPage({ admin, products }) }),
})
