import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import { CompileError, codeFrame, offsetToLineCol } from '../src/compiler/diagnostics.ts'

describe('compiler: diagnostics', () => {
  it('offsetToLineCol returns 1-based line/column', () => {
    const src = 'ab\ncde\nf'
    expect(offsetToLineCol(src, 0)).toEqual({ line: 1, column: 1 })
    expect(offsetToLineCol(src, 1)).toEqual({ line: 1, column: 2 })
    expect(offsetToLineCol(src, 3)).toEqual({ line: 2, column: 1 }) // first char of line 2
    expect(offsetToLineCol(src, 5)).toEqual({ line: 2, column: 3 })
    expect(offsetToLineCol(src, 7)).toEqual({ line: 3, column: 1 })
  })

  it('codeFrame marks the offending line with a caret', () => {
    const src = 'line one\nline two\nline three'
    const frame = codeFrame(src, 2, 6)
    expect(frame).toContain('> 2 | line two')
    expect(frame).toContain('^')
  })

  it('locates an unsupported directive at the right line/column in the original .stator', () => {
    // bind:text isn't supported until 3b — it should throw a located error.
    const src = `---
const x = 1
---
<div>
  <span bind:text={x}></span>
</div>`
    try {
      compile(src, { id: 'comp.stator' })
      throw new Error('expected compile to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError)
      const err = e as CompileError
      expect(err.loc).toBeDefined()
      // `<span` is on line 5 of the original file.
      expect(err.loc!.line).toBe(5)
      expect(err.loc!.file).toBe('comp.stator')
      expect(err.loc!.frame).toContain('bind:text')
    }
  })

  it('locates a directive error in a template with no frontmatter', () => {
    const src = `<p>hi</p>\n<button on:click></button>`
    try {
      compile(src)
      throw new Error('expected throw')
    } catch (e) {
      const err = e as CompileError
      expect(err.loc!.line).toBe(2) // the <button> line
    }
  })
})
