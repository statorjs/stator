// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import * as templateApi from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/**
 * Regression for FINDINGS #4 (spec: attribute-composition-on-an-element-is-
 * drop-not-merge). A client component (island) is split into {tag, inner} and
 * reassembled at the use site — `extractClientRoot` must carry the root's own
 * static attributes across, or a component can't give itself a base class,
 * `hidden`, ARIA, or `data-*`. The reassembly merges: definition-root attrs are
 * the base, usage-site props win on scalar conflict, class/style concatenate.
 */

function runModule(code: string, api: Record<string, unknown>): unknown {
  const body = code
    .replace(/^import .*$/gm, '')
    .replace(/^\s*export default /m, 'return ')
    .replace(/^\s*export /gm, '')
  const names = Object.keys(api)
  return new Function(...names, body)(...names.map((n) => api[n]))
}

const render = (src: string, id: string) => {
  const { serverCode } = compile(src, { id, kind: 'component' })
  return runModule(serverCode, templateApi) as (p: Record<string, unknown>) => HtmlFragment
}

describe('client component root static attributes (FINDINGS #4)', () => {
  it("keeps the root's own static attributes (class, boolean, data-*)", () => {
    const ISLAND = `<my-widget hidden class="base-cls" data-kind="x"><span>hi</span></my-widget>

<script>
  export class MyWidget extends StatorElement {}
</script>`
    const state = createRenderState('s', 'GET /')
    const out = runInRender(state, () => render(ISLAND, 'my-widget.stator')({}))
    assert.ok(out.html.includes(' hidden'))
    assert.ok(out.html.includes('class="base-cls"'))
    assert.ok(out.html.includes('data-kind="x"'))
    assert.ok(out.html.includes('<span>hi</span>')) // inner preserved
  })

  it('concatenates class from the root with a usage-site class prop', () => {
    const ISLAND = `<my-tile class="tile"></my-tile>

<script>
  export class MyTile extends StatorElement {
    static attrs = { class: String }
  }
</script>`
    const state = createRenderState('s', 'GET /')
    const out = runInRender(state, () => render(ISLAND, 'my-tile.stator')({ class: 'active' }))
    // One class attribute containing both (base first, usage appended).
    const classes = out.html.match(/class="([^"]*)"/)?.[1] ?? ''
    assert.deepStrictEqual(classes.split(/\s+/).sort(), ['active', 'tile'])
    assert.equal(out.html.match(/class=/g)?.length, 1) // exactly one class attr
  })
})

describe('island root attributes: dynamic values are a located error, not a silent drop', () => {
  it('an expression-valued attribute on the root is rejected with the attribute located', () => {
    const ISLAND = `---
const mode = 'full'
---
<markdown-editor data-mode={mode}>
  <div class="host"></div>
</markdown-editor>

<script>
  export class MarkdownEditor extends StatorElement {}
</script>`
    try {
      compile(ISLAND, { id: 'markdown-editor.stator', kind: 'component' })
      throw new Error('expected throw')
    } catch (e) {
      assert.ok(e instanceof CompileError)
      const err = e as CompileError
      assert.ok(err.message.includes('<markdown-editor data-mode={mode}>'))
      assert.ok(err.message.includes("attributes on an island's root must be static"))
      assert.equal(err.loc?.line, 4)
      assert.equal(err.loc?.column, 18)
    }
  })

  it('a spread on the root is rejected too', () => {
    const ISLAND = `<my-box {...props}></my-box>

<script>
  export class MyBox extends StatorElement {}
</script>`
    assert.throws(
      () => compile(ISLAND, { id: 'my-box.stator', kind: 'component' }),
      /must be static/,
    )
  })
})
