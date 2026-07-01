import { describe, it, expect } from 'vitest'
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
    expect(statorLanguagePlugin.getLanguageId({ path: 'x/y.stator' } as never)).toBe('stator')
    expect(statorLanguagePlugin.getLanguageId({ path: 'x/y.ts' } as never)).toBeUndefined()
  })

  it('splits a server component into a tsx embed + a css embed', () => {
    const src = `---
const [cart] = Stator.reads([CartMachine])
---
<main>{read(cart, c => c.total)}</main>

<style>.x { color: red }</style>`
    const vc = new StatorVirtualCode(snap(src))
    const ids = vc.embeddedCodes.map((c) => c.id)
    expect(ids).toEqual(['tsx', 'css_0'])

    const tsx = vc.embeddedCodes.find((c) => c.id === 'tsx')!
    expect(tsx.languageId).toBe('typescriptreact')
    expect(read(tsx)).toContain('read(cart, c => c.total)')
    expect(tsx.mappings[0]!.sourceOffsets.length).toBeGreaterThan(0)

    const css = vc.embeddedCodes.find((c) => c.id === 'css_0')!
    expect(css.languageId).toBe('css')
    expect(read(css)).toBe('.x { color: red }')
  })

  it('getServiceScript picks the tsx embed as the TS script', () => {
    const src = `<main>hi</main>`
    const vc = new StatorVirtualCode(snap(src))
    const script = statorLanguagePlugin.typescript!.getServiceScript(vc)
    expect(script?.extension).toBe('.tsx')
    expect(script?.code.id).toBe('tsx')
  })
})
