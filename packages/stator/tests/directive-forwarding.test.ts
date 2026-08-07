import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import {
  createEventDescriptor,
  createRenderState,
  runInRender,
} from '../src/server/render-context.ts'
import { on } from '../src/template/directives/on.ts'
import { html } from '../src/template/html.ts'

/**
 * `on:click` forwarding to a component. The parent packs component-level
 * directives into a reserved `$directives` prop (see lower.ts); the component
 * reads one back with `Stator.forwarded('on:click')` and re-attaches it to a
 * chosen inner element — so the author, not the framework, decides placement.
 * A forwarded handler that's absent renders no binding (on() tolerates it).
 */

describe('directive forwarding — compile', () => {
  it("Stator.forwarded('on:click') → props.$directives?.['on:click']", () => {
    const src = `---
const onClick = Stator.forwarded('on:click')
---
<button on:click={onClick}>go</button>`
    const { serverCode } = compile(src)
    expect(serverCode).toContain("const onClick = props.$directives?.['on:click']")
  })

  it('Stator.forwarded() is an error in a route (no parent to forward from)', () => {
    const src = `---
const onClick = Stator.forwarded('on:click')
const [x] = Stator.reads([])
---
<button on:click={onClick}>go</button>`
    expect(() => compile(src, { kind: 'route' })).toThrow(/only available in a component/)
  })
})

describe('directive forwarding — runtime', () => {
  // Simulates a compiled forwarding component: props.$directives carries the
  // parent's handler; the author placed on:click on a chosen inner element.
  it('a forwarded handler wires data-event-click on the author-chosen element', () => {
    const state = createRenderState('fwd', 'GET /x')
    const out = runInRender(state, () => {
      const props: { $directives?: Record<string, () => unknown> } = {
        $directives: { 'on:click': () => createEventDescriptor('CartMachine', { type: 'BACK' }) },
      }
      const onClick = props.$directives?.['on:click']
      return html`<div class="wrap"><button ${on('click', onClick)}>Back</button></div>`
    })
    expect(out.html).toContain('data-event-click')
    expect(out.html).toContain('BACK')
  })

  it('an absent forwarded handler renders no binding and does not throw', () => {
    const state = createRenderState('fwd-absent', 'GET /x')
    const out = runInRender(state, () => {
      const props: { $directives?: Record<string, () => unknown> } = {} // caller passed no on:click
      const onClick = props.$directives?.['on:click']
      return html`<button ${on('click', onClick)}>go</button>`
    })
    expect(out.html).not.toContain('data-event')
    expect(out.html).toContain('<button')
  })
})
