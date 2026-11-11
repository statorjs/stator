import Checkout from '../../../../../../examples/desksmith/machines/checkout.ts'
import { defineRoute } from '../../../../src/server/routing.ts'
import { on } from '../../../../src/template/directives/on.ts'
import { html } from '../../../../src/template/html.ts'

/** A stand-in for desksmith's checkout page: the events its form sends. */
export const GET = defineRoute({
  reads: [Checkout],
  render: ({ CheckoutMachine: checkout }: any) => html`
    <button ${on('click', () => checkout.send({ type: 'SET_FIELD', field: 'shippingName', value: 'A' }))}>name</button>
    <button ${on('click', () => checkout.send({ type: 'SUBMIT_SHIPPING' }))}>ship</button>
    <button ${on('click', () => checkout.send({ type: 'SUBMIT_PAYMENT' }))}>pay</button>
  `,
})
