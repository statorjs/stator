import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  analyzeClient,
  isCustomElementTag,
  kebabToPascal,
  pascalToKebab,
} from '../src/compiler/client-script.ts'

describe('compiler: client-script name-match (3b stage 1)', () => {
  it('converts kebab ↔ pascal', () => {
    assert.equal(kebabToPascal('quantity-stepper'), 'QuantityStepper')
    assert.equal(pascalToKebab('QuantityStepper'), 'quantity-stepper')
    assert.equal(pascalToKebab('WishlistHeart'), 'wishlist-heart')
  })

  it('recognizes custom-element tags (lowercase + hyphen)', () => {
    assert.equal(isCustomElementTag('quantity-stepper'), true)
    assert.equal(isCustomElementTag('div'), false)
    assert.equal(isCustomElementTag('Component'), false)
  })

  it('matches a tag to its same-named class', () => {
    const r = analyzeClient(
      'export class QuantityStepper extends StatorElement {}',
      new Set(['quantity-stepper']),
    )
    assert.deepStrictEqual(r.elements, [{ tag: 'quantity-stepper', className: 'QuantityStepper' }])
  })

  it('matches multiple elements in one file (co-located islands)', () => {
    const script = `
      export class WishlistHeart extends StatorElement {}
      export class QuantityStepper extends StatorElement {}
    `
    const r = analyzeClient(script, new Set(['wishlist-heart', 'quantity-stepper']))
    assert.deepStrictEqual(r.elements.map((e) => e.className).sort(), [
      'QuantityStepper',
      'WishlistHeart',
    ])
  })

  it('errors when a tag has no matching class', () => {
    assert.throws(
      () =>
        analyzeClient('export class Other extends StatorElement {}', new Set(['quantity-stepper'])),
      /no matching client class/,
    )
  })

  it('errors when a class has no matching tag (dead code)', () => {
    assert.throws(
      () => analyzeClient('export class QuantityStepper extends StatorElement {}', new Set()),
      /no matching <quantity-stepper> tag/,
    )
  })

  it('ignores non-exported and non-class statements', () => {
    const script = `
      const x = 1
      class Internal {}
      export class MyToggle extends StatorElement {}
    `
    const r = analyzeClient(script, new Set(['my-toggle']))
    assert.deepStrictEqual(r.elements, [{ tag: 'my-toggle', className: 'MyToggle' }])
  })
})
