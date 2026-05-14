import { html, read, on, match, type InstanceOf, type HtmlFragment } from 'stator/template'
import type CartMachine from '../machines/cart.ts'
import type CheckoutMachine from '../machines/checkout.ts'

export default function checkoutPage(
  checkout: InstanceOf<typeof CheckoutMachine>,
  cart: InstanceOf<typeof CartMachine>,
): HtmlFragment {
  return html`<section class="checkout">
  <h1>Checkout</h1>
  <p class="state-label">Current state: ${read(checkout, (c) => c.state)}</p>

  ${match(read(checkout, (c) => c.state), {
    shipping: () => html`<div class="step">
      <h2>1. Shipping</h2>
      <p>Name: ${read(checkout, (c) => c.shippingName)}</p>
      <p>Address: ${read(checkout, (c) => c.shippingAddress)}</p>
      <div class="step-actions">
        <button ${on('click', () => checkout.send({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' }))}>Set name</button>
        <button ${on('click', () => checkout.send({ type: 'SET_FIELD', field: 'shippingAddress', value: '123 Demo St' }))}>Set address</button>
        <button ${on('click', () => checkout.send({ type: 'SUBMIT_SHIPPING' }))}>Continue to payment →</button>
      </div>
      <p class="hint">Both name and address must be set; the guard blocks the transition otherwise.</p>
    </div>`,

    payment: () => html`<div class="step">
      <h2>2. Payment</h2>
      <p>Card last 4: ${read(checkout, (c) => c.paymentLast4)}</p>
      <div class="step-actions">
        <button ${on('click', () => checkout.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '4242' }))}>Set card</button>
        <button ${on('click', () => checkout.send({ type: 'BACK' }))}>← Back</button>
        <button ${on('click', () => checkout.send({ type: 'SUBMIT_PAYMENT' }))}>Place order</button>
      </div>
      <p class="hint">Card last 4 must match /^\\d{4}$/; otherwise the guard blocks.</p>
    </div>`,

    complete: () => html`<div class="step">
      <h2>3. Complete</h2>
      <p>Thanks! Order number: <strong>${read(checkout, (c) => c.orderNumber)}</strong></p>
      <div class="step-actions">
        <button ${on('click', () => checkout.send({ type: 'RESET' }))}>Start a new order</button>
      </div>
    </div>`,
  })}
</section>`
}
