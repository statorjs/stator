// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as clientApi from '../src/client/index.ts'
import { emitClientModule, rewriteMembers } from '../src/compiler/client-emit.ts'
import type { ClientDirective } from '../src/compiler/client-script.ts'

describe('compiler: rewriteMembers', () => {
  const members = new Set(['qty', 'inc', 'count'])
  it('prefixes member references with this.', () => {
    assert.equal(rewriteMembers('qty.count', members), 'this.qty.count')
    assert.equal(rewriteMembers('inc', members), 'this.inc')
    assert.equal(rewriteMembers('qty.count + 5', members), 'this.qty.count + 5')
  })
  it('leaves non-members and property names alone', () => {
    assert.equal(rewriteMembers('qty.count + other', members), 'this.qty.count + other')
    assert.equal(rewriteMembers('() => qty.send("INC")', members), '() => this.qty.send("INC")')
  })
})

describe('compiler: emitClientModule (3b stage 5)', () => {
  const script = `
const Qty = machine({ count: 1 }, { on: { INC: (s) => { s.count++ }, DEC: (s) => { s.count = Math.max(1, s.count-1) } } })
export class QuantityStepper extends StatorElement {
  qty = use(Qty)
  inc() { this.qty.send('INC') }
  dec() { this.qty.send('DEC') }
}`.trim()

  const directives: ClientDirective[] = [
    { marker: 'b0', kind: 'on', event: 'click', expr: 'dec', deps: [] },
    { marker: 's0', kind: 'slot', expr: 'qty.count', deps: ['qty'] },
    { marker: 'b1', kind: 'on', event: 'click', expr: 'inc', deps: [] },
  ]
  const members = new Set(['qty', 'inc', 'dec'])

  it('emits the auto-injected import, the user class, a setup() subclass, and defineElement', () => {
    const out = emitClientModule({
      script,
      element: { tag: 'quantity-stepper', className: 'QuantityStepper' },
      directives,
      members,
    })
    assert.ok(
      out.includes(
        'import { StatorElement, use, machine, defineElement, bind, effect, dispatch, bindSlot, attrValue, setAttr }',
      ),
    )
    assert.ok(out.includes('export class QuantityStepper extends StatorElement'))
    assert.ok(out.includes('class __QuantityStepperImpl extends QuantityStepper'))
    assert.ok(out.includes('this.querySelectorAll("[data-b=\\"b0\\"]")'))
    assert.ok(out.includes('addEventListener("click", (e) => this.dec(e))'))
    assert.ok(out.includes('bindSlot(this, "s0", [this.qty], () => (this.qty.count))'))
    assert.ok(out.includes('defineElement(__QuantityStepperImpl, "quantity-stepper")'))
  })

  it('the emitted module runs end-to-end in the DOM', () => {
    const out = emitClientModule({
      script,
      element: { tag: 'quantity-stepper', className: 'QuantityStepper' },
      directives,
      members,
    })
    // Run the module body with the client API in scope. Strip the import line
    // and the `export` keyword (module-only syntax invalid in a Function body —
    // a test-harness limitation; the real emitted module keeps both).
    const body = out.replace(/^import .*$/m, '').replace(/^export /m, '')
    const names = Object.keys(clientApi)
    // eslint-disable-next-line no-new-func
    new Function(...names, body)(...names.map((n) => (clientApi as any)[n]))

    const holder = document.createElement('div')
    holder.innerHTML =
      '<quantity-stepper><button data-b="b0">-</button><span><!--s0--></span><button data-b="b1">+</button></quantity-stepper>'
    document.body.appendChild(holder)
    const el = holder.querySelector('quantity-stepper')!
    const out1 = el.querySelector('span')!

    assert.equal(out1.textContent, '1') // initial paint on connect
    ;(el.querySelector('[data-b="b1"]') as HTMLElement).click() // inc
    ;(el.querySelector('[data-b="b1"]') as HTMLElement).click()
    assert.equal(out1.textContent, '3')
    ;(el.querySelector('[data-b="b0"]') as HTMLElement).click() // dec
    assert.equal(out1.textContent, '2')
  })
})
