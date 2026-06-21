import { describe, it, expect } from 'vitest'
import { lowerTemplate, type LowerMeta } from '../src/compiler/lower.ts'
import { compile } from '../src/compiler/compile.ts'

function meta(): LowerMeta {
  return { usesChildren: false, regions: new Set(), components: new Set(), customElements: new Set() }
}

describe('compiler: children (stage 2)', () => {
  it('lowers <children/> to the default bag entry', () => {
    const m = meta()
    expect(lowerTemplate('<main><children/></main>', { meta: m })).toBe(
      "html`<main>${props.children?.default ?? ''}</main>`",
    )
    expect(m.usesChildren).toBe(true)
  })

  it('lowers <children name="x"/> to the named bag entry and records the region', () => {
    const m = meta()
    expect(lowerTemplate('<header><children name="banner"/></header>', { meta: m })).toBe(
      "html`<header>${props.children?.banner ?? ''}</header>`",
    )
    expect([...m.regions]).toEqual(['banner'])
  })

  it('routes child="x" caller content into the named bag, default otherwise', () => {
    const out = lowerTemplate(
      '<Layout><div child="banner">Sale</div><p>body</p></Layout>',
    )
    expect(out).toBe(
      'html`${Layout({ children: { default: html`<p>body</p>`, "banner": html`<div>Sale</div>` } })}`',
    )
  })

  it('strips the child marker attribute from rendered output', () => {
    // child="x" must not appear as a literal HTML attribute
    const out = lowerTemplate('<Layout><span child="banner" class="x">hi</span></Layout>')
    expect(out).toContain('<span class="x">hi</span>')
    expect(out).not.toContain('child="banner"')
  })

  it('compile() adds a props param when the body uses <children> (no declared props)', () => {
    const { serverCode } = compile('<main><children/></main>')
    expect(serverCode).toContain('export default function (props: { children?: any }) {')
    expect(serverCode).toContain("props.children?.default ?? ''")
  })

  it('compile() intersects children into declared props', () => {
    const src = `---
import type { InstanceOf } from '@statorjs/stator/template'
const { items } = Stator.props<{ items: string[] }>()
---
<ul><children/></ul>`
    const { serverCode } = compile(src)
    expect(serverCode).toContain('props: { items: string[] } & { children?: any }')
  })

  it('does not add a props param when there are no children and no props', () => {
    const { serverCode } = compile('<p>static</p>')
    expect(serverCode).toContain('export default function () {')
  })
})
