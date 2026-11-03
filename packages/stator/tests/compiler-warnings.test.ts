import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import { compileWarnings, RAW_SCRIPT_WARNING } from '../src/compiler/warnings.ts'

const at = (src: string, needle: string): number => src.indexOf(needle)

describe('compiler warnings: <script> strings passed to raw()', () => {
  it('compiles the template-literal repro, and warns at the literal', () => {
    // Once lifted out as a client component, cutting the literal in half.
    const src = `---
import { raw } from '@statorjs/stator/template'
const json = '{"prerender":[]}'
---
<head>{json ? raw(\`<script type="speculationrules">\${json}</script>\`) : null}</head>`
    const out = compile(src, { id: 'speculation.stator', kind: 'component' })
    expect(out.scripts).toEqual([])
    expect(out.isClient).toBe(false)

    const warnings = compileWarnings(src)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toBe(RAW_SCRIPT_WARNING)
    expect(warnings[0]!.offset).toBe(at(src, '`<script'))
    expect(warnings[0]!.loc.line).toBe(5)
  })

  it('warns in frontmatter too, and for a plain string literal', () => {
    const src = `---
const tag = raw('<script>go()</script>')
---
<p>{tag}</p>`
    const warnings = compileWarnings(src)
    expect(warnings.map((w) => w.offset)).toEqual([at(src, "'<script>")])
    expect(warnings[0]!.loc.line).toBe(2)
  })

  it('warns inside an attribute expression and nested JSX', () => {
    const src = `<div data-x={raw('<script src="a.js"></script>')}>{ok && <p>{raw("<SCRIPT>x</SCRIPT>")}</p>}</div>`
    expect(compileWarnings(src).map((w) => w.offset)).toEqual([
      at(src, `'<script src`),
      at(src, '"<SCRIPT>'),
    ])
  })

  it("doesn't warn for a variable passed to raw()", () => {
    expect(compileWarnings('<head>{raw(snippet)}</head>')).toEqual([])
  })

  it("doesn't warn for a plain string, which is escaped on output", () => {
    expect(compileWarnings(`<pre>{'Use <script>…</script> for client code'}</pre>`)).toEqual([])
  })

  it("doesn't warn for a <style> string", () => {
    expect(compileWarnings(`<head>{raw('<style>p {}</style>')}</head>`)).toEqual([])
  })

  it("doesn't warn for a top-level <script> or a lookalike tag", () => {
    const src = `<p>{raw('<scripted-thing></scripted-thing>')}</p>
<script>export class A extends StatorElement { m() { return raw('<script>') } }</script>`
    expect(compileWarnings(src)).toEqual([])
  })
})
