import { describe, expect, it } from 'vitest'
import { scanRegions, splitStator } from '../src/compiler/split.ts'

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
    expect(r.frontmatter).toContain('import { read }')
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

  it('distinguishes an inline client <script> from a literal <script src> in the same file', () => {
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

  it('captures an inline <script> even when it carries incidental attributes', () => {
    // Only `src` / `is:inline` opt out — `type`/`lang` etc. stay components, so
    // an incidental attribute can't silently demote a component to dead markup.
    const src = `<div>page</div>
<script type="module" lang="ts">
  export class Widget extends StatorElement {}
</script>`
    const r = splitStator(src)
    expect(r.scripts).toHaveLength(1)
    expect(r.scripts[0]).toContain('class Widget')
    expect(r.template).toBe('<div>page</div>')
  })

  it('leaves a <script is:inline> in the template as literal markup', () => {
    const src = `<head>
  <script is:inline>if (a) { go() }</script>
</head>`
    const r = splitStator(src)
    // Verbatim inline script — not a client-code region.
    expect(r.scripts).toEqual([])
    expect(r.template).toContain('<script is:inline>if (a) { go() }</script>')
  })

  it('records the source offset of each captured script', () => {
    const src = `<div>x</div>
<script>export class A extends StatorElement {}</script>`
    const r = splitStator(src)
    expect(r.scriptOffsets).toHaveLength(1)
    expect(src.slice(r.scriptOffsets[0])).toMatch(/^<script>/)
  })

  it('handles CRLF line endings in the frontmatter fence', () => {
    const src = '---\r\nconst x = 1\r\n---\r\n<p>{x}</p>'
    const r = splitStator(src)
    expect(r.frontmatter).toBe('const x = 1')
    expect(r.template).toBe('<p>{x}</p>')
  })

  describe('only top-level <script> / <style> are regions', () => {
    // Each of these once lifted text out of an expression and cut the template.
    const cases: [string, string][] = [
      [
        'a script in a template literal',
        '{json ? raw(`<script type="speculationrules">${json}</script>`) : null}',
      ],
      ['a style in a string', `{cond ? '<style>p { color: red }</style>' : ''}`],
      ['a code-sample expression', `<pre>{'Use <script>…</script> for client code'}</pre>`],
      ['a comment in an expression', '{/* a </script> or a <style>p {}</style> */ x}'],
      ['an HTML comment', '<!-- <script>no()</script> -->\n<p>x</p>'],
      ['a regex literal', '{s.replace(/<script>[^<]*<\\/script>/g, "")}'],
    ]
    for (const [name, template] of cases) {
      it(`leaves ${name} in the template`, () => {
        const r = splitStator(`---\nconst json = '{}'\n---\n${template}`)
        expect(r.scripts).toEqual([])
        expect(r.styles).toEqual([])
        expect(r.template).toBe(template)
      })
    }

    it('still finds the real regions after an expression full of tag text', () => {
      const src = `<p>{n > 1 ? \`<style>\` : '<script>'}</p>
<script>export class A extends StatorElement {}</script>
<style>p { color: red }</style>`
      const r = splitStator(src)
      expect(r.scripts).toEqual(['export class A extends StatorElement {}'])
      expect(r.styles).toEqual(['p { color: red }'])
      expect(r.template).toBe("<p>{n > 1 ? `<style>` : '<script>'}</p>")
    })

    it("reads JSX text inside an expression as text, so an apostrophe isn't a string", () => {
      const src = `<ul>{items.map(i => <li>Don't {i}</li>)}</ul>
<script>export class A extends StatorElement {}</script>`
      const r = splitStator(src)
      expect(r.scripts).toHaveLength(1)
      expect(r.template).toBe("<ul>{items.map(i => <li>Don't {i}</li>)}</ul>")
    })

    it('treats an is:inline body as raw text, braces and all', () => {
      const src = `<script is:inline>if (a) { go('}') }</script>
<p>{x}</p>
<script>export class A extends StatorElement {}</script>`
      const r = splitStator(src)
      expect(r.scripts).toEqual(['export class A extends StatorElement {}'])
      expect(r.template).toContain("<script is:inline>if (a) { go('}') }</script>")
    })

    it('reads an attribute expression containing > without ending the tag', () => {
      const src = `<p title={a > b ? '<style>' : ''}>x</p>
<style>p { color: red }</style>`
      const r = splitStator(src)
      expect(r.styles).toEqual(['p { color: red }'])
      expect(r.template).toBe(`<p title={a > b ? '<style>' : ''}>x</p>`)
    })

    it('scanRegions agrees, and ignores tag text in the frontmatter', () => {
      const src = `---
const css = '<style>p {}</style>'
---
<p>{'<script>x</script>'}</p>
<style>p { color: red }</style>`
      const r = scanRegions(src)
      expect(r.scripts).toEqual([])
      expect(r.styles.map((s) => s.content)).toEqual(['p { color: red }'])
      expect(src.slice(r.styles[0]!.contentOffset)).toMatch(/^p \{ color: red \}/)
      expect(r.template.content.trim()).toBe(`<p>{'<script>x</script>'}</p>`)
    })
  })
})
