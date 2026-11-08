import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.ok(
      serverCode.includes(
        "import { read, each, when, match, defer, on, classList, styleList, html, itemBind, spreadAttrs } from '@statorjs/stator/template'",
      ),
    )
    // Author imports hoisted.
    assert.ok(serverCode.includes("import type CartMachine from '../machines/cart.ts'"))
    // Stator.props<P>() → typed `props` parameter + destructure from props.
    assert.ok(
      serverCode.includes(
        'export default function (props: { cart: InstanceOf<typeof CartMachine> }) {',
      ),
    )
    assert.ok(serverCode.includes('const { cart } = props'))
    // Lowered template returned.
    assert.ok(
      serverCode.includes(
        'return html`<div class="cart">Total: ${read(cart, c => c.total)}</div>`',
      ),
    )
  })

  it('recognizes defer() as an ambient template global (no author import needed)', () => {
    const src = `<main>{defer(() => db.getPost(1), { ready: (p) => <article>{p.title}</article> })}</main>`
    const { serverCode } = compile(src)
    // `defer` is in the auto-injected import…
    assert.ok(
      serverCode.includes(
        "import { read, each, when, match, defer, on, classList, styleList, html, itemBind, spreadAttrs } from '@statorjs/stator/template'",
      ),
    )
    // …and the call is lowered into the template unchanged.
    assert.ok(serverCode.includes('defer(() => db.getPost(1),'))
  })

  it('handles a template with no frontmatter (no props param)', () => {
    const { serverCode } = compile('<p>static</p>')
    assert.ok(serverCode.includes('export default function () {'))
    assert.ok(serverCode.includes('return html`<p>static</p>`'))
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
    assert.ok(serverCode.indexOf('type Props = { n: number }') < fnIdx)
    assert.ok(serverCode.includes('export default function (props: Props) {'))
    assert.ok(serverCode.includes('const { n } = props'))
    // body statement that isn't an import/type stays inside the function
    assert.ok(serverCode.indexOf('const doubled = n * 2') > fnIdx)
  })

  it('scopes styles and injects the scope attribute on elements', () => {
    const src = `<p class="x">hi</p>
<style>.x { color: red }</style>`
    const r = compile(src, { id: 'comp.stator' })
    // attribute injected on the element
    assert.ok(r.serverCode.includes(`<p class="x" data-s-${r.scopeHash}>`))
    // selector rewritten to require the same attribute
    assert.ok(r.css.includes(`.x[data-s-${r.scopeHash}]`))
  })

  it('does not inject a scope attribute when there is no <style>', () => {
    const r = compile('<p class="x">hi</p>')
    assert.ok(!r.serverCode.includes('data-s-'))
    assert.equal(r.css, '')
  })

  it('errors on an inline <script> that exports no StatorElement', () => {
    // An inline <script> is a client component; one with no StatorElement is a
    // malformed component, surfaced rather than silently dropped.
    assert.throws(
      () =>
        compile(
          `<p>x</p>
<script>console.log('c')</script>`,
          { id: 'comp.stator' },
        ),
      /no StatorElement subclass/,
    )
  })

  it('emits a <script is:inline> verbatim, directive stripped', () => {
    const r = compile(`<head>
  <script is:inline>if (dark) { document.documentElement.dataset.theme = 'dark' }</script>
</head>`)
    // Body kept literally (braces survive), and the directive is removed.
    assert.ok(
      r.serverCode.includes(
        "<script>if (dark) { document.documentElement.dataset.theme = 'dark' }</script>",
      ),
    )
    assert.ok(!r.serverCode.includes('is:inline'))
  })

  it('keeps an external <script src> as literal markup', () => {
    const r = compile(`<body>
  <main>x</main>
  <script src="/static/theme-init.js"></script>
</body>`)
    assert.ok(r.serverCode.includes('<script src="/static/theme-init.js">'))
  })
})
