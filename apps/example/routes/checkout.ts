import { defineRoute } from '@statorjs/stator/server'
import CartMachine from '../machines/cart.ts'
import CheckoutMachine from '../machines/checkout.ts'
import customerLayout from '../templates/customer-layout.stator'
import checkoutPage from '../templates/checkout-page.stator'

export const GET = defineRoute({
  reads: [CartMachine, CheckoutMachine],
  render: ({ CartMachine: cart, CheckoutMachine: checkout }: any) =>
    customerLayout({ cart, body: checkoutPage({ checkout, cart }) }),
})
