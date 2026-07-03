import { describe, expect, it } from 'vitest'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { type LowerMeta, lowerTemplate } from '../src/compiler/lower.ts'

function meta(): LowerMeta {
  return {
    usesChildren: false,
    regions: new Set(),
    components: new Set(),
    customElements: new Set(),
    refs: new Set(),
  }
}

describe('compiler: ref: directive (3b stage 2)', () => {
  it('lowers ref:name to a data-ref attribute and collects the name', () => {
    const m = meta()
    expect(lowerTemplate('<button ref:btn>+</button>', { meta: m })).toBe(
      'html`<button data-ref="btn">+</button>`',
    )
    expect([...m.refs]).toEqual(['btn'])
  })

  it('collects multiple refs', () => {
    const m = meta()
    lowerTemplate('<div><span ref:count></span><button ref:inc></button></div>', { meta: m })
    expect([...m.refs].sort()).toEqual(['count', 'inc'])
  })

  it('keeps ref: alongside normal attributes', () => {
    expect(lowerTemplate('<input ref:field type="text" />')).toBe(
      'html`<input data-ref="field" type="text" />`',
    )
  })

  it('errors if ref: is given a value', () => {
    expect(() => lowerTemplate('<button ref:btn={x}>+</button>')).toThrow(CompileError)
  })
})
