import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'

const CLIENT = `<quantity-stepper>
  <button on:click={dec}>-</button>
  <span>{read(qty, (q) => q.lineTotal)}</span>
  <button on:click={inc}>+</button>
</quantity-stepper>

<script>
  const Qty = machine({ count: 1, unitPrice: 0 }, { on: { INC: (s) => { s.count++ }, DEC: (s) => { s.count-- } }, select: { lineTotal: (s) => s.unitPrice * s.count } })
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
    assert.equal(r.isClient, true)
    assert.equal(r.clientTag, 'quantity-stepper')
    assert.ok(r.clientCode.includes('class __QuantityStepperImpl extends QuantityStepper'))
    assert.ok(r.clientCode.includes('defineElement(__QuantityStepperImpl, "quantity-stepper")'))
  })

  it('server shell renders the custom-element root with declared attrs + inner markers', () => {
    const r = compile(CLIENT, { id: 'quantity-stepper.stator' })
    assert.ok(
      r.serverCode.includes(
        'export default function (props: { unitPrice?: number | __SReadResult<number> } & { [prop: string]: unknown } = {})',
      ),
    )
    // Third arg carries the root's own static attributes (none here → {}).
    assert.ok(r.serverCode.includes('clientShellAttrs(props, { unitPrice: "number" }, {})'))
    assert.ok(r.serverCode.includes('<quantity-stepper'))
    assert.ok(r.serverCode.includes('</quantity-stepper>'))
    // inner shell carries the data-b markers, directives stripped
    assert.ok(r.serverCode.includes('data-b="b0"'))
    assert.ok(r.serverCode.includes('data-b="b1"'))
    assert.ok(!r.serverCode.includes('on:click'))
    assert.ok(!r.serverCode.includes('read(qty'))
  })

  it('a component with no inline <script> stays on the server path', () => {
    const r = compile('<p>hi</p>')
    assert.equal(r.isClient, false)
    assert.equal(r.clientCode, '')
    assert.ok(r.serverCode.includes('export default function'))
  })

  it('errors on an inline <script> with no StatorElement (no longer silently dropped)', () => {
    assert.throws(
      () => compile('<p>hi</p>\n<script>console.log("x")</script>'),
      /no StatorElement subclass/,
    )
  })

  it('errors when the root is not a custom element', () => {
    const bad = `<div><my-toggle></my-toggle></div>\n<script>export class MyToggle extends StatorElement {}</script>`
    assert.throws(() => compile(bad), /root must be a custom element/)
  })

  it('errors on a name mismatch (tag vs class)', () => {
    const bad = `<my-toggle></my-toggle>\n<script>export class OtherThing extends StatorElement {}</script>`
    assert.throws(() => compile(bad), CompileError)
  })
})
