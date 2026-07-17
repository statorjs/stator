// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
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
    expect(out.html).toContain(' hidden')
    expect(out.html).toContain('class="base-cls"')
    expect(out.html).toContain('data-kind="x"')
    expect(out.html).toContain('<span>hi</span>') // inner preserved
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
    expect(classes.split(/\s+/).sort()).toEqual(['active', 'tile'])
    expect(out.html.match(/class=/g)?.length).toBe(1) // exactly one class attr
  })
})
