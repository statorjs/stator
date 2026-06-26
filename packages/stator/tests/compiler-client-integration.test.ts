import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'

const CLIENT = `<quantity-stepper>
  <button on:click={dec}>-</button>
  <span bind:text={qty.lineTotal}></span>
  <button on:click={inc}>+</button>
</quantity-stepper>

<script>
  const Qty = machine({ count: 1, unitPrice: 0, on: { INC: s => s.count++, DEC: s => s.count-- }, select: { lineTotal: s => s.unitPrice * s.count } })
  export class QuantityStepper extends StatorElement {
    static attrs = { unitPrice: Number }
    qty = use(Qty, () => ({ unitPrice: this.attrs.unitPrice }))
    inc() { this.qty.send('INC') }
    dec() { this.qty.send('DEC') }
  }
</script>`

describe('compiler: client-component integration (3b stage 6a)', () => {
  it('detects a client file and produces both server shell + client module', () => {
    const r = compile(CLIENT, { id: 'quantity-stepper.stator' })
    expect(r.isClient).toBe(true)
    expect(r.clientTag).toBe('quantity-stepper')
    expect(r.clientCode).toContain('class __QuantityStepperImpl extends QuantityStepper')
    expect(r.clientCode).toContain('defineElement(__QuantityStepperImpl, "quantity-stepper")')
  })

  it('server shell renders the custom-element root with declared attrs + inner markers', () => {
    const r = compile(CLIENT, { id: 'quantity-stepper.stator' })
    expect(r.serverCode).toContain('export default function (props = {})')
    expect(r.serverCode).toContain('clientShellAttrs(props, { unitPrice: "number" })')
    expect(r.serverCode).toContain('<quantity-stepper')
    expect(r.serverCode).toContain('</quantity-stepper>')
    // inner shell carries the data-b markers, directives stripped
    expect(r.serverCode).toContain('data-b="b0"')
    expect(r.serverCode).toContain('data-b="b1"')
    expect(r.serverCode).not.toContain('on:click')
    expect(r.serverCode).not.toContain('bind:text')
  })

  it('a component with no inline <script> stays on the server path', () => {
    const r = compile('<p>hi</p>')
    expect(r.isClient).toBe(false)
    expect(r.clientCode).toBe('')
    expect(r.serverCode).toContain('export default function')
  })

  it('errors on an inline <script> with no StatorElement (no longer silently dropped)', () => {
    expect(() => compile('<p>hi</p>\n<script>console.log("x")</script>')).toThrow(
      /no StatorElement subclass/,
    )
  })

  it('errors when the root is not a custom element', () => {
    const bad = `<div><my-toggle></my-toggle></div>\n<script>export class MyToggle extends StatorElement {}</script>`
    expect(() => compile(bad)).toThrow(/root must be a custom element/)
  })

  it('errors on a name mismatch (tag vs class)', () => {
    const bad = `<my-toggle></my-toggle>\n<script>export class OtherThing extends StatorElement {}</script>`
    expect(() => compile(bad)).toThrow(CompileError)
  })
})
