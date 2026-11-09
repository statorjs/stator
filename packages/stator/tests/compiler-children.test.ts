import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile } from '../src/compiler/compile.ts'
import { type LowerMeta, lowerTemplate } from '../src/compiler/lower.ts'

function meta(): LowerMeta {
  return {
    usesChildren: false,
    regions: new Set(),
    components: new Set(),
    customElements: new Set(),
    refs: new Set(),
  }
}

describe('compiler: children (stage 2)', () => {
  it('lowers <children/> to the default bag entry', () => {
    const m = meta()
    assert.equal(
      lowerTemplate('<main><children/></main>', { meta: m }),
      "html`<main>${props.children?.default ?? ''}</main>`",
    )
    assert.equal(m.usesChildren, true)
  })

  it('lowers <children name="x"/> to the named bag entry and records the region', () => {
    const m = meta()
    assert.equal(
      lowerTemplate('<header><children name="banner"/></header>', { meta: m }),
      "html`<header>${props.children?.banner ?? ''}</header>`",
    )
    assert.deepStrictEqual([...m.regions], ['banner'])
  })

  it('routes child="x" caller content into the named bag, default otherwise', () => {
    const out = lowerTemplate('<Layout><div child="banner">Sale</div><p>body</p></Layout>')
    assert.equal(
      out,
      'html`${Layout({ children: { default: html`<p>body</p>`, "banner": html`<div>Sale</div>` } })}`',
    )
  })

  it('strips the child marker attribute from rendered output', () => {
    // child="x" must not appear as a literal HTML attribute
    const out = lowerTemplate('<Layout><span child="banner" class="x">hi</span></Layout>')
    assert.ok(out.includes('<span class="x">hi</span>'))
    assert.ok(!out.includes('child="banner"'))
  })

  it('compile() adds a props param when the body uses <children> (no declared props)', () => {
    const { serverCode } = compile('<main><children/></main>')
    assert.ok(serverCode.includes('export default function (props: { children?: any }) {'))
    assert.ok(serverCode.includes("props.children?.default ?? ''"))
  })

  it('compile() intersects children into declared props', () => {
    const src = `---
import type { InstanceOf } from '@statorjs/stator/template'
const { items } = Stator.props<{ items: string[] }>()
---
<ul><children/></ul>`
    const { serverCode } = compile(src)
    assert.ok(serverCode.includes('props: { items: string[] } & { children?: any }'))
  })

  it('takes an optional, empty props param when there are no children and no props', () => {
    const { serverCode } = compile('<p>static</p>')
    assert.ok(serverCode.includes('export default function (_props: Record<string, never> = {}) {'))
  })
})
