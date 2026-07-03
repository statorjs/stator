import { describe, expect, it } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { classList, each, html, match, on, read, styleList, when } from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/**
 * End-to-end children composition through the real runtime: a compiled layout
 * (with default + named `<children>`) invoked by a compiled caller must splice
 * the caller's children into the right regions and produce the expected HTML.
 */

const scope = { html, read, each, when, match, on, classList, styleList }

function evalComponent(template: string): (props?: any) => HtmlFragment {
  const expr = lowerTemplate(template) // returns the html`` expression
  const names = Object.keys(scope)
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, 'props', `return (${expr})`)
  return (props?: any) => fn(...names.map((n) => (scope as any)[n]), props ?? {}) as HtmlFragment
}

describe('compiler: children compose through the runtime', () => {
  it('splices default and named children into the right regions', () => {
    // The layout component (callee).
    const Layout = evalComponent(
      '<div class="layout"><header><children name="banner"/></header><main><children/></main></div>',
    )
    // Make Layout visible to the caller's compiled code.
    ;(scope as any).Layout = Layout

    // The caller invokes <Layout> with a banner child + default content.
    const callerExpr = lowerTemplate(
      '<Layout><span child="banner">Sale!</span><p>Body content</p></Layout>',
    )
    const names = Object.keys(scope)
    // eslint-disable-next-line no-new-func
    const callerFn = new Function(...names, `return (${callerExpr})`)

    const state = createRenderState('s1', 'GET /')
    const out = runInRender(
      state,
      () => callerFn(...names.map((n) => (scope as any)[n])) as HtmlFragment,
    )

    expect(out.html).toBe(
      '<div class="layout"><header><span>Sale!</span></header><main><p>Body content</p></main></div>',
    )

    delete (scope as any).Layout
  })

  it('renders nothing for an unfilled named region', () => {
    const Card = evalComponent('<div><children name="title"/><children/></div>')
    ;(scope as any).Card = Card
    const callerExpr = lowerTemplate('<Card><p>just body</p></Card>')
    const names = Object.keys(scope)
    // eslint-disable-next-line no-new-func
    const callerFn = new Function(...names, `return (${callerExpr})`)
    const state = createRenderState('s1', 'GET /')
    const out = runInRender(
      state,
      () => callerFn(...names.map((n) => (scope as any)[n])) as HtmlFragment,
    )
    expect(out.html).toBe('<div><p>just body</p></div>')
    delete (scope as any).Card
  })
})
