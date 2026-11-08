import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.deepStrictEqual(out.scripts, [])
    assert.equal(out.isClient, false)

    const warnings = compileWarnings(src)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]!.message, RAW_SCRIPT_WARNING)
    assert.equal(warnings[0]!.offset, at(src, '`<script'))
    assert.equal(warnings[0]!.loc.line, 5)
  })

  it('warns in frontmatter too, and for a plain string literal', () => {
    const src = `---
const tag = raw('<script>go()</script>')
---
<p>{tag}</p>`
    const warnings = compileWarnings(src)
    assert.deepStrictEqual(
      warnings.map((w) => w.offset),
      [at(src, "'<script>")],
    )
    assert.equal(warnings[0]!.loc.line, 2)
  })

  it('warns inside an attribute expression and nested JSX', () => {
    const src = `<div data-x={raw('<script src="a.js"></script>')}>{ok && <p>{raw("<SCRIPT>x</SCRIPT>")}</p>}</div>`
    assert.deepStrictEqual(
      compileWarnings(src).map((w) => w.offset),
      [at(src, `'<script src`), at(src, '"<SCRIPT>')],
    )
  })

  it("doesn't warn for a variable passed to raw()", () => {
    assert.deepStrictEqual(compileWarnings('<head>{raw(snippet)}</head>'), [])
  })

  it("doesn't warn for a plain string, which is escaped on output", () => {
    assert.deepStrictEqual(
      compileWarnings(`<pre>{'Use <script>…</script> for client code'}</pre>`),
      [],
    )
  })

  it("doesn't warn for a <style> string", () => {
    assert.deepStrictEqual(compileWarnings(`<head>{raw('<style>p {}</style>')}</head>`), [])
  })

  it("doesn't warn for a top-level <script> or a lookalike tag", () => {
    const src = `<p>{raw('<scripted-thing></scripted-thing>')}</p>
<script>export class A extends StatorElement { m() { return raw('<script>') } }</script>`
    assert.deepStrictEqual(compileWarnings(src), [])
  })
})
