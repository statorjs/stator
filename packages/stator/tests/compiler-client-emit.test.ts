// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { emitClientModule, rewriteMembers } from '../src/compiler/client-emit.ts'
import type { ClientDirective } from '../src/compiler/client-script.ts'
import * as clientApi from '../src/client/index.ts'

describe('compiler: rewriteMembers', () => {
  const members = new Set(['qty', 'inc', 'count'])
  it('prefixes member references with this.', () => {
    expect(rewriteMembers('qty.count', members)).toBe('this.qty.count')
    expect(rewriteMembers('inc', members)).toBe('this.inc')
    expect(rewriteMembers('qty.count + 5', members)).toBe('this.qty.count + 5')
  })
  it('leaves non-members and property names alone', () => {
    expect(rewriteMembers('qty.count + other', members)).toBe('this.qty.count + other')
    expect(rewriteMembers('() => qty.send("INC")', members)).toBe('() => this.qty.send("INC")')
  })
})

describe('compiler: emitClientModule (3b stage 5)', () => {
  const script = `
const Qty = machine({ count: 1, on: { INC: s => s.count++, DEC: s => s.count = Math.max(1, s.count-1) } })
export class QuantityStepper extends StatorElement {
  qty = use(Qty)
  inc() { this.qty.send('INC') }
  dec() { this.qty.send('DEC') }
}`.trim()

  const directives: ClientDirective[] = [
    { marker: 'b0', kind: 'on', event: 'click', expr: 'dec', deps: [] },
    { marker: 'b1', kind: 'bind', target: 'text', expr: 'qty.count', deps: ['qty'] },
    { marker: 'b2', kind: 'on', event: 'click', expr: 'inc', deps: [] },
  ]
  const members = new Set(['qty', 'inc', 'dec'])

  it('emits the auto-injected import, the user class, a setup() subclass, and defineElement', () => {
    const out = emitClientModule({
      script,
      element: { tag: 'quantity-stepper', className: 'QuantityStepper' },
      directives,
      members,
    })
    expect(out).toContain("import { StatorElement, defineElement, use, machine, bind, effect, dispatch }")
    expect(out).toContain('export class QuantityStepper extends StatorElement')
    expect(out).toContain('class __QuantityStepperImpl extends QuantityStepper')
    expect(out).toContain('this.querySelector(\'[data-b="b0"]\')')
    expect(out).toContain('addEventListener("click", (e) => this.dec(e))')
    expect(out).toContain('bind([this.qty], () => (this.qty.count)')
    expect(out).toContain("defineElement(__QuantityStepperImpl, \"quantity-stepper\")")
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
      '<quantity-stepper><button data-b="b0">-</button><span data-b="b1"></span><button data-b="b2">+</button></quantity-stepper>'
    document.body.appendChild(holder)
    const el = holder.querySelector('quantity-stepper')!
    const out1 = el.querySelector('[data-b="b1"]')!

    expect(out1.textContent).toBe('1') // initial paint on connect
    ;(el.querySelector('[data-b="b2"]') as HTMLElement).click() // inc
    ;(el.querySelector('[data-b="b2"]') as HTMLElement).click()
    expect(out1.textContent).toBe('3')
    ;(el.querySelector('[data-b="b0"]') as HTMLElement).click() // dec
    expect(out1.textContent).toBe('2')
  })
})
