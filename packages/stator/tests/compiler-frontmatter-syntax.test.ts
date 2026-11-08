import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { toVirtualCode } from '../src/compiler/virtual-code.ts'

/**
 * The fence is plain TypeScript (ScriptKind.TS). JSX in it used to pass
 * `stator check` (the TSX model accepted it) and fail only as esbuild's
 * `Expected ")" but found "return"` on the emitted module.
 */
describe('compiler: frontmatter syntax', () => {
  it('JSX in the fence is a located error with the targeted hint', () => {
    const src = `---\nconst page = null\nif (!page) return <p>not found</p>\n---\n<main>ok</main>\n`
    try {
      compile(src, { id: 'routes/x.stator', kind: 'route' })
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes("JSX isn't allowed in frontmatter"))
      assert.ok(err.message.includes('routes/404.stator'))
      assert.equal(err.loc?.line, 3)
      assert.equal(err.loc?.column, 19)
      assert.equal(err.loc?.file, 'routes/x.stator')
    }
  })

  it("any other syntax error is located with TypeScript's own message", () => {
    const src = `---\nconst n = 1 +\n---\n<p>{n}</p>\n`
    try {
      compile(src, { id: 'x.stator' })
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('frontmatter syntax error'))
      assert.ok(err.message.includes('Expression expected'))
      assert.equal(err.loc?.line, 2)
    }
  })

  it('a generic arrow function in the fence stays legal', () => {
    const src = `---\nconst id = <T>(a: T) => a\nconst n = id(1)\n---\n<p>{n}</p>\n`
    assert.doesNotThrow(() => compile(src, { id: 'x.stator' }))
  })

  it('the editor model emits a broken statement as a string, never as JSX that looks fine', () => {
    const src = `---\nconst page = null\nif (!page) return <p>not found</p>\n---\n<main>ok</main>\n`
    const { code } = toVirtualCode(src).tsx
    assert.ok(code.includes(JSON.stringify('if (!page) return <p>not')))
    assert.ok(code.includes(JSON.stringify('found</p>')))
    assert.doesNotMatch(code, /^\s*if \(!page\) return <p>/m)
    assert.ok(code.includes('const page = null'))
  })
})
