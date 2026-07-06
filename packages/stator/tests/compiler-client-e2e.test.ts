// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as clientApi from '../src/client/index.ts'
import { compile } from '../src/compiler/compile.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import * as templateApi from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'

const CLIENT = `<quantity-stepper>
  <button on:click={dec}>-</button>
  <span bind:text={qty.lineTotal}></span>
  <button on:click={inc}>+</button>
</quantity-stepper>

<script>
  const Qty = machine({ count: 1, unitPrice: 0, on: { INC: s => s.count++, DEC: s => s.count = Math.max(1, s.count-1) }, select: { lineTotal: s => s.unitPrice * s.count } })
  export class QuantityStepper extends StatorElement {
    static attrs = { unitPrice: Number }
    qty = use(Qty, () => ({ unitPrice: this.attrs.unitPrice }))
    inc() { this.qty.send('INC') }
    dec() { this.qty.send('DEC') }
  }
</script>`

function runModule(code: string, api: Record<string, unknown>): any {
  const body = code
    .replace(/^import .*$/gm, '')
    .replace(/^\s*export default /m, 'return ')
    .replace(/^\s*export /gm, '')
  const names = Object.keys(api)
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => api[n]))
}

describe('compiler: client component end-to-end (3b stage 6a)', () => {
  it('server shell renders with the seed attr; client module hydrates and is reactive', () => {
    const { serverCode, clientCode } = compile(CLIENT, {
      id: 'quantity-stepper.stator',
    })

    // 1. Render the server shell with a unit-price prop, inside a render context.
    const render = runModule(serverCode, templateApi) as (p: any) => HtmlFragment
    const state = createRenderState('s1', 'GET /')
    const fragment = runInRender(state, () => render({ unitPrice: 98 }))
    const shell = fragment.html

    expect(shell).toContain('<quantity-stepper unit-price="98">')
    expect(shell).toContain('data-b="b1"') // the bound span marker

    // 2. Register the client element (the generated module, minus its import).
    const body = clientCode.replace(/^import .*$/gm, '').replace(/^\s*export /gm, '')
    const names = Object.keys(clientApi)
    // eslint-disable-next-line no-new-func
    new Function(...names, body)(...names.map((n) => (clientApi as any)[n]))

    // 3. Insert the server shell → the browser upgrades + connects the element.
    const holder = document.createElement('div')
    holder.innerHTML = shell
    document.body.appendChild(holder)
    const el = holder.querySelector('quantity-stepper')!
    const out = el.querySelector('[data-b="b1"]')!

    // Seed flowed server→client: lineTotal = unitPrice(98) * count(1) = 98.
    expect(out.textContent).toBe('98')

    // Reactive: inc → 196, dec → 98.
    const buttons = el.querySelectorAll('button')
    ;(buttons[1] as HTMLElement).click() // +  (inc)
    expect(out.textContent).toBe('196')
    ;(buttons[0] as HTMLElement).click() // -  (dec)
    expect(out.textContent).toBe('98')
  })
})

describe('server-rendered sections in island templates (the hydrate pattern)', () => {
  // Pinned as CONTRACT: island templates may contain server-evaluated
  // expressions — props-driven maps with nested JSX, even read() bindings.
  // The shell renders them per use; the class hydrates by querying.
  it('props-driven map with nested JSX lowers to nested html`` in the shell', () => {
    const src = `<opt-list>
  <div class="opts">{props.items.map((i) => <button class="opt" data-id={i}></button>)}</div>
</opt-list>
<script>
  export class OptList extends StatorElement {}
</script>`
    const r = compile(src, { id: 'opt-list.stator', kind: 'component' })
    expect(r.serverCode).toContain(
      'props.items.map((i) => html`<button class="opt" data-id="${i}"></button>`)',
    )
  })

  it('read() in an island template flows into the shell (live light-DOM binding)', () => {
    const src = `<live-note>
  <span class="n">{read(props.machine, (m) => m.count)}</span>
</live-note>
<script>
  export class LiveNote extends StatorElement {}
</script>`
    const r = compile(src, { id: 'live-note.stator', kind: 'component' })
    expect(r.serverCode).toContain('${read(props.machine, (m) => m.count)}')
  })
})

describe('fragment arrays splice in html``', () => {
  it('a mapped list of fragments renders each item (not [object Object])', async () => {
    const { html } = await import('../src/template/html.ts')
    const { createRenderState, runInRender } = await import('../src/server/render-context.ts')
    const state = createRenderState('splice', 'GET /probe')
    const out = runInRender(state, () => {
      const items = ['a', 'b']
      return html`<div class="opts">${items.map((i) => html`<button data-id="${i}">x</button>`)}</div>`
    })
    expect(out.html).toMatch(
      /<button[^>]*data-id="a">x<\/button><button[^>]*data-id="b">x<\/button>/,
    )
    expect(out.html).not.toContain('object Object')
  })
})
