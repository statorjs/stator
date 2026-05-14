import { defineRoute } from 'stator/server'
import CartMachine from '../machines/cart.ts'
import CheckoutMachine from '../machines/checkout.ts'
import layout from '../templates/layout.ts'
import checkoutPage from '../templates/checkout-page.ts'

export const GET = defineRoute({
  reads: [CartMachine, CheckoutMachine],
  render: ({ CartMachine: cart, CheckoutMachine: checkout }: any) =>
    layout(cart, checkoutPage(checkout, cart)),
})
