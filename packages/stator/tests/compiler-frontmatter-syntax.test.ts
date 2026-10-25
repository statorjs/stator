import { describe, expect, it } from 'vitest'
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
      expect(e).toBeInstanceOf(CompileError)
      const err = e as CompileError
      expect(err.message).toContain("JSX isn't allowed in frontmatter")
      expect(err.message).toContain('routes/404.stator')
      expect(err.loc?.line).toBe(3)
      expect(err.loc?.column).toBe(19)
      expect(err.loc?.file).toBe('routes/x.stator')
    }
  })

  it("any other syntax error is located with TypeScript's own message", () => {
    const src = `---\nconst n = 1 +\n---\n<p>{n}</p>\n`
    try {
      compile(src, { id: 'x.stator' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError)
      const err = e as CompileError
      expect(err.message).toContain('frontmatter syntax error')
      expect(err.message).toContain('Expression expected')
      expect(err.loc?.line).toBe(2)
    }
  })

  it('a generic arrow function in the fence stays legal', () => {
    const src = `---\nconst id = <T>(a: T) => a\nconst n = id(1)\n---\n<p>{n}</p>\n`
    expect(() => compile(src, { id: 'x.stator' })).not.toThrow()
  })

  it('the editor model emits a broken statement as a string, never as JSX that looks fine', () => {
    const src = `---\nconst page = null\nif (!page) return <p>not found</p>\n---\n<main>ok</main>\n`
    const { code } = toVirtualCode(src).tsx
    expect(code).toContain(JSON.stringify('if (!page) return <p>not'))
    expect(code).toContain(JSON.stringify('found</p>'))
    expect(code).not.toMatch(/^\s*if \(!page\) return <p>/m)
    expect(code).toContain('const page = null')
  })
})
