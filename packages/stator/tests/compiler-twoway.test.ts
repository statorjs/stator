// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import * as clientApi from '../src/client/index.ts'

const SEARCH = `<search-box>
  <input bind:value={draft.query} />
  <p bind:text={draft.echo}></p>
</search-box>

<script>
  const Draft = machine({ query: '', select: { echo: s => 'You typed: ' + s.query } })
  export class SearchBox extends StatorElement {
    draft = use(Draft)
  }
</script>`

describe('compiler: two-way bind:value (3b stage 6b)', () => {
  it('emits a state→DOM bind plus a DOM→state @set listener', () => {
    const { clientCode } = compile(SEARCH, { id: 'search-box.stator' })
    // state → DOM (loop-broken value writer)
    expect(clientCode).toContain('bind([this.draft], () => (this.draft.query)')
    expect(clientCode).toContain('.value !== s')
    // DOM → state (@set on input, IME-guarded)
    expect(clientCode).toContain('addEventListener("input"')
    expect(clientCode).toContain("if (e.isComposing) return")
    expect(clientCode).toContain(`send({ type: '@set', key: "query", value:`)
  })

  it('errors when bind:value targets a non-settable (multi-part) path', () => {
    const bad = `<my-field><input bind:value={draft.form.q} /></my-field>
<script>
  const Draft = machine({ form: {} })
  export class MyField extends StatorElement { draft = use(Draft) }
</script>`
    expect(() => compile(bad)).toThrow(/settable context path/)
  })

  it('two-way binding works end-to-end: typing updates state and the bound display', () => {
    const { serverCode, clientCode } = compile(SEARCH, { id: 'search-box.stator' })
    void serverCode

    const body = clientCode.replace(/^import .*$/gm, '').replace(/^\s*export /gm, '')
    const names = Object.keys(clientApi)
    // eslint-disable-next-line no-new-func
    new Function(...names, body)(...names.map((n) => (clientApi as any)[n]))

    const holder = document.createElement('div')
    holder.innerHTML = '<search-box><input data-b="b0" /><p data-b="b1"></p></search-box>'
    document.body.appendChild(holder)
    const el = holder.querySelector('search-box')!
    const input = el.querySelector('input') as HTMLInputElement
    const echo = el.querySelector('p')!

    expect(echo.textContent).toBe('You typed: ') // initial

    // Type → input event → @set query → echo selector recomputes.
    input.value = 'wool'
    input.dispatchEvent(new Event('input'))
    expect(echo.textContent).toBe('You typed: wool')
  })
})
