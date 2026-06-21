import { describe, it, expect } from 'vitest'
import {
  analyzeClient,
  kebabToPascal,
  pascalToKebab,
  isCustomElementTag,
} from '../src/compiler/client-script.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'

describe('compiler: client-script name-match (3b stage 1)', () => {
  it('converts kebab ↔ pascal', () => {
    expect(kebabToPascal('quantity-stepper')).toBe('QuantityStepper')
    expect(pascalToKebab('QuantityStepper')).toBe('quantity-stepper')
    expect(pascalToKebab('WishlistHeart')).toBe('wishlist-heart')
  })

  it('recognizes custom-element tags (lowercase + hyphen)', () => {
    expect(isCustomElementTag('quantity-stepper')).toBe(true)
    expect(isCustomElementTag('div')).toBe(false)
    expect(isCustomElementTag('Component')).toBe(false)
  })

  it('matches a tag to its same-named class', () => {
    const r = analyzeClient(
      'export class QuantityStepper extends StatorElement {}',
      new Set(['quantity-stepper']),
    )
    expect(r.elements).toEqual([{ tag: 'quantity-stepper', className: 'QuantityStepper' }])
  })

  it('matches multiple elements in one file (co-located islands)', () => {
    const script = `
      export class WishlistHeart extends StatorElement {}
      export class QuantityStepper extends StatorElement {}
    `
    const r = analyzeClient(script, new Set(['wishlist-heart', 'quantity-stepper']))
    expect(r.elements.map((e) => e.className).sort()).toEqual(['QuantityStepper', 'WishlistHeart'])
  })

  it('errors when a tag has no matching class', () => {
    expect(() =>
      analyzeClient('export class Other extends StatorElement {}', new Set(['quantity-stepper'])),
    ).toThrow(/no matching client class/)
  })

  it('errors when a class has no matching tag (dead code)', () => {
    expect(() =>
      analyzeClient('export class QuantityStepper extends StatorElement {}', new Set()),
    ).toThrow(/no matching <quantity-stepper> tag/)
  })

  it('ignores non-exported and non-class statements', () => {
    const script = `
      const x = 1
      class Internal {}
      export class MyToggle extends StatorElement {}
    `
    const r = analyzeClient(script, new Set(['my-toggle']))
    expect(r.elements).toEqual([{ tag: 'my-toggle', className: 'MyToggle' }])
  })
})
