import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.ok(r.frontmatter.includes('import { read }'))
    assert.ok(r.frontmatter.includes('import type CartMachine'))
    assert.equal(r.template, '<div class="cart">Total: {read(cart, c => c.total)}</div>')
    assert.deepStrictEqual(r.styles, ['.cart { color: red; }'])
    assert.equal(r.scripts.length, 1)
    assert.ok(r.scripts[0])
    assert.ok(r.scripts[0]!.includes("console.log('client')"))
  })

  it('handles a template with no frontmatter', () => {
    const src = `<p>Hello</p>`
    const r = splitStator(src)
    assert.equal(r.frontmatter, '')
    assert.equal(r.template, '<p>Hello</p>')
    assert.deepStrictEqual(r.styles, [])
    assert.deepStrictEqual(r.scripts, [])
  })

  it('collects multiple style regions in source order', () => {
    const src = `<div></div>
<style>.a { color: red }</style>
<style>.b { color: blue }</style>`
    const r = splitStator(src)
    assert.deepStrictEqual(r.styles, ['.a { color: red }', '.b { color: blue }'])
  })

  it('leaves literal <script src> markup in the template (only bare <script> is a region)', () => {
    const src = `<body>
  <main>content</main>
  <script src="/static/client.js"></script>
  <script src="/static/inspector.js" defer></script>
</body>`
    const r = splitStator(src)
    // Attribute-bearing scripts are document markup, not client-code regions.
    assert.deepStrictEqual(r.scripts, [])
    assert.ok(r.template.includes('<script src="/static/client.js"></script>'))
    assert.ok(r.template.includes('<script src="/static/inspector.js" defer></script>'))
  })

  it('distinguishes an inline client <script> from a literal <script src> in the same file', () => {
    const src = `<div>page</div>
<script src="/x.js"></script>
<script>
  export default class extends StatorElement {}
</script>`
    const r = splitStator(src)
    assert.equal(r.scripts.length, 1)
    assert.ok(r.scripts[0])
    assert.ok(r.scripts[0]!.includes('StatorElement'))
    assert.ok(r.template.includes('<script src="/x.js"></script>'))
    assert.ok(!r.template.includes('StatorElement'))
  })

  it('captures an inline <script> even when it carries incidental attributes', () => {
    // Only `src` / `is:inline` opt out — `type`/`lang` etc. stay components, so
    // an incidental attribute can't silently demote a component to dead markup.
    const src = `<div>page</div>
<script type="module" lang="ts">
  export class Widget extends StatorElement {}
</script>`
    const r = splitStator(src)
    assert.equal(r.scripts.length, 1)
    assert.ok(r.scripts[0])
    assert.ok(r.scripts[0]!.includes('class Widget'))
    assert.equal(r.template, '<div>page</div>')
  })

  it('leaves a <script is:inline> in the template as literal markup', () => {
    const src = `<head>
  <script is:inline>if (a) { go() }</script>
</head>`
    const r = splitStator(src)
    // Verbatim inline script — not a client-code region.
    assert.deepStrictEqual(r.scripts, [])
    assert.ok(r.template.includes('<script is:inline>if (a) { go() }</script>'))
  })

  it('records the source offset of each captured script', () => {
    const src = `<div>x</div>
<script>export class A extends StatorElement {}</script>`
    const r = splitStator(src)
    assert.equal(r.scriptOffsets.length, 1)
    assert.match(src.slice(r.scriptOffsets[0]), /^<script>/)
  })

  it('handles CRLF line endings in the frontmatter fence', () => {
    const src = '---\r\nconst x = 1\r\n---\r\n<p>{x}</p>'
    const r = splitStator(src)
    assert.equal(r.frontmatter, 'const x = 1')
    assert.equal(r.template, '<p>{x}</p>')
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
        assert.deepStrictEqual(r.scripts, [])
        assert.deepStrictEqual(r.styles, [])
        assert.equal(r.template, template)
      })
    }

    it('still finds the real regions after an expression full of tag text', () => {
      const src = `<p>{n > 1 ? \`<style>\` : '<script>'}</p>
<script>export class A extends StatorElement {}</script>
<style>p { color: red }</style>`
      const r = splitStator(src)
      assert.deepStrictEqual(r.scripts, ['export class A extends StatorElement {}'])
      assert.deepStrictEqual(r.styles, ['p { color: red }'])
      assert.equal(r.template, "<p>{n > 1 ? `<style>` : '<script>'}</p>")
    })

    it("reads JSX text inside an expression as text, so an apostrophe isn't a string", () => {
      const src = `<ul>{items.map(i => <li>Don't {i}</li>)}</ul>
<script>export class A extends StatorElement {}</script>`
      const r = splitStator(src)
      assert.equal(r.scripts.length, 1)
      assert.equal(r.template, "<ul>{items.map(i => <li>Don't {i}</li>)}</ul>")
    })

    it('treats an is:inline body as raw text, braces and all', () => {
      const src = `<script is:inline>if (a) { go('}') }</script>
<p>{x}</p>
<script>export class A extends StatorElement {}</script>`
      const r = splitStator(src)
      assert.deepStrictEqual(r.scripts, ['export class A extends StatorElement {}'])
      assert.ok(r.template.includes("<script is:inline>if (a) { go('}') }</script>"))
    })

    it('reads an attribute expression containing > without ending the tag', () => {
      const src = `<p title={a > b ? '<style>' : ''}>x</p>
<style>p { color: red }</style>`
      const r = splitStator(src)
      assert.deepStrictEqual(r.styles, ['p { color: red }'])
      assert.equal(r.template, `<p title={a > b ? '<style>' : ''}>x</p>`)
    })

    it('scanRegions agrees, and ignores tag text in the frontmatter', () => {
      const src = `---
const css = '<style>p {}</style>'
---
<p>{'<script>x</script>'}</p>
<style>p { color: red }</style>`
      const r = scanRegions(src)
      assert.deepStrictEqual(r.scripts, [])
      assert.deepStrictEqual(
        r.styles.map((s) => s.content),
        ['p { color: red }'],
      )
      assert.match(src.slice(r.styles[0]!.contentOffset), /^p \{ color: red \}/)
      assert.equal(r.template.content.trim(), `<p>{'<script>x</script>'}</p>`)
    })
  })
})
