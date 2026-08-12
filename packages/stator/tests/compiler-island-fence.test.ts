// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as clientApi from '../src/client/index.ts'
import { compile } from '../src/compiler/compile.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import * as templateApi from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/**
 * Island server fences (2.1): the `---` fence in an island file runs per
 * shell render, server only, with its bindings in template scope — and the
 * <script> never sees it. Pure error relaxation over the 2.0.1 diagnostic.
 */

const FENCED = `---
import { fenceGreeting } from './fence-lib.ts'
const stock = 7
const label = fenceGreeting + '!'
---
<fence-probe>
  <p>{label}</p>
  <span>{stock} left</span>
  <button on:click={buy}>buy</button>
</fence-probe>

<script>
  export class FenceProbe extends StatorElement {
    bought = false
    buy() { this.bought = true }
  }
</script>`

function renderShell(serverCode: string, extraApi: Record<string, unknown> = {}): string {
  const body = serverCode
    .replace(/^import .*$/gm, '')
    .replace(/^\s*export default /m, 'return ')
    .replace(/^\s*export /gm, '')
  const api = { ...templateApi, ...extraApi } as Record<string, unknown>
  const names = Object.keys(api)
  // eslint-disable-next-line no-new-func
  const render = new Function(...names, body)(...names.map((n) => api[n])) as (
    p: object,
  ) => HtmlFragment
  const state = createRenderState('s1', 'GET /')
  return runInRender(state, () => render({})).html
}

describe('island fences: emission', () => {
  it('hoists fence imports and runs the body inside the shell render', () => {
    const { serverCode, clientCode, isClient } = compile(FENCED, { id: 'fence-probe.stator' })
    expect(isClient).toBe(true)
    expect(serverCode).toContain("import { fenceGreeting } from './fence-lib.ts'")
    expect(serverCode).toContain('const stock = 7')
    // The <script> module never sees the fence.
    expect(clientCode).not.toContain('fenceGreeting')
    expect(clientCode).not.toContain('stock')
  })

  it('the shell renders fence bindings; hydration still wires the button', () => {
    const { serverCode, clientCode } = compile(FENCED, { id: 'fence-probe.stator' })
    const shell = renderShell(serverCode, { fenceGreeting: 'hello' })
    expect(shell).toContain('<p>hello!</p>')
    expect(shell).toContain('7 left')

    const body = clientCode.replace(/^import .*$/gm, '').replace(/^\s*export /gm, '')
    const names = Object.keys(clientApi)
    // eslint-disable-next-line no-new-func
    new Function(...names, body)(...names.map((n) => (clientApi as Record<string, unknown>)[n]))
    const holder = document.createElement('div')
    holder.innerHTML = shell
    document.body.appendChild(holder)
    const el = holder.querySelector('fence-probe') as HTMLElement & { bought: boolean }
    ;(el.querySelector('button') as HTMLElement).click()
    expect(el.bought).toBe(true)
    document.body.removeChild(holder)
  })
})

describe('island fences: region ordering', () => {
  it('fence + <style> + <script> coexist regardless of style placement', () => {
    const styled = FENCED.replace(
      '<script>',
      '<style>\n  p { color: rebeccapurple; }\n</style>\n\n<script>',
    )
    const { serverCode, css } = compile(styled, { id: 'fence-probe.stator' })
    expect(css).toContain('rebeccapurple')
    expect(serverCode).toContain('const stock = 7')
  })
})

describe('island fences: capability row', () => {
  const island = (fence: string) => `---
${fence}
---
<cap-probe><p>x</p></cap-probe>
<script>
  export class CapProbe extends StatorElement {}
</script>`

  it('rejects Stator.props in an island fence', () => {
    expect(() =>
      compile(island('const p = Stator.props<{ a: string }>()'), { id: 'c.stator' }),
    ).toThrow(/static attrs/)
  })

  it('rejects Stator.reads in an island fence', () => {
    expect(() => compile(island('const [m] = Stator.reads([X])'), { id: 'c.stator' })).toThrow(
      /only available in a route/,
    )
  })

  it('rejects Stator.request and pragmas in an island fence', () => {
    expect(() => compile(island('const u = Stator.request'), { id: 'c.stator' })).toThrow(/route/)
    expect(() => compile(island('// @stator live\nconst x = 1'), { id: 'c.stator' })).toThrow(
      /only valid in a route/,
    )
  })
})

describe('island fences: collisions', () => {
  it('a fence binding sharing a use() field name is a located error', () => {
    const src = `---
const theme = 'from the fence'
---
<clash-probe>
  <p>{theme}</p>
</clash-probe>
<script>
  const T = machine({ mode: 'light' }, { on: { TOGGLE: (s) => { s.mode = 'dark' } } })
  export class ClashProbe extends StatorElement {
    theme = use(T)
  }
</script>`
    expect(() => compile(src, { id: 'clash-probe.stator' })).toThrow(
      /both a fence binding and a use\(\) field/,
    )
  })
})
