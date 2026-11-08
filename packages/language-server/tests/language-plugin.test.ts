import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IScriptSnapshot } from 'typescript'
import { StatorVirtualCode, statorLanguagePlugin } from '../src/language-plugin.ts'

function snap(text: string): IScriptSnapshot {
  return {
    getText: (s, e) => text.slice(s, e),
    getLength: () => text.length,
    getChangeRange: () => undefined,
  }
}

const read = (code: { snapshot: IScriptSnapshot }): string =>
  code.snapshot.getText(0, code.snapshot.getLength())

describe('stator language plugin', () => {
  it('recognizes .stator by language id', () => {
    assert.equal(statorLanguagePlugin.getLanguageId({ path: 'x/y.stator' } as never), 'stator')
    assert.equal(statorLanguagePlugin.getLanguageId({ path: 'x/y.ts' } as never), undefined)
  })

  it('splits a server component into a tsx embed + a css embed', () => {
    const src = `---
const [cart] = Stator.reads([CartMachine])
---
<main>{read(cart, c => c.total)}</main>

<style>.x { color: red }</style>`
    const vc = new StatorVirtualCode(snap(src))
    const ids = vc.embeddedCodes.map((c) => c.id)
    assert.deepStrictEqual(ids, ['tsx', 'css_0'])

    const tsx = vc.embeddedCodes.find((c) => c.id === 'tsx')!
    assert.equal(tsx.languageId, 'typescriptreact')
    assert.ok(read(tsx).includes('read(cart, c => c.total)'))
    assert.ok(tsx.mappings[0]!.sourceOffsets.length > 0)

    const css = vc.embeddedCodes.find((c) => c.id === 'css_0')!
    assert.equal(css.languageId, 'css')
    assert.equal(read(css), '.x { color: red }')
  })

  it('the root code carries an identity mapping gated to verification only', () => {
    // This is what routes the stator diagnostics service to the source doc
    // with 1:1 positions, without inviting TS/CSS features onto it.
    const src = `<main>hi</main>`
    const vc = new StatorVirtualCode(snap(src))
    assert.equal(vc.mappings.length, 1)
    const m = vc.mappings[0]!
    assert.deepStrictEqual(m.sourceOffsets, [0])
    assert.deepStrictEqual(m.generatedOffsets, [0])
    assert.deepStrictEqual(m.lengths, [src.length])
    assert.equal(m.data.verification, true)
    assert.equal(m.data.completion, false)
    assert.equal(m.data.semantic, false)
  })

  it('getServiceScript picks the tsx embed as the TS script', () => {
    const src = `<main>hi</main>`
    const vc = new StatorVirtualCode(snap(src))
    const script = statorLanguagePlugin.typescript!.getServiceScript(vc)
    assert.equal(script?.extension, '.tsx')
    assert.equal(script?.code.id, 'tsx')
  })
})
