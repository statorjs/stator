// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bind } from '../src/client/bind.ts'
import { defineElement, StatorElement } from '../src/client/element.ts'
import { machine } from '../src/client/machine.ts'
import { type ClientInstance, use } from '../src/client/use.ts'

describe('client runtime (3b stage 0)', () => {
  it('machine() desugars to a usable single-state machine', () => {
    const Qty = machine(
      { count: 1 },
      {
        on: {
          INC: (s) => {
            s.count++
          },
          DEC: (s) => {
            s.count = Math.max(1, s.count - 1)
          },
        },
        select: { atMax: (s) => s.count >= 3 },
      },
    )
    assert.equal(Qty.name, 'ClientMachine')
    assert.deepStrictEqual(Qty.context, { count: 1 })
    assert.ok(Object.keys(Qty.selectors).includes('atMax'))
  })

  it('use() exposes live context + selectors and send() drives them', () => {
    const Qty = machine(
      { count: 1 },
      {
        on: {
          INC: (s) => {
            s.count++
          },
        },
        select: { doubled: (s) => s.count * 2 },
      },
    )
    const inst = use(Qty)
    inst.__actor.start()
    assert.equal(inst.count, 1)
    assert.equal(inst.doubled, 2)
    inst.send('INC')
    assert.equal(inst.count, 2)
    assert.equal(inst.doubled, 4)
  })

  it('seeds initial context from a value (narrow hydration seed)', () => {
    const Cart = machine(
      { unitPrice: 0, count: 1 },
      {
        on: {
          INC: (s) => {
            s.count++
          },
        },
        select: { lineTotal: (s) => s.unitPrice * s.count },
      },
    )
    // No cast: `lineTotal` is on the typed instance now.
    const inst = use(Cart, { unitPrice: 12 })
    inst.__actor.start()
    assert.equal(inst.lineTotal, 12)
    inst.send('INC')
    assert.equal(inst.lineTotal, 24)
  })

  it('StatorElement owns actor lifecycle and bind() updates the DOM', () => {
    const Qty = machine(
      { count: 1 },
      {
        on: {
          INC: (s) => {
            s.count++
          },
        },
      },
    )

    class QuantityStepper extends StatorElement {
      qty = use(Qty) as ClientInstance & { count: number }
      inc() {
        this.qty.send('INC')
      }
      protected setup() {
        const out = this.querySelector('[data-ref="count"]')!
        this.track(
          bind(
            [this.qty],
            () => this.qty.count,
            (v) => {
              out.textContent = String(v)
            },
          ),
        )
        const btn = this.querySelector('[data-ref="inc"]')!
        btn.addEventListener('click', () => this.inc())
      }
    }
    defineElement(QuantityStepper, 'quantity-stepper')

    // Build detached (children parsed first), then attach so connectedCallback
    // fires with children present — mirrors the SSR flow where the browser
    // parses the server-rendered children before connecting the element.
    const holder = document.createElement('div')
    holder.innerHTML =
      '<quantity-stepper><span data-ref="count"></span><button data-ref="inc"></button></quantity-stepper>'
    document.body.appendChild(holder)
    const el = holder.querySelector('quantity-stepper')!
    const out = el.querySelector('[data-ref="count"]')!

    // After upgrade + connect: initial paint.
    assert.equal(out.textContent, '1')

    // Click drives the machine → bind writes the DOM.
    ;(el.querySelector('[data-ref="inc"]') as HTMLElement).click()
    assert.equal(out.textContent, '2')
  })

  it('refs resolves data-ref handles within the island', () => {
    class RefWidget extends StatorElement {}
    defineElement(RefWidget, 'ref-widget')
    const holder = document.createElement('div')
    holder.innerHTML = '<ref-widget><button data-ref="go">x</button></ref-widget>'
    document.body.appendChild(holder)
    const el = holder.querySelector('ref-widget') as RefWidget
    assert.equal(el.refs.go, el.querySelector('[data-ref="go"]'))
    assert.equal(el.refs.missing, null)
  })

  it('this.attrs reads declared attrs (camel→kebab, coerced, presence booleans)', () => {
    class PriceWidget extends StatorElement {
      static attrs = { unitPrice: Number, label: String, selected: Boolean }
    }
    defineElement(PriceWidget, 'price-widget')
    const holder = document.createElement('div')
    holder.innerHTML = '<price-widget unit-price="98.5" label="Runner" selected></price-widget>'
    document.body.appendChild(holder)
    const el = holder.querySelector('price-widget') as PriceWidget & {
      attrs: { unitPrice: number; label: string; selected: boolean }
    }
    assert.equal(el.attrs.unitPrice, 98.5) // Number coercion, kebab attr
    assert.equal(el.attrs.label, 'Runner')
    assert.equal(el.attrs.selected, true) // present → true

    const holder2 = document.createElement('div')
    holder2.innerHTML = '<price-widget unit-price="10"></price-widget>'
    document.body.appendChild(holder2)
    const el2 = holder2.querySelector('price-widget') as PriceWidget & {
      attrs: { selected: boolean }
    }
    assert.equal(el2.attrs.selected, false) // absent → false
  })

  it('attr() reads + coerces a seed attribute', () => {
    class PriceTag extends StatorElement {}
    defineElement(PriceTag, 'price-tag')
    document.body.innerHTML = '<price-tag unit-price="12.50"></price-tag>'
    const el = document.querySelector('price-tag') as PriceTag
    assert.equal(el.attr('unit-price', Number), 12.5)
    assert.equal(el.attr('missing', Number), undefined)
  })
})
