// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as clientApi from '../src/client/index.ts'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import * as templateApi from '../src/template/index.ts'
import type { HtmlFragment } from '../src/template/types.ts'
import { jsOf } from './helpers/js-of.ts'

/**
 * Client-lowered `read()` — the bind:-as-display fold (reactive-model spec,
 * Minor B). A `read(clientMachine, sel)` in an island lowers to client codegen:
 * text position → an `<!--sN-->` comment slot + `bindSlot`; attribute position
 * → the element-marker `bind` machinery. Server-machine reads keep flowing to
 * the shell (the pinned hydrate contract).
 */

const ISLAND = `<count-badge>
  <p class="line">Items: {read(qty, (q) => q.count)} total</p>
  <button on:click={inc} disabled={read(qty, (q) => q.atMax)}>+</button>
</count-badge>

<script>
  const Qty = machine({ count: 1 }, {
    on: { INC: (s) => { s.count++ } },
    select: { atMax: (s) => s.count >= 3 },
  })
  export class CountBadge extends StatorElement {
    qty = use(Qty)
    inc() { this.qty.send('INC') }
  }
</script>`

function loadClient(clientCode: string): void {
  const body = jsOf(clientCode)
    .replace(/^import .*$/gm, '')
    .replace(/^\s*export /gm, '')
  const names = Object.keys(clientApi)
  // eslint-disable-next-line no-new-func
  new Function(...names, body)(...names.map((n) => (clientApi as Record<string, unknown>)[n]))
}

function renderShell(serverCode: string, props: object = {}): string {
  const body = jsOf(serverCode)
    .replace(/^import .*$/gm, '')
    .replace(/^\s*export default /m, 'return ')
    .replace(/^\s*export /gm, '')
  const names = Object.keys(templateApi)
  // eslint-disable-next-line no-new-func
  const render = new Function(...names, body)(
    ...names.map((n) => (templateApi as Record<string, unknown>)[n]),
  ) as (p: object) => HtmlFragment
  const state = createRenderState('s1', 'GET /')
  return runInRender(state, () => render(props)).html
}

describe('client read() lowering: compile output', () => {
  it('text position → comment slot in the shell + bindSlot in the client module', () => {
    const { serverCode, clientCode } = compile(ISLAND, { id: 'count-badge.stator' })
    const shell = renderShell(serverCode)
    assert.ok(shell.includes('Items: <!--s0--> total'))
    // The dangling identifier never reaches the shell.
    assert.ok(!serverCode.includes('(q) => q.count)(qty)'))
    assert.ok(
      clientCode.includes(
        'this.track(bindSlot(this, "s0", [this.qty], () => (((q) => q.count)(this.qty))))',
      ),
    )
  })

  it('attribute position → element marker + bind directive, stripped from the shell', () => {
    const { serverCode, clientCode } = compile(ISLAND, { id: 'count-badge.stator' })
    const shell = renderShell(serverCode)
    assert.match(shell, /<button data-b="b0">\+<\/button>/)
    assert.ok(!shell.includes('disabled'))
    assert.ok(clientCode.includes('bind([this.qty], () => (((q) => q.atMax)(this.qty))'))
  })

  it('server-machine read() via props still flows to the shell (hydrate contract)', () => {
    const src = `<live-note>
  <span class="n">{read(props.machine, (m) => m.count)}</span>
</live-note>
<script>
  export class LiveNote extends StatorElement {}
</script>`
    const r = compile(src, { id: 'live-note.stator', kind: 'component' })
    assert.ok(r.serverCode.includes('${read(props.machine, (m) => m.count)}'))
  })

  it('value=/checked= on a client machine is a compile error with guidance', () => {
    const src = `<draft-input>
  <input value={read(draft, (d) => d.text)} />
</draft-input>
<script>
  const Draft = machine({ text: '' })
  export class DraftInput extends StatorElement {
    draft = use(Draft)
  }
</script>`
    assert.throws(() => compile(src, { id: 'draft-input.stator' }), CompileError)
    assert.throws(
      () => compile(src, { id: 'draft-input.stator' }),
      /can't live-drive value=.*pre-fill.*ref:/i,
    )
  })

  it('a client read embedded in a larger shell expression is a located error', () => {
    const src = `<count-badge>
  <p>{'total: ' + read(qty, (q) => q.count)}</p>
</count-badge>
<script>
  const Qty = machine({ count: 1 }, { on: { INC: (s) => { s.count++ } } })
  export class CountBadge extends StatorElement {
    qty = use(Qty)
  }
</script>`
    assert.throws(() => compile(src, { id: 'count-badge.stator' }), /entire expression/)
  })
})

describe('client read() lowering: end-to-end (happy-dom)', () => {
  it('slot paints at setup, updates on send; attr binding tracks state', () => {
    const { serverCode, clientCode } = compile(ISLAND, { id: 'count-badge.stator' })
    loadClient(clientCode)

    const holder = document.createElement('div')
    holder.innerHTML = renderShell(serverCode)
    document.body.appendChild(holder)
    const el = holder.querySelector('count-badge') as HTMLElement
    const line = el.querySelector('.line') as HTMLElement
    const btn = el.querySelector('button') as HTMLButtonElement

    // Initial paint at element setup — mixed content intact around the slot.
    assert.equal(line.textContent, 'Items: 1 total')
    assert.equal(btn.disabled, false)

    btn.click()
    assert.equal(line.textContent, 'Items: 2 total')
    btn.click()
    assert.equal(line.textContent, 'Items: 3 total')
    assert.equal(btn.disabled, true) // atMax
    document.body.removeChild(holder)
  })

  it('a marker repeated by a props .map() wires EVERY occurrence (row-0 fix)', () => {
    const src = `<pick-one>
  <span class="who">{read(sel, (s) => s.id)}</span>
  <div>{props.ids.map((i) => <button on:click={pick} data-id={i}></button>)}</div>
</pick-one>
<script>
  const Sel = machine({ id: 'none' }, {
    on: { PICK: (s, e) => { s.id = String(e.id) } },
  })
  export class PickOne extends StatorElement {
    sel = use(Sel)
    pick(e) { this.sel.send({ type: 'PICK', id: e.currentTarget.dataset.id }) }
  }
</script>`
    const { serverCode, clientCode } = compile(src, { id: 'pick-one.stator' })
    loadClient(clientCode)

    const holder = document.createElement('div')
    holder.innerHTML = renderShell(serverCode, { ids: ['a', 'b'] })
    document.body.appendChild(holder)
    const el = holder.querySelector('pick-one') as HTMLElement
    const who = el.querySelector('.who') as HTMLElement
    const buttons = el.querySelectorAll('button')
    assert.equal(buttons.length, 2)

    ;(buttons[1] as HTMLElement).click() // the SECOND occurrence — dead before the fix
    assert.equal(who.textContent, 'b')
    ;(buttons[0] as HTMLElement).click()
    assert.equal(who.textContent, 'a')
    document.body.removeChild(holder)
  })
})

const FALLBACK = `<fall-back>
  <p class="line">Cart ({read(cart, (c) => c.count, props.start)} items)</p>
  <p class="empty" hidden={read(cart, (c) => c.count > 0, props.start > 0)}>Nothing yet</p>
  <button on:click={add} aria-label={read(cart, (c) => c.label, 'Add <one>')}>+</button>
</fall-back>

<script>
  const Cart = machine({ count: 5 }, {
    on: { ADD: (s) => { s.count++ } },
    select: { label: (s) => 'Add (' + s.count + ')' },
  })
  export class FallBack extends StatorElement {
    static attrs = { start: Number }
    cart = use(Cart)
    add() { this.cart.send('ADD') }
  }
</script>`

describe('client read() fallback: what the shell shows before the island connects', () => {
  it('text position renders the fallback, escaped, between the slot comments', () => {
    const { serverCode, clientCode } = compile(FALLBACK, { id: 'fall-back.stator' })
    const shell = renderShell(serverCode, { start: 2 })
    assert.ok(shell.includes('Cart (<!--s0-->2<!--/s0--> items)'))
    // The fallback is shell-only: the client thunk is the selector alone.
    assert.ok(clientCode.includes('() => (((c) => c.count)(this.cart))'))
    assert.ok(!clientCode.includes('props.start'))
  })

  it('attribute position renders the fallback as the attribute, under the attr contract', () => {
    const { serverCode } = compile(FALLBACK, { id: 'fall-back.stator' })
    const some = renderShell(serverCode, { start: 2 })
    assert.match(some, /<p [^>]*class="empty" hidden="" data-b="b0">/)
    assert.ok(some.includes('aria-label="Add &lt;one&gt;"'))
    const none = renderShell(serverCode, { start: 0 })
    assert.match(none, /<p [^>]*class="empty" +data-b="b0">/) // false → attribute absent
  })

  it('a read without a fallback is unchanged', () => {
    const { serverCode } = compile(ISLAND, { id: 'count-badge.stator' })
    assert.ok(!renderShell(serverCode).includes('<!--/s0-->'))
  })

  it('on connect the read replaces the fallback, then tracks state', () => {
    const { serverCode, clientCode } = compile(FALLBACK, { id: 'fall-back.stator' })
    const html = renderShell(serverCode, { start: 0 })
    const before = document.createElement('div')
    before.innerHTML = html.replaceAll('fall-back', 'not-upgraded')
    assert.equal(before.querySelector('.line')?.textContent, 'Cart (0 items)')

    loadClient(clientCode)
    const holder = document.createElement('div')
    holder.innerHTML = html
    document.body.appendChild(holder)
    const line = holder.querySelector('.line') as HTMLElement
    const empty = holder.querySelector('.empty') as HTMLElement
    const btn = holder.querySelector('button') as HTMLButtonElement

    assert.equal(line.textContent, 'Cart (5 items)')
    assert.equal(empty.hidden, true)
    assert.equal(btn.getAttribute('aria-label'), 'Add (5)')
    btn.click()
    assert.equal(line.textContent, 'Cart (6 items)')
    assert.equal(btn.getAttribute('aria-label'), 'Add (6)')
    document.body.removeChild(holder)
  })

  it('a fallback cannot itself read a client machine', () => {
    const src = FALLBACK.replace("'Add <one>'", 'read(cart, (c) => c.label)')
    assert.throws(() => compile(src, { id: 'fall-back.stator' }), /entire expression/)
  })
})
