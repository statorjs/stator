import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.equal(
      lowerTemplate('<button ref:btn>+</button>', { meta: m }),
      'html`<button data-ref="btn">+</button>`',
    )
    assert.deepStrictEqual([...m.refs], ['btn'])
  })

  it('collects multiple refs', () => {
    const m = meta()
    lowerTemplate('<div><span ref:count></span><button ref:inc></button></div>', { meta: m })
    assert.deepStrictEqual([...m.refs].sort(), ['count', 'inc'])
  })

  it('keeps ref: alongside normal attributes', () => {
    assert.equal(
      lowerTemplate('<input ref:field type="text" />'),
      'html`<input data-ref="field" type="text">`',
    )
  })

  it('errors if ref: is given a value', () => {
    assert.throws(() => lowerTemplate('<button ref:btn={x}>+</button>'), CompileError)
  })
})
