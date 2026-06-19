import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler/compile.ts'

describe('compiler: compile (full server module)', () => {
  it('assembles imports, props, and the lowered template', () => {
    const src = `---
import type CartMachine from '../machines/cart.ts'
import type { InstanceOf } from '@statorjs/stator/template'
const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<div class="cart">Total: {read(cart, c => c.total)}</div>`

    const { serverCode } = compile(src)

    // Primitives auto-injected.
    expect(serverCode).toContain(
      "import { html, read, each, when, match, on, classList, styleList } from '@statorjs/stator/template'",
    )
    // Author imports hoisted.
    expect(serverCode).toContain("import type CartMachine from '../machines/cart.ts'")
    // Stator.props<P>() → typed `props` parameter + destructure from props.
    expect(serverCode).toContain(
      'export default function (props: { cart: InstanceOf<typeof CartMachine> }) {',
    )
    expect(serverCode).toContain('const { cart } = props')
    // Lowered template returned.
    expect(serverCode).toContain(
      'return html`<div class="cart">Total: ${read(cart, c => c.total)}</div>`',
    )
  })

  it('handles a template with no frontmatter (no props param)', () => {
    const { serverCode } = compile('<p>static</p>')
    expect(serverCode).toContain('export default function () {')
    expect(serverCode).toContain('return html`<p>static</p>`')
  })

  it('hoists type aliases above the function, keeps body statements inside', () => {
    const src = `---
type Props = { n: number }
const { n } = Stator.props<Props>()
const doubled = n * 2
---
<p>{doubled}</p>`
    const { serverCode } = compile(src)
    const fnIdx = serverCode.indexOf('export default function')
    expect(serverCode.indexOf('type Props = { n: number }')).toBeLessThan(fnIdx)
    expect(serverCode).toContain('export default function (props: Props) {')
    expect(serverCode).toContain('const { n } = props')
    // body statement that isn't an import/type stays inside the function
    expect(serverCode.indexOf('const doubled = n * 2')).toBeGreaterThan(fnIdx)
  })

  it('scopes styles and injects the scope attribute on elements', () => {
    const src = `<p class="x">hi</p>
<style>.x { color: red }</style>`
    const r = compile(src, { id: 'comp.stator' })
    // attribute injected on the element
    expect(r.serverCode).toContain(`<p class="x" data-s-${r.scopeHash}>`)
    // selector rewritten to require the same attribute
    expect(r.css).toContain(`.x[data-s-${r.scopeHash}]`)
  })

  it('does not inject a scope attribute when there is no <style>', () => {
    const r = compile('<p class="x">hi</p>')
    expect(r.serverCode).not.toContain('data-s-')
    expect(r.css).toBe('')
  })

  it('passes through scripts for later stages', () => {
    const r = compile(`<p>x</p>
<script>console.log('c')</script>`)
    expect(r.scripts[0]).toContain("console.log('c')")
  })
})
