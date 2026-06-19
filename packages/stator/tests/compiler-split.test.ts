import { describe, it, expect } from 'vitest'
import { splitStator } from '../src/compiler/split.ts'

describe('compiler: splitStator', () => {
  it('splits frontmatter, template, style, and script regions', () => {
    const src = `---
import { read } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
---

<div class="cart">Total: {read(cart, c => c.total)}</div>

<style>
  .cart { color: red; }
</style>

<script>
  import CartMachine from '../machines/cart.ts'
  console.log('client')
</script>
`
    const r = splitStator(src)
    expect(r.frontmatter).toContain("import { read }")
    expect(r.frontmatter).toContain('import type CartMachine')
    expect(r.template).toBe('<div class="cart">Total: {read(cart, c => c.total)}</div>')
    expect(r.styles).toEqual(['.cart { color: red; }'])
    expect(r.scripts).toHaveLength(1)
    expect(r.scripts[0]).toContain("console.log('client')")
  })

  it('handles a template with no frontmatter', () => {
    const src = `<p>Hello</p>`
    const r = splitStator(src)
    expect(r.frontmatter).toBe('')
    expect(r.template).toBe('<p>Hello</p>')
    expect(r.styles).toEqual([])
    expect(r.scripts).toEqual([])
  })

  it('collects multiple style regions in source order', () => {
    const src = `<div></div>
<style>.a { color: red }</style>
<style>.b { color: blue }</style>`
    const r = splitStator(src)
    expect(r.styles).toEqual(['.a { color: red }', '.b { color: blue }'])
  })

  it('leaves literal <script src> markup in the template (only bare <script> is a region)', () => {
    const src = `<body>
  <main>content</main>
  <script src="/static/client.js"></script>
  <script src="/static/inspector.js" defer></script>
</body>`
    const r = splitStator(src)
    // Attribute-bearing scripts are document markup, not client-code regions.
    expect(r.scripts).toEqual([])
    expect(r.template).toContain('<script src="/static/client.js"></script>')
    expect(r.template).toContain('<script src="/static/inspector.js" defer></script>')
  })

  it('distinguishes a bare client <script> from a literal <script src> in the same file', () => {
    const src = `<div>page</div>
<script src="/x.js"></script>
<script>
  export default class extends StatorElement {}
</script>`
    const r = splitStator(src)
    expect(r.scripts).toHaveLength(1)
    expect(r.scripts[0]).toContain('StatorElement')
    expect(r.template).toContain('<script src="/x.js"></script>')
    expect(r.template).not.toContain('StatorElement')
  })

  it('handles CRLF line endings in the frontmatter fence', () => {
    const src = '---\r\nconst x = 1\r\n---\r\n<p>{x}</p>'
    const r = splitStator(src)
    expect(r.frontmatter).toBe('const x = 1')
    expect(r.template).toBe('<p>{x}</p>')
  })
})
