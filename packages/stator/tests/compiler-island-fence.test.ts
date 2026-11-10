// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as clientApi from '../src/client/index.ts'
import { compile } from '../src/compiler/compile.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import * as templateApi from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'
import { jsOf } from './helpers/js-of.ts'

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
  const body = jsOf(serverCode)
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
    assert.equal(isClient, true)
    assert.ok(serverCode.includes("import { fenceGreeting } from './fence-lib.ts'"))
    assert.ok(serverCode.includes('const stock = 7'))
    // The <script> module never sees the fence.
    assert.ok(!clientCode.includes('fenceGreeting'))
    assert.ok(!clientCode.includes('stock'))
  })

  it('the shell renders fence bindings; hydration still wires the button', () => {
    const { serverCode, clientCode } = compile(FENCED, { id: 'fence-probe.stator' })
    const shell = renderShell(serverCode, { fenceGreeting: 'hello' })
    assert.ok(shell.includes('<p>hello!</p>'))
    assert.ok(shell.includes('7 left'))

    const body = jsOf(clientCode)
      .replace(/^import .*$/gm, '')
      .replace(/^\s*export /gm, '')
    const names = Object.keys(clientApi)
    // eslint-disable-next-line no-new-func
    new Function(...names, body)(...names.map((n) => (clientApi as Record<string, unknown>)[n]))
    const holder = document.createElement('div')
    holder.innerHTML = shell
    document.body.appendChild(holder)
    const el = holder.querySelector('fence-probe') as HTMLElement & { bought: boolean }
    ;(el.querySelector('button') as HTMLElement).click()
    assert.equal(el.bought, true)
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
    assert.ok(css.includes('rebeccapurple'))
    assert.ok(serverCode.includes('const stock = 7'))
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

  it("Stator.props in an island fence is the shell's props", () => {
    const src = `---
const { rows } = Stator.props<{ rows: string[] }>()
---
<row-list><ul>{rows.map((r) => <li>{r}</li>)}</ul></row-list>
<script>
  export class RowList extends StatorElement {
    static attrs = { unitPrice: Number }
  }
</script>`
    const { serverCode } = compile(src, { id: 'row-list.stator' })
    // Declared props are P plus the attrs, closed, and may be required.
    assert.match(
      serverCode,
      /export default function \(props: \(\{ rows: string\[\] \}\) & \{ unitPrice\?: number \| __SReadResult<number> \}\) \{/,
    )
    assert.ok(serverCode.includes('const { rows } = props'))
  })

  it('rejects Stator.reads in an island fence', () => {
    assert.throws(
      () => compile(island('const [m] = Stator.reads([X])'), { id: 'c.stator' }),
      /only available in a route/,
    )
  })

  it('rejects Stator.request and pragmas in an island fence', () => {
    assert.throws(() => compile(island('const u = Stator.request'), { id: 'c.stator' }), /route/)
    assert.throws(
      () => compile(island('// @stator live\nconst x = 1'), { id: 'c.stator' }),
      /only valid in a route/,
    )
  })
})

describe('island fences: what the <script> can see of the fence', () => {
  const island = (fence: string, body: string) => `---
${fence}
---
<type-probe><p>x</p></type-probe>
<script>
  export class TypeProbe extends StatorElement {
${body}
  }
</script>`
  const tail = (clientCode: string): string =>
    clientCode.slice(clientCode.indexOf('defineElement(__TypeProbeImpl'))

  it('fence types the script names are restated in the client module', () => {
    const { clientCode } = compile(
      island(
        "import type { Row, Unused } from './rows.ts'\n" +
          "import { type Cell, load } from './cells.ts'\n" +
          'type Pick = { row: Row }\ninterface Other { n: number }\nconst x = load()',
        '    last?: Pick\n    cell?: Cell',
      ),
      { id: 'type-probe.stator' },
    )
    const t = tail(clientCode)
    assert.ok(t.includes('type Pick = { row: Row }'))
    // Reached through `Pick`, and narrowed to the names in use.
    assert.ok(t.includes("import type { Row } from './rows.ts'"))
    assert.ok(t.includes("import type { Cell } from './cells.ts'"))
    assert.ok(!t.includes('Unused'))
    assert.ok(!t.includes('Other'))
    assert.ok(!t.includes('load'))
  })

  it("a type the script declares itself is the script's", () => {
    const { clientCode } = compile(
      island('type Pick = { a: 1 }', '    last?: Pick').replace(
        '<script>',
        '<script>\n  type Pick = { b: 2 }',
      ),
      { id: 'type-probe.stator' },
    )
    assert.ok(!tail(clientCode).includes('type Pick'))
  })

  it('a fence value used in the script is a located error', () => {
    const src = island(
      "import { catalog } from './catalog.ts'\nconst limit = 3",
      '    size() { return catalog.length + limit }',
    )
    assert.throws(
      () => compile(src, { id: 'type-probe.stator' }),
      (err: Error & { loc?: { line: number } }) => {
        assert.match(err.message, /"catalog" is bound in this island's fence.*runs on the server/)
        assert.equal(err.loc?.line, 8)
        return true
      },
    )
  })

  it("a name the script binds itself, or uses only as a member, is not the fence's", () => {
    const src = island(
      'const limit = 3\nconst size = 1',
      '    size = 2\n    over(limit: number) { return limit > this.size }',
    )
    assert.doesNotThrow(() => compile(src, { id: 'type-probe.stator' }))
  })

  it('this.attrs is typed from static attrs', () => {
    const { clientCode } = compile(
      island('const x = 1', '    static attrs = { unitPrice: Number }'),
      { id: 'type-probe.stator' },
    )
    assert.ok(
      tail(clientCode).includes(
        "export interface TypeProbe { get attrs(): import('@statorjs/stator/client').AttrsOf<typeof TypeProbe.attrs> }",
      ),
    )
    const none = compile(island('const x = 1', '    n = 1'), { id: 'type-probe.stator' })
    assert.ok(!none.clientCode.includes('export interface TypeProbe'))
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
    assert.throws(
      () => compile(src, { id: 'clash-probe.stator' }),
      /both a fence binding and a use\(\) field/,
    )
  })
})
