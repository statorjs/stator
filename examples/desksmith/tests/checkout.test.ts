import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import CheckoutMachine from '../machines/checkout.ts'

// SUBMIT_PAYMENT fires the charge as a transition effect. A bare actor would
// run it on a microtask; we intercept with a no-op onEffect so the machine
// parks in `placing` and we deliver the processor's answer by hand — the whole
// point of the pending-state / completion-event split. (No onStateEnter means
// the `placing` after-timer is never armed, so the 8s rescue can't fire here.)
const newCheckout = () => createActor(CheckoutMachine, { onEffect: () => {} }).start()
const stateOf = (a: ReturnType<typeof newCheckout>) => a.getSnapshot().value.at(-1)
const ctxOf = (a: ReturnType<typeof newCheckout>) => a.getSnapshot().context

const fillShipping = (a: ReturnType<typeof newCheckout>) => {
  a.send({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' })
  a.send({ type: 'SET_FIELD', field: 'shippingAddress', value: '123 Demo St' })
}

describe('checkout — the shipping guard', () => {
  it('starts in shipping', () => {
    assert.equal(stateOf(newCheckout()), 'shipping')
  })

  it('holds the transition until both fields are set', () => {
    const co = newCheckout()
    co.send({ type: 'SUBMIT_SHIPPING' })
    assert.equal(stateOf(co), 'shipping') // nothing set

    co.send({ type: 'SET_FIELD', field: 'shippingName', value: 'Demo Customer' })
    co.send({ type: 'SUBMIT_SHIPPING' })
    assert.equal(stateOf(co), 'shipping') // address still missing

    co.send({ type: 'SET_FIELD', field: 'shippingAddress', value: '123 Demo St' })
    co.send({ type: 'SUBMIT_SHIPPING' })
    assert.equal(stateOf(co), 'payment')
  })
})

describe('checkout — the payment guard and charge', () => {
  it('a non-four-digit card cannot submit', () => {
    const co = newCheckout()
    fillShipping(co)
    co.send({ type: 'SUBMIT_SHIPPING' })
    co.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '12' })
    co.send({ type: 'SUBMIT_PAYMENT' })
    assert.equal(stateOf(co), 'payment') // guard held
  })

  it('a valid card enters placing; CHARGE_OK completes with the receipt', () => {
    const co = newCheckout()
    fillShipping(co)
    co.send({ type: 'SUBMIT_SHIPPING' })
    co.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '4242' })
    co.send({ type: 'SUBMIT_PAYMENT' })
    assert.equal(stateOf(co), 'placing') // pending: charge in flight

    co.send({ type: 'CHARGE_OK', receipt: 'DS-1001' })
    assert.equal(stateOf(co), 'complete')
    assert.equal(ctxOf(co).orderNumber, 'DS-1001')
  })

  it('CHARGE_FAILED bounces back to payment carrying the reason', () => {
    const co = newCheckout()
    fillShipping(co)
    co.send({ type: 'SUBMIT_SHIPPING' })
    co.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '0000' })
    co.send({ type: 'SUBMIT_PAYMENT' })
    co.send({ type: 'CHARGE_FAILED', reason: 'card declined' })
    assert.equal(stateOf(co), 'payment')
    assert.equal(ctxOf(co).error, 'card declined')
  })

  it('CHARGE_TIMEOUT rescues a stranded placing back to payment', () => {
    const co = newCheckout()
    fillShipping(co)
    co.send({ type: 'SUBMIT_SHIPPING' })
    co.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '9999' })
    co.send({ type: 'SUBMIT_PAYMENT' })
    assert.equal(stateOf(co), 'placing')

    co.send({ type: 'CHARGE_TIMEOUT' })
    assert.equal(stateOf(co), 'payment')
    assert.ok((ctxOf(co).error).includes('never answered'))
  })
})

describe('checkout — reset', () => {
  it('RESET from complete clears the context back to a fresh order', () => {
    const co = newCheckout()
    fillShipping(co)
    co.send({ type: 'SUBMIT_SHIPPING' })
    co.send({ type: 'SET_FIELD', field: 'paymentLast4', value: '4242' })
    co.send({ type: 'SUBMIT_PAYMENT' })
    co.send({ type: 'CHARGE_OK', receipt: 'DS-1001' })

    co.send({ type: 'RESET' })
    assert.equal(stateOf(co), 'shipping')
    const ctx = ctxOf(co)
    assert.equal(ctx.orderNumber, null)
    assert.equal(ctx.paymentLast4, '')
    assert.equal(ctx.error, '')
  })
})
