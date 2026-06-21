import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { declaredRegions, componentImportSpecifier } from '../src/compiler/regions.ts'

describe('compiler: declaredRegions / import resolution', () => {
  it('extracts named regions from a component', () => {
    const src = '<div><children name="banner"/><children/><children name="footer"/></div>'
    expect([...declaredRegions(src)].sort()).toEqual(['banner', 'footer'])
  })

  it('returns empty when a component declares no named regions', () => {
    expect([...declaredRegions('<main><children/></main>')]).toEqual([])
  })

  it('resolves a component default-import specifier from frontmatter', () => {
    const fm = `import Layout from './layout.stator'\nimport type Cart from '../machines/cart.ts'`
    expect(componentImportSpecifier(fm, 'Layout')).toBe('./layout.stator')
    expect(componentImportSpecifier(fm, 'Cart')).toBe(null) // not a .stator
    expect(componentImportSpecifier(fm, 'Nope')).toBe(null)
  })
})

describe('compiler: named-child validation (stage 2b)', () => {
  const src = `---
import Layout from './layout.stator'
---
<Layout><div child="banner">hi</div></Layout>`

  it('passes when the region is declared', () => {
    const regions = new Set(['banner'])
    expect(() =>
      compile(src, { id: 'page.stator', resolveRegions: () => regions }),
    ).not.toThrow()
  })

  it('errors with a located message when the region is undeclared', () => {
    const regions = new Set(['footer']) // banner is NOT declared
    try {
      compile(src, { id: 'page.stator', resolveRegions: () => regions })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError)
      const err = e as CompileError
      expect(err.message).toContain('no child region "banner"')
      expect(err.message).toContain('"footer"') // lists what IS declared
      expect(err.loc?.line).toBe(4) // the <Layout> line in the original
    }
  })

  it('skips validation when no resolver is supplied', () => {
    expect(() => compile(src, { id: 'page.stator' })).not.toThrow()
  })
})
