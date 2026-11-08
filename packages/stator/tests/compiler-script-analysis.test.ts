import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeScriptClasses } from '../src/compiler/client-script.ts'

describe('compiler: script class analysis (3b stage 3)', () => {
  it('extracts use() fields (field → machine) and methods', () => {
    const script = `
      import { machine, use } from '@statorjs/stator/client'
      const Qty = machine({ count: 1 }, { on: { INC: (s) => { s.count++ } } })
      export class QuantityStepper extends StatorElement {
        qty = use(Qty)
        cached = 0
        inc() { this.qty.send('INC') }
        dec() { this.qty.send('DEC') }
      }
    `
    const classes = analyzeScriptClasses(script)
    assert.equal(classes.length, 1)
    const c = classes[0]!
    assert.equal(c.name, 'QuantityStepper')
    assert.deepStrictEqual([...c.useFields], [['qty', 'Qty']])
    assert.deepStrictEqual([...c.methods].sort(), ['dec', 'inc'])
  })

  it('captures multiple use() fields and seeded use()', () => {
    const script = `
      export class Card extends StatorElement {
        a = use(MachineA)
        b = use(MachineB, { unitPrice: this.attr('unit-price', Number) })
        plain = 3
      }
    `
    const c = analyzeScriptClasses(script)[0]!
    assert.deepStrictEqual([...c.useFields].sort(), [
      ['a', 'MachineA'],
      ['b', 'MachineB'],
    ])
  })

  it('handles multiple islands in one script', () => {
    const script = `
      export class WishlistHeart extends StatorElement { h = use(Wish) }
      export class QuantityStepper extends StatorElement { q = use(Qty) }
    `
    const classes = analyzeScriptClasses(script)
    assert.deepStrictEqual(classes.map((c) => c.name).sort(), ['QuantityStepper', 'WishlistHeart'])
    assert.deepStrictEqual(
      [...classes.find((c) => c.name === 'WishlistHeart')!.useFields],
      [['h', 'Wish']],
    )
  })

  it('ignores non-exported classes', () => {
    assert.deepStrictEqual(analyzeScriptClasses('class Internal { x = use(M) }'), [])
  })
})
