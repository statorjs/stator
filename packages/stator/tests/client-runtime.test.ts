// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { machine } from '../src/client/machine.ts'
import { use, type ClientInstance } from '../src/client/use.ts'
import { StatorElement, defineElement } from '../src/client/element.ts'
import { bind } from '../src/client/bind.ts'

describe('client runtime (3b stage 0)', () => {
  it('machine() desugars to a usable single-state machine', () => {
    const Qty = machine({
      count: 1,
      on: { INC: (s: any) => { s.count++ }, DEC: (s: any) => { s.count = Math.max(1, s.count - 1) } },
      select: { atMax: (s: any) => s.count >= 3 },
    })
    expect(Qty.name).toBe('ClientMachine')
    expect(Qty.context).toEqual({ count: 1 })
    expect(Object.keys(Qty.selectors)).toContain('atMax')
  })

  it('use() exposes live context + selectors and send() drives them', () => {
    const Qty = machine({
      count: 1,
      on: { INC: (s: any) => { s.count++ } },
      select: { doubled: (s: any) => s.count * 2 },
    })
    const inst = use(Qty) as ClientInstance & { count: number; doubled: number }
    inst.__actor.start()
    expect(inst.count).toBe(1)
    expect(inst.doubled).toBe(2)
    inst.send('INC')
    expect(inst.count).toBe(2)
    expect(inst.doubled).toBe(4)
  })

  it('seeds initial context from a value (narrow hydration seed)', () => {
    const Cart = machine({
      unitPrice: 0,
      count: 1,
      on: { INC: (s: any) => { s.count++ } },
      select: { lineTotal: (s: any) => s.unitPrice * s.count },
    })
    const inst = use(Cart, { unitPrice: 12 }) as ClientInstance & { lineTotal: number }
    inst.__actor.start()
    expect(inst.lineTotal).toBe(12)
    inst.send('INC')
    expect(inst.lineTotal).toBe(24)
  })

  it('StatorElement owns actor lifecycle and bind() updates the DOM', () => {
    const Qty = machine({
      count: 1,
      on: { INC: (s: any) => { s.count++ } },
    })

    class QuantityStepper extends StatorElement {
      qty = use(Qty) as ClientInstance & { count: number }
      inc() { this.qty.send('INC') }
      protected setup() {
        const out = this.querySelector('[data-ref="count"]')!
        this.track(bind([this.qty], () => this.qty.count, (v) => { out.textContent = String(v) }))
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
    expect(out.textContent).toBe('1')

    // Click drives the machine → bind writes the DOM.
    ;(el.querySelector('[data-ref="inc"]') as HTMLElement).click()
    expect(out.textContent).toBe('2')
  })

  it('refs resolves data-ref handles within the island', () => {
    class RefWidget extends StatorElement {}
    defineElement(RefWidget, 'ref-widget')
    const holder = document.createElement('div')
    holder.innerHTML = '<ref-widget><button data-ref="go">x</button></ref-widget>'
    document.body.appendChild(holder)
    const el = holder.querySelector('ref-widget') as RefWidget
    expect(el.refs.go).toBe(el.querySelector('[data-ref="go"]'))
    expect(el.refs.missing).toBeNull()
  })

  it('attr() reads + coerces a seed attribute', () => {
    class PriceTag extends StatorElement {}
    defineElement(PriceTag, 'price-tag')
    document.body.innerHTML = '<price-tag unit-price="12.50"></price-tag>'
    const el = document.querySelector('price-tag') as PriceTag
    expect(el.attr('unit-price', Number)).toBe(12.5)
    expect(el.attr('missing', Number)).toBeUndefined()
  })
})
