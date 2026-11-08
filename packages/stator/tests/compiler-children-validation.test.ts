import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { componentImportSpecifier, declaredRegions } from '../src/compiler/regions.ts'

describe('compiler: declaredRegions / import resolution', () => {
  it('extracts named regions from a component', () => {
    const src = '<div><children name="banner"/><children/><children name="footer"/></div>'
    assert.deepStrictEqual([...declaredRegions(src)].sort(), ['banner', 'footer'])
  })

  it('returns empty when a component declares no named regions', () => {
    assert.deepStrictEqual([...declaredRegions('<main><children/></main>')], [])
  })

  it('resolves a component default-import specifier from frontmatter', () => {
    const fm = `import Layout from './layout.stator'\nimport type Cart from '../machines/cart.ts'`
    assert.equal(componentImportSpecifier(fm, 'Layout'), './layout.stator')
    assert.equal(componentImportSpecifier(fm, 'Cart'), null) // not a .stator
    assert.equal(componentImportSpecifier(fm, 'Nope'), null)
  })
})

describe('compiler: named-child validation (stage 2b)', () => {
  const src = `---
import Layout from './layout.stator'
---
<Layout><div child="banner">hi</div></Layout>`

  it('passes when the region is declared', () => {
    const regions = new Set(['banner'])
    assert.doesNotThrow(() => compile(src, { id: 'page.stator', resolveRegions: () => regions }))
  })

  it('errors with a located message when the region is undeclared', () => {
    const regions = new Set(['footer']) // banner is NOT declared
    try {
      compile(src, { id: 'page.stator', resolveRegions: () => regions })
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('no child region "banner"'))
      assert.ok(err.message.includes('"footer"')) // lists what IS declared
      assert.equal(err.loc?.line, 4) // the <Layout> line in the original
    }
  })

  it('skips validation when no resolver is supplied', () => {
    assert.doesNotThrow(() => compile(src, { id: 'page.stator' }))
  })
})

describe('compiler: child="x" placement', () => {
  const fm = `---\nimport Layout from './layout.stator'\nimport Banner from './banner.stator'\n---\n`
  const regions = new Set(['top'])
  const compileWith = (template: string) =>
    compile(fm + template, { id: 'page.stator', kind: 'route', resolveRegions: () => regions })

  it('a direct element child of a component still works', () => {
    assert.doesNotThrow(() => compileWith(`<Layout><div child="top">hi</div></Layout>`))
  })

  it('inside a {…} expression is a located error', () => {
    try {
      compileWith(`<Layout>{true ? <div child="top">hi</div> : null}</Layout>`)
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('child="top" has no effect here'))
      assert.ok(err.message.includes('<div child="top">{cond ? … : null}</div>'))
      assert.equal(err.loc?.line, 5)
    }
  })

  it('nested deeper than a direct child is a located error', () => {
    assert.throws(
      () => compileWith(`<Layout><section><div child="top">hi</div></section></Layout>`),
      CompileError,
    )
  })

  it('at the template root is a located error', () => {
    assert.throws(() => compileWith(`<div child="top">hi</div>`), /has no effect here/)
  })

  it('on a component tag is a located error naming the wrap', () => {
    try {
      compileWith(`<Layout><Banner child="top" /></Layout>`)
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('child="top" on <Banner/> has no effect'))
      assert.ok(err.message.includes('<div child="top"><Banner/></div>'))
      assert.equal(err.loc?.line, 5)
    }
  })
})
