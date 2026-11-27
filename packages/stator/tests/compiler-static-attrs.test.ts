import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { transform } from 'esbuild'
import { compile } from '../src/compiler/compile.ts'
import { lowerTemplate } from '../src/compiler/lower.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { html } from '../src/template/index.ts'
import { escapeAttribute } from '../src/template/parser.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/**
 * A static attribute value (`title="…"`) reaches the browser as exactly the text
 * the author wrote: escaped for the HTML attribute, and for the `html\`…\``
 * literal the compiler emits it into. It used to be emitted with JSON.stringify,
 * which escapes for a JS string, not for either of those (findings 05-F2/02-F9).
 */

function render(template: string, scope: Record<string, unknown> = {}): string {
  const expr = lowerTemplate(template)
  const names = ['html', ...Object.keys(scope)]
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `return (${expr})`)
  return inRender(() => fn(html, ...Object.values(scope)) as HtmlFragment).html
}

function inRender(f: () => HtmlFragment): HtmlFragment {
  return runInRender(createRenderState('s1', 'GET /'), f)
}

/** The browser's reading of a double-quoted attribute value (the entities
 *  escapeAttribute produces). */
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The single `title` attribute on the rendered `<p>`: its markup, which must
 *  be exactly the escapeAttribute form of the text, and the text it decodes to. */
function titleOf(out: string, text: string): string {
  const m = /^<p title="([^"]*)"><\/p>$/.exec(out)
  assert.ok(m, `expected exactly one well-formed title attribute, got: ${out}`)
  assert.equal(m[1], escapeAttribute(text))
  return decode(m[1]!)
}

describe('compiler: a static attribute value renders as its literal text', () => {
  const cases: Array<[label: string, template: string, text: string]> = [
    ['a double quote', `<p title='say "hi"'></p>`, 'say "hi"'],
    ['a single quote', `<p title="it's"></p>`, "it's"],
    ['an ampersand', '<p title="a & b"></p>', 'a & b'],
    ['an entity-looking ampersand', '<p title="&amp;"></p>', '&amp;'],
    ['a less-than', '<p title="a < b"></p>', 'a < b'],
    ['a backslash', '<p title="C:\\path\\n"></p>', 'C:\\path\\n'],
    ['a backtick', '<p title="a`b"></p>', 'a`b'],
    ['${…}', '<p title="Price: ${price}"></p>', 'Price: ${price}'],
    ['${…} that would evaluate', '<p title="${1+1}"></p>', '${1+1}'],
    ['JSON', `<p title='{"a":1}'></p>`, '{"a":1}'],
  ]
  for (const [label, template, text] of cases) {
    it(label, () => {
      // `price` in scope: the old output interpolated it instead of failing.
      assert.equal(titleOf(render(template, { price: 9 }), text), text)
    })
  }

  it('emits HTML-escaped, template-escaped markup', () => {
    assert.equal(
      lowerTemplate(`<p title='say "hi" \${x} \`'></p>`),
      'html`<p title="say &quot;hi&quot; \\${x} \\`"></p>`',
    )
  })

  it('a dynamic attribute still interpolates', () => {
    assert.equal(lowerTemplate('<p title={price}></p>'), 'html`<p title="${price}"></p>`')
    assert.match(render('<p title={price}></p>', { price: 9 }), / title="9">/)
    assert.match(render('<p title={q}></p>', { q: 'say "hi"' }), / title="say &quot;hi&quot;">/)
  })

  it('a plain value is emitted unchanged', () => {
    assert.equal(
      lowerTemplate('<input type="text" class="a b" disabled />'),
      'html`<input type="text" class="a b" disabled>`',
    )
  })

  it('a compiled component module stays valid with a backtick or ${ in a static attribute', async () => {
    const r = compile('<p title="a`b ${c} \\">x</p>', { id: 'c.stator' })
    await transform(r.serverCode, { loader: 'ts' }) // throws on a syntax error
    assert.ok(r.serverCode.includes('<p title="a\\`b \\${c} \\\\">x</p>'), r.serverCode)
  })

  it("an island's inner element gets the same escaping", async () => {
    const r = compile(
      `<my-widget><span title='say "hi" \${x}'>x</span></my-widget>

<script>
  export class MyWidget extends StatorElement {}
</script>`,
      { id: 'my-widget.stator' },
    )
    assert.equal(r.isClient, true)
    await transform(r.serverCode, { loader: 'ts' })
    assert.ok(r.serverCode.includes('<span title="say &quot;hi&quot; \\${x}">'), r.serverCode)
  })
})

describe('compiler: other author text written into the emitted template', () => {
  it('a doctype with a backtick or ${ stays text', () => {
    const out = render('<!doctype html `${x}`><p>x</p>')
    assert.equal(out, '<!doctype html `${x}`><p>x</p>')
  })

  it('a non-identifier <children name> is a quoted key, not code', () => {
    const expr = lowerTemplate('<div><children name="side-bar"/></div>')
    assert.equal(expr, 'html`<div>${props.children?.["side-bar"] ?? \'\'}</div>`')
    assert.equal(
      lowerTemplate('<div><children name="banner"/></div>'),
      "html`<div>${props.children?.banner ?? ''}</div>`",
    )
    // eslint-disable-next-line no-new-func
    const fn = new Function('html', 'props', `return (${expr})`)
    const out = inRender(
      () => fn(html, { children: { 'side-bar': html`<i>s</i>` } }) as HtmlFragment,
    )
    assert.equal(out.html, '<div><i>s</i></div>')
  })
})
