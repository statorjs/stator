import { defineRoute } from '@statorjs/stator/server'
import CartMachine from '../machines/cart.ts'
import CheckoutMachine from '../machines/checkout.ts'
import customerLayout from '../templates/customer-layout.ts'
import checkoutPage from '../templates/checkout-page.ts'

export const GET = defineRoute({
  reads: [CartMachine, CheckoutMachine],
  render: ({ CartMachine: cart, CheckoutMachine: checkout }: any) =>
    customerLayout(cart, checkoutPage(checkout, cart)),
})
